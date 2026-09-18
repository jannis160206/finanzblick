import { z } from "zod";
import {
  merchantLookupQuerySchema,
  merchantLookupResultsSchema,
  merchantLookupTtl,
  normalizeLookupQuery,
  type MerchantLookupResult,
} from "./merchant-lookup-schema";

const storageKey = "finanzblick.merchant-lookup-cache.v1";
const entrySchema = z.object({
  query: merchantLookupQuerySchema,
  cachedAt: z.number().int().nonnegative(),
  results: merchantLookupResultsSchema,
});
const storageSchema = z.object({
  version: z.literal(1),
  entries: z.array(entrySchema),
});
const responseSchema = z.object({ results: merchantLookupResultsSchema });
type CacheEntry = z.infer<typeof entrySchema>;
const cache = new Map<string, CacheEntry>();
let pending: { query: string; promise: Promise<MerchantLookupResult[]> } | undefined;

function storage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    console.warn("Der optionale Händlersuch-Cache ist nicht zugänglich; Ergebnisse bleiben im Arbeitsspeicher.");
    return undefined;
  }
}

function persist() {
  const target = storage();
  if (!target) return;
  try {
    target.setItem(storageKey, JSON.stringify({ version: 1, entries: [...cache.values()] }));
  } catch {
    console.warn("Der optionale Händlersuch-Cache konnte nicht gespeichert werden; Ergebnisse bleiben im Arbeitsspeicher.");
  }
}

function pruneCache() {
  let changed = false;
  const now = Date.now();
  for (const [query, entry] of cache) {
    if (entry.cachedAt > now || now - entry.cachedAt >= merchantLookupTtl) {
      cache.delete(query);
      changed = true;
    }
  }
  return changed;
}

function discardCorruptCache(target: Storage) {
  console.warn("Der optionale Händlersuch-Cache war ungültig und wurde verworfen.");
  try {
    target.removeItem(storageKey);
  } catch {
    console.warn("Der ungültige Händlersuch-Cache konnte nicht aus dem Browserspeicher entfernt werden.");
  }
}

function hydrateCache() {
  const target = storage();
  if (!target) return;
  let text: string | null;
  try {
    text = target.getItem(storageKey);
  } catch {
    console.warn("Der optionale Händlersuch-Cache konnte nicht gelesen werden; die Suche bleibt verfügbar.");
    return;
  }
  if (text === null) return;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    discardCorruptCache(target);
    return;
  }
  const parsed = storageSchema.safeParse(raw);
  if (!parsed.success) {
    discardCorruptCache(target);
    return;
  }
  const normalized: CacheEntry[] = [];
  for (const entry of parsed.data.entries) {
    const query = normalizeLookupQuery(entry.query);
    if (!merchantLookupQuerySchema.safeParse(query).success) {
      discardCorruptCache(target);
      return;
    }
    normalized.push({ ...entry, query });
  }
  for (const entry of normalized) {
    const existing = cache.get(entry.query);
    if (!existing || existing.cachedAt < entry.cachedAt) {
      cache.set(entry.query, entry);
    }
  }
  if (pruneCache()) persist();
}

async function requestLookup(query: string): Promise<MerchantLookupResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    let response: Response;
    try {
      response = await fetch("/api/merchant-lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({ query }),
      });
    } catch {
      throw new Error(controller.signal.aborted
        ? "Die Händlersuche hat zu lange gedauert. Bitte später erneut versuchen."
        : "Die Händlersuche ist nicht erreichbar. Bitte die Internetverbindung prüfen.");
    }
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("Die Händlersuche wurde für diese Seitenadresse blockiert. Bitte die Seite neu laden.");
      }
      if (response.status === 429) {
        throw new Error("Die Händlersuche ist gerade ausgelastet. Bitte kurz warten und erneut versuchen.");
      }
      if (response.status === 504) {
        throw new Error("Die Händlersuche hat zu lange gedauert. Bitte später erneut versuchen.");
      }
      throw new Error("Die Händlersuche ist derzeit nicht verfügbar. Bitte später erneut versuchen.");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error(controller.signal.aborted
        ? "Die Händlersuche hat zu lange gedauert. Bitte später erneut versuchen."
        : "Die Händlersuche hat eine ungültige Antwort geliefert.");
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error("Die Händlersuche hat eine ungültige Antwort geliefert.");
    }
    return parsed.data.results;
  } finally {
    clearTimeout(timeout);
  }
}

function copyResults(results: MerchantLookupResult[]) {
  return results.map((result) => ({ ...result }));
}

export async function lookupMerchant(query: string): Promise<MerchantLookupResult[]> {
  const input = merchantLookupQuerySchema.safeParse(query);
  if (!input.success) throw new Error("Bitte einen gültigen Händlernamen angeben.");
  query = normalizeLookupQuery(input.data);
  if (!merchantLookupQuerySchema.safeParse(query).success) {
    throw new Error("Bitte einen gültigen Händlernamen angeben.");
  }
  const cached = cache.get(query);
  if (cached && cached.cachedAt <= Date.now() && Date.now() - cached.cachedAt < merchantLookupTtl) {
    return copyResults(cached.results);
  }
  // Another tab may have populated storage since this module's last lookup.
  hydrateCache();
  if (pruneCache()) persist();
  const stored = cache.get(query);
  if (stored) return copyResults(stored.results);
  if (pending?.query === query) return copyResults(await pending.promise);
  if (pending) {
    throw new Error("Eine Händlersuche läuft bereits. Bitte zuerst deren Ergebnis abwarten.");
  }
  const promise = requestLookup(query).then((results) => {
    cache.set(query, { query, results, cachedAt: Date.now() });
    persist();
    return results;
  });
  pending = { query, promise };
  try {
    return copyResults(await promise);
  } finally {
    pending = undefined;
  }
}
