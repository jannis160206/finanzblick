import { mkdir, open, lstat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isAccountMode } from "@/lib/server/config";
import { AccountError, isSqliteContentionError } from "@/lib/server/errors";
import {
  accountErrorResponse,
  jsonResponse,
  requestSessionToken,
  requireMutationOrigin,
} from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";
import { AutomationStore } from "./store";
import { MAX_UPLOAD_BYTES, statementUploadResponseSchema } from "./schema";

function isFileRemovalError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error &&
    "syscall" in error && error.syscall === "unlink" &&
    "errno" in error && typeof error.errno === "number" && Number.isSafeInteger(error.errno) &&
    "code" in error && typeof error.code === "string" &&
    ["ENOENT", "EACCES", "EPERM", "EBUSY", "EIO", "EROFS", "ENOTDIR", "EISDIR"].includes(error.code);
}

async function authorized(request: Request, stream = false) {
  if (!isAccountMode())
    throw new AccountError(404, "Serverimports benötigen ein Benutzerkonto.");
  const runtime = await getAccountRuntime();
  const token = requestSessionToken(request);
  const user = runtime.database.currentUser(token);
  if (!user) throw new AccountError(401, "Bitte anmelden.");
  const account = stream
    ? new URL(request.url).searchParams.get("account")
    : request.headers.get("X-Finanzblick-Account");
  if (account !== user.id)
    throw new AccountError(
      401,
      "Das Konto hat sich geändert. Bitte neu laden.",
    );
  return {
    ...runtime,
    user,
    token,
    store: new AutomationStore(runtime.database),
  };
}

export async function uploadStatement(request: Request): Promise<Response> {
  try {
    const { config, database, user, token, store } = await authorized(request);
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`statement:upload:${user.id}`, 30, 60_000);
    if (request.headers.get("content-type") !== "application/octet-stream")
      throw new AccountError(415, "Kontoauszüge als Binärdatei senden.");
    const rawSize = request.headers.get("X-Upload-Size") ?? "";
    if (
      !/^\d+$/.test(rawSize) ||
      Number(rawSize) > MAX_UPLOAD_BYTES ||
      Number(rawSize) < 1
    )
      throw new AccountError(
        413,
        "Ein Kontoauszug darf höchstens 20 MiB groß sein.",
      );
    const size = Number(rawSize);
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) !== size)
      throw new AccountError(400, "Die Uploadgröße stimmt nicht überein.");
    if (!request.body)
      throw new AccountError(400, "Eine Datei ist erforderlich.");
    const name = new URL(request.url).searchParams.get("name") ?? "";
    const requestedId = request.headers.get("X-Upload-Id");
    const parsedId = statementUploadResponseSchema.safeParse({
      id: requestedId ?? randomUUID(),
    });
    if (!parsedId.success)
      throw new AccountError(400, "Ungültige Upload-ID.");
    const { id } = parsedId.data;
    store.reserveUpload(user.id, id, name, size);
    const path = store.filePath(id);
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if ((await lstat(dirname(path))).isSymbolicLink())
        throw new Error("Upload directory must not be a symlink");
      const file = await open(path, "wx", 0o600);
      const reader = request.body.getReader();
      const timeout = setTimeout(() => {
        void reader.cancel("Upload timeout");
      }, 60_000);
      let received = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          received += chunk.value.byteLength;
          if (received > size) {
            await reader.cancel();
            throw new AccountError(
              413,
              "Die Datei ist größer als angekündigt.",
            );
          }
          await file.writeFile(chunk.value);
        }
        if (request.signal.aborted || received !== size)
          throw new AccountError(
            400,
            "Der Upload wurde nicht vollständig übertragen.",
          );
        await file.sync();
      } finally {
        clearTimeout(timeout);
        reader.releaseLock();
        await file.close();
      }
      if (database.currentUser(token)?.id !== user.id)
        throw new AccountError(401, "Bitte erneut anmelden.");
      store.readyUpload(user.id, id);
    } catch (error) {
      try {
        // Never remove a payload unless the reservation is confirmed failed.
        if (store.failUpload(user.id, id)) {
          try {
            await unlink(path);
          } catch (cleanupError) {
            if (!isFileRemovalError(cleanupError) || cleanupError.code !== "ENOENT")
              throw cleanupError;
          }
          store.cleaned(id);
        }
      } catch (cleanupError) {
        // Preserve the upload diagnosis; secondary failures get fixed, private-safe log categories.
        if (isSqliteContentionError(cleanupError))
          console.error("Upload cleanup deferred: database temporarily busy.");
        else if (isFileRemovalError(cleanupError))
          console.error("Upload cleanup deferred: file removal unavailable.");
        else
          console.error("Unexpected upload cleanup failure.");
      }
      throw error;
    }
    return jsonResponse({ id }, 202);
  } catch (error) {
    return accountErrorResponse(error);
  }
}

const streamGlobal = globalThis as typeof globalThis & {
  finanzblickAutomationStreams?: Map<string, number>;
};

export async function statementEvents(request: Request): Promise<Response> {
  try {
    const { database, user, token, store } = await authorized(request, true);
    const counts = (streamGlobal.finanzblickAutomationStreams ??= new Map());
    const key = `${database.path}:${user.id}`;
    if ((counts.get(key) ?? 0) >= 5)
      throw new AccountError(429, "Zu viele Echtzeit-Verbindungen.");
    counts.set(key, (counts.get(key) ?? 0) + 1);
    let stop: () => void = () => {};
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let previous = "";
        let lastHeartbeat = Date.now();
        stop = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          request.signal.removeEventListener("abort", stop);
          const count = (counts.get(key) ?? 1) - 1;
          if (count) counts.set(key, count);
          else counts.delete(key);
          if (!cancelled) controller.close();
        };
        const tick = () => {
          if (closed) return;
          if (controller.desiredSize !== null && controller.desiredSize < 0) {
            stop();
            return;
          }
          try {
            if (database.currentUser(token)?.id !== user.id) {
              controller.enqueue(
                encoder.encode("event: unauthorized\ndata: {}\n\n"),
              );
              stop();
              return;
            }
            const payload = JSON.stringify(store.snapshot(user.id));
            if (payload !== previous) {
              controller.enqueue(
                encoder.encode(`event: progress\ndata: ${payload}\n\n`),
              );
              previous = payload;
            } else if (Date.now() - lastHeartbeat >= 15_000) {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
              lastHeartbeat = Date.now();
            }
          } catch (error) {
            console.error(
              "Automation stream failed:",
              error instanceof Error ? error.name : "UnknownError",
            );
            controller.enqueue(
              encoder.encode("event: unavailable\ndata: {}\n\n"),
            );
            stop();
          }
        };
        const timer = setInterval(tick, 1000);
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted) {
          stop();
          return;
        }
        tick();
      },
      cancel() {
        cancelled = true;
        stop();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-store, no-transform",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
