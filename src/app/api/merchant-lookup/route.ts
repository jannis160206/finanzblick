import { z } from "zod";
import {
  merchantLookupQuerySchema,
  merchantLookupResultsSchema,
  merchantLookupTtl,
  normalizeLookupQuery,
  type MerchantLookupResult,
} from "@/lib/merchant-lookup-schema";

export const runtime = "nodejs";

const requestSchema = z.object({ query: merchantLookupQuerySchema }).strict();
const upstreamSchema = z.array(z.object({
  place_id: z.union([z.string().min(1).max(80), z.number().int().nonnegative()]),
  name: z.string().trim().max(200).nullish(),
  display_name: z.string().trim().min(1).max(1000),
})).max(3);
const timeoutMs = 8_000;

type Outcome =
  | { status: 200; results: MerchantLookupResult[] }
  | { status: number; error: string };
type LookupState = {
  cache: Map<string, { results: MerchantLookupResult[]; cachedAt: number }>;
  pending?: { query: string; promise: Promise<Outcome> };
  lastStartedAt?: number;
};

// Keep the public-service concurrency limit even when Next reloads this module.
const processState = globalThis as typeof globalThis & {
  finanzblickMerchantLookup?: LookupState;
};
const state: LookupState = processState.finanzblickMerchantLookup ??= { cache: new Map() };

function respond(outcome: Outcome) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (outcome.status === 429) headers.set("Retry-After", "1");
  return Response.json(
    "results" in outcome ? { results: outcome.results } : { error: outcome.error },
    { status: outcome.status, headers },
  );
}

function pruneCache() {
  const now = Date.now();
  for (const [query, entry] of state.cache) {
    if (entry.cachedAt > now || now - entry.cachedAt >= merchantLookupTtl) {
      state.cache.delete(query);
    }
  }
}

async function search(query: string): Promise<Outcome> {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({
    format: "json",
    limit: "3",
    countrycodes: "at",
    addressdetails: "1",
    q: query,
  }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      state.lastStartedAt = Date.now();
      response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Finanzblick/1.0 (private; github.com/jannis160206/finanzblick)",
          Referer: "https://github.com/jannis160206/finanzblick",
        },
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      return controller.signal.aborted
        ? { status: 504, error: "Die Händlersuche hat zu lange gedauert." }
        : { status: 502, error: "Die Händlersuche ist derzeit nicht erreichbar." };
    }
    if (response.status === 429) {
      return { status: 429, error: "Die Händlersuche ist derzeit ausgelastet. Bitte später erneut versuchen." };
    }
    if (!response.ok) {
      return { status: 502, error: "Die Händlersuche ist derzeit nicht verfügbar." };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return controller.signal.aborted
        ? { status: 504, error: "Die Händlersuche hat zu lange gedauert." }
        : { status: 502, error: "Die Händlersuche hat eine ungültige Antwort geliefert." };
    }
    const upstream = upstreamSchema.safeParse(body);
    if (!upstream.success) {
      return { status: 502, error: "Die Händlersuche hat eine ungültige Antwort geliefert." };
    }
    const parsed = merchantLookupResultsSchema.safeParse(upstream.data.map((place) => ({
      id: String(place.place_id),
      name: place.name || place.display_name.split(",")[0].trim(),
      displayName: place.display_name,
    })));
    if (!parsed.success) {
      return { status: 502, error: "Die Händlersuche hat eine ungültige Antwort geliefert." };
    }
    pruneCache();
    state.cache.set(query, { results: parsed.data, cachedAt: Date.now() });
    return { status: 200, results: parsed.data };
  } finally {
    clearTimeout(timeout);
  }
}

function matchesRequestOrigin(request: Request, origin: string): boolean {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host === null) return origin === url.origin;
  try {
    // Next can normalize request.url to localhost even when the browser used 127.0.0.1.
    const incoming = new URL(`${url.protocol}//${host}`);
    if (incoming.username || incoming.password || incoming.pathname !== "/" || incoming.search || incoming.hash)
      return false;
    return origin === incoming.origin;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (
    (origin !== null && !matchesRequestOrigin(request, origin)) ||
    (site !== null && site !== "same-origin" && site !== "none")
  ) {
    return respond({ status: 403, error: "Diese Händlersuche ist nicht erlaubt." });
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return respond({ status: 415, error: "Die Händlersuche erwartet JSON." });
  }
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 2_000) {
      return respond({ status: 400, error: "Bitte einen gültigen Händlernamen angeben." });
    }
    body = JSON.parse(text);
  } catch {
    return respond({ status: 400, error: "Die Suchanfrage enthält kein gültiges JSON." });
  }
  const input = requestSchema.safeParse(body);
  if (!input.success) {
    return respond({ status: 400, error: "Bitte einen gültigen Händlernamen angeben." });
  }
  const query = normalizeLookupQuery(input.data.query);
  if (!merchantLookupQuerySchema.safeParse(query).success) {
    return respond({ status: 400, error: "Bitte einen gültigen Händlernamen angeben." });
  }
  pruneCache();
  const cached = state.cache.get(query);
  if (cached) return respond({ status: 200, results: cached.results });
  if (state.pending?.query === query) return respond(await state.pending.promise);
  if (
    state.pending ||
    (state.lastStartedAt !== undefined && Date.now() - state.lastStartedAt < 1_000)
  ) {
    return respond({ status: 429, error: "Die Händlersuche läuft bereits. Bitte kurz warten." });
  }
  const promise = search(query);
  state.pending = { query, promise };
  try {
    return respond(await promise);
  } finally {
    state.pending = undefined;
  }
}
