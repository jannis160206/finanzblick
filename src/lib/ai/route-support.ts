import { z } from "zod";
import { authorizeApi } from "@/lib/server/auth";
import { accountErrorResponse, jsonResponse, readJsonBody } from "@/lib/server/http";
import { AiUnavailableError } from "./client";

const busy = globalThis as typeof globalThis & { finanzblickAiBusy?: Set<string> };

type Admitted<T> = { input: T; release: () => void };

async function admit<T>(request: Request, kind: string, schema: z.ZodType<T>, maxBytes: number): Promise<Admitted<T> | Response> {
  const denied = await authorizeApi(request);
  if (denied) return denied;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none")
    return jsonResponse({ error: "Diese KI-Anfrage ist nicht erlaubt." }, 403);
  let body: unknown;
  try {
    body = await readJsonBody(request, maxBytes);
  } catch (error) {
    return accountErrorResponse(error);
  }
  const input = schema.safeParse(body);
  if (!input.success) return jsonResponse({ error: "Ungültige KI-Anfrage." }, 400);
  const running = (busy.finanzblickAiBusy ??= new Set());
  if (running.has(kind)) return jsonResponse({ error: "Die lokale KI arbeitet bereits." }, 429);
  running.add(kind);
  return { input: input.data, release: () => running.delete(kind) };
}

function failure(error: unknown, request: Request, kind: string): Response {
  if (error instanceof AiUnavailableError) return jsonResponse({ error: error.message }, 503);
  if (request.signal.aborted) return jsonResponse({ error: "Abgebrochen." }, 499);
  console.error("Local AI request failed:", kind, error instanceof Error ? error.name : "Error");
  return jsonResponse({ error: "Die lokale KI konnte die Anfrage nicht verarbeiten." }, 502);
}

// One NPU job per kind; the model server processes requests sequentially anyway.
export async function handleAiPost<T>(
  request: Request, kind: string, schema: z.ZodType<T>, maxBytes: number,
  run: (input: T, signal: AbortSignal) => Promise<unknown>,
): Promise<Response> {
  const admitted = await admit(request, kind, schema, maxBytes);
  if (admitted instanceof Response) return admitted;
  try {
    return jsonResponse(await run(admitted.input, request.signal));
  } catch (error) {
    return failure(error, request, kind);
  } finally {
    admitted.release();
  }
}

// Same checks, but the events are streamed as NDJSON lines; the job stays busy until the stream ends.
export async function handleAiStream<T>(
  request: Request, kind: string, schema: z.ZodType<T>, maxBytes: number,
  run: (input: T, signal: AbortSignal) => AsyncGenerator<unknown>,
): Promise<Response> {
  const admitted = await admit(request, kind, schema, maxBytes);
  if (admitted instanceof Response) return admitted;
  const events = run(admitted.input, request.signal);
  let first: IteratorResult<unknown>;
  try {
    // The first event surfaces connection errors as a normal JSON error response.
    first = await events.next();
  } catch (error) {
    admitted.release();
    return failure(error, request, kind);
  }
  const encoder = new TextEncoder();
  let released = false;
  const release = () => { if (!released) { released = true; admitted.release(); } };
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let next = first; !next.done; next = await events.next()) controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        controller.close();
      } catch (error) {
        if (!request.signal.aborted) console.error("Local AI stream failed:", kind, error instanceof Error ? error.name : "Error");
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify({ done: true, ok: false })}\n`));
          controller.close();
        } catch {
          // The browser already closed the stream.
        }
      } finally {
        release();
      }
    },
    async cancel() {
      await events.return(undefined);
      release();
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
