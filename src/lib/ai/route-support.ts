import { z } from "zod";
import { authorizeApi } from "@/lib/server/auth";
import { accountErrorResponse, jsonResponse, readJsonBody } from "@/lib/server/http";
import { AiUnavailableError } from "./client";

const busy = globalThis as typeof globalThis & { finanzblickAiBusy?: Set<string> };

// One NPU job per kind; the model server processes requests sequentially anyway.
export async function handleAiPost<T>(
  request: Request, kind: string, schema: z.ZodType<T>, maxBytes: number,
  run: (input: T, signal: AbortSignal) => Promise<unknown>,
): Promise<Response> {
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
  try {
    return jsonResponse(await run(input.data, request.signal));
  } catch (error) {
    if (error instanceof AiUnavailableError) return jsonResponse({ error: error.message }, 503);
    if (request.signal.aborted) return jsonResponse({ error: "Abgebrochen." }, 499);
    console.error("Local AI request failed:", kind, error instanceof Error ? error.name : "Error");
    return jsonResponse({ error: "Die lokale KI konnte die Anfrage nicht verarbeiten." }, 502);
  } finally {
    running.delete(kind);
  }
}
