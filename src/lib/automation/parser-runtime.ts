import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StatementResult } from "./parse";
import { ParserFailure } from "./errors";
import { MAX_PARSER_RESULT_BYTES, parserReplySchema, parserRequestSchema } from "./parser-ipc";

export const PARSER_BUDGET_MS = 120_000;
/** Unknown PDF layouts may need several local-AI calls on the NPU. */
export const PDF_PARSER_BUDGET_MS = 600_000;
const requireLocal = createRequire(import.meta.url);
const parserEntrypoint = fileURLToPath(new URL("./child-parser.ts", import.meta.url));

export async function assertParserRuntimeAvailable(): Promise<void> {
  await access(parserEntrypoint);
  requireLocal.resolve("tsx");
}

export type ParserRuntimeOptions = {
  signal?: AbortSignal;
  budgetMs?: number;
  /** Explicit entrypoint allows isolated synthetic process tests, never file input. */
  entrypoint?: string;
  onSpawn?: (pid: number) => void;
};

export async function parseStatementInChild(
  path: string,
  name: string,
  bytes: number,
  options: ParserRuntimeOptions = {},
): Promise<StatementResult> {
  if (options.signal?.aborted) throw new ParserFailure("WORKER_ABORTED");
  const budgetMs = options.budgetMs ?? PARSER_BUDGET_MS;
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1)
    throw new RangeError("Invalid parser budget");
  const deadline = Date.now() + budgetMs;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(join(dirname(path), ".parser-"));
  let rejected = false;
  try {
    const request = parserRequestSchema.parse({
      type: "parse", id: randomUUID(), path, name, bytes, workspace, deadline,
    });
    return await new Promise<StatementResult>((resolve, reject) => {
      let reply: ReturnType<typeof parserReplySchema.parse> | undefined;
      let failure: ParserFailure | undefined;
      const child = fork(
        options.entrypoint ?? parserEntrypoint,
        [],
        {
          execPath: process.execPath,
          execArgv: ["--max-old-space-size=384", "--import", pathToFileURL(requireLocal.resolve("tsx")).href],
          // No account credentials/config, env-file loader, or inherited NODE_OPTIONS.
          env: {
            NODE_ENV: "production",
            PATH: process.env.PATH,
            SYSTEMROOT: process.env.SYSTEMROOT,
            TSX_DISABLE_CACHE: "1",
            // Local AI endpoint for unknown PDF layouts (loopback by default; no credentials).
            ...Object.fromEntries(["FINANZBLICK_AI", "FINANZBLICK_AI_URL", "FINANZBLICK_AI_MODEL", "FINANZBLICK_AI_TIMEOUT_MS"]
              .flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))),
          },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          serialization: "json",
        },
      );
      const stop = (error: ParserFailure) => {
        failure ??= error;
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      };
      const abort = () => stop(new ParserFailure("WORKER_ABORTED"));
      const timer = setTimeout(() => stop(new ParserFailure("PARSE_TIMEOUT")), Math.max(1, deadline - Date.now()));
      options.signal?.addEventListener("abort", abort, { once: true });
      child.on("error", () => stop(new ParserFailure("PARSE_INFRASTRUCTURE")));
      child.on("message", (message: unknown) => {
        if (failure) return;
        try {
          if (reply || Buffer.byteLength(JSON.stringify(message)) > MAX_PARSER_RESULT_BYTES + 1024)
            throw new ParserFailure("PARSE_RESOURCE_LIMIT");
          const parsed = parserReplySchema.safeParse(message);
          if (!parsed.success || parsed.data.id !== request.id)
            throw new ParserFailure("PARSE_INFRASTRUCTURE");
          reply = parsed.data;
        } catch (error) {
          stop(error instanceof ParserFailure ? error : new ParserFailure("PARSE_INFRASTRUCTURE"));
        }
      });
      // Never release concurrency or commit until the parser process has died.
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else if (Date.now() >= deadline) reject(new ParserFailure("PARSE_TIMEOUT"));
        else if (signal === "SIGABRT") reject(new ParserFailure("PARSE_RESOURCE_LIMIT"));
        else if (code !== 0 || !reply) reject(new ParserFailure("PARSE_INFRASTRUCTURE"));
        else if (reply.type === "error") reject(new ParserFailure(reply.code));
        else resolve(reply.result);
      });
      try {
        if (child.pid) options.onSpawn?.(child.pid);
        if (options.signal?.aborted) abort();
        else child.send(request, (error) => {
          if (error) stop(new ParserFailure("PARSE_INFRASTRUCTURE"));
        });
      } catch {
        stop(new ParserFailure("PARSE_INFRASTRUCTURE"));
      }
    });
  } catch (error) {
    rejected = true;
    throw error;
  } finally {
    try {
      await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      if (!rejected) throw new ParserFailure("PARSE_INFRASTRUCTURE");
      console.error("Automation cleanup deferred:", "ParserWorkspaceCleanupError");
    }
  }
}
