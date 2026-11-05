import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationStore } from "@/lib/automation/store";
import { AccountDatabase } from "@/lib/server/database";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { clearIndustryCache } from "./industry";
import { LOGO_MISSES_FILE, logoQueries, missingLogoTargets, shortenedQuery, sweepMissingLogos } from "./logo-sweep";

const userId = "logo-sweep-account";
const card = (text: string) => `Verwendungszweck: ${text} Zahlungsreferenz: POS 1,00 AT D3 03.09. 10:15 K1 001`;
const booking = (id: string, overrides: Partial<Transaction>): Transaction => ({
  id, date: "2026-09-03", bank: "Raiffeisen", pocket: "Testkonto", description: "", amount: -24,
  category: "Shopping", categoryOverride: true, includeInPlan: true, ...overrides,
});
const cardBooking = (id: string, text: string) => booking(id, { description: text, rawDescription: card(text) });

function stateWith(transactions: Transaction[]): AppState {
  return appStateSchema.parse({
    ...createSeed(), transactions, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
    ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [],
  });
}

let directory: string;
let accounts: AccountDatabase;
let store: AutomationStore;

beforeEach(async () => {
  clearIndustryCache();
  directory = await mkdtemp(join(tmpdir(), "logo-sweep-"));
  vi.stubEnv("FINANZBLICK_LOGO_DIR", join(directory, "Logo"));
  accounts = new AccountDatabase(join(directory, "accounts.sqlite"));
  store = new AutomationStore(accounts);
  accounts.transaction((db) => {
    db.prepare("INSERT INTO users VALUES (?, ?, 'user', 'fixture', 1)").run(userId, userId);
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  accounts.close();
  await rm(directory, { recursive: true, force: true });
});

const state = () => stateWith([
  cardBooking("k1", "KUKOWITSCH VILLACH 9500"),
  cardBooking("k2", "KUKOWITSCH VILLACH 9500"),
  cardBooking("fuel", "TANKSTELLE VILLACH 9500"),
  booking("apple", { description: "PayPal Europe Zahlungsempfänger Apple Services", merchantAlias: "Apple Services", amount: -3 }),
  booking("rent", { description: "Max Mustermann Miete Oktober", amount: -700, category: "Transfer" }),
]);

function fetcher(wikidataStatus = 200) {
  const calls: string[] = [];
  const run = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.href);
    if (url.hostname === "www.wikidata.org")
      return wikidataStatus === 200 ? Response.json({ search: [] }) : new Response("", { status: wikidataStatus });
    if (url.hostname === "nominatim.openstreetmap.org") return Response.json([]);
    if (url.href === "https://www.kukowitsch.at/")
      return new Response('<title>Kukowitsch Villach</title><link rel="apple-touch-icon" href="/t.png">', {
        headers: { "content-type": "text/html" },
      });
    if (url.href === "https://www.kukowitsch.at/t.png") {
      const png = await sharp({ create: { width: 180, height: 180, channels: 4, background: "#204080" } }).png().toBuffer();
      return new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } });
    }
    throw new Error("getaddrinfo ENOTFOUND");
  }) as typeof fetch;
  return Object.assign(run, { calls });
}

describe("logoQueries", () => {
  it("searches the brand words of the booking from specific to short, never a bare trade word", () => {
    const queries = logoQueries("SPAR Fil. 6423 Spar Fil Finkenstein");
    expect(queries.at(-1)).toBe("Spar");
    expect(queries.length).toBeGreaterThan(1);
    expect(logoQueries("Tankstelle")).toEqual([]);
    expect(logoQueries("dm")).toEqual(["DM"]);
  });

  it("drops connecting words, regions and trade words that would match strangers", () => {
    expect(logoQueries("TO Porsche Inter Auto")[0]).toMatch(/^Porsche/);
    expect(logoQueries("Hotel ON")).toEqual([]);
    expect(logoQueries("Baeckerei")).toEqual([]);
    expect(logoQueries("Europa Park")).toEqual(["Europa Park"]);
    expect(logoQueries("Sonstiges")).toEqual([]);
  });

  it("makes shortened single words ask for confirmation", () => {
    const target = { queries: ["Europa Park Rust", "Europa Park"], saveAs: "Europa Park Rust" };
    expect(shortenedQuery(target, "Europa Park Rust")).toBe(false);
    expect(shortenedQuery(target, "Europa Park")).toBe(false);
    expect(shortenedQuery(target, "Spar")).toBe(true);
    expect(shortenedQuery({ queries: ["Spar"] }, "Spar")).toBe(false);
  });
});

describe("sweepMissingLogos", () => {
  it("lists payees without a logo, most bookings first, without people or trade words", async () => {
    const targets = await missingLogoTargets(store, userId, state());
    expect(targets.map((target) => [target.queries[0], target.bookings, target.guessWebsite])).toEqual([
      ["Kukowitsch", 2, true],
      ["Apple Services", 1, false],
    ]);
  });

  it("stores found logos, remembers misses for 30 days and stops on rate limits without remembering", async () => {
    const logos = join(directory, "Logo");
    const limited = fetcher(429);
    const stopped = await sweepMissingLogos(store, userId, state(), {
      directory: join(directory, "Limited"), fetcher: limited, ai: false, throttleMs: 0,
    });
    // The website still answers; the payee only Wikidata could identify waits for the next run.
    expect(stopped).toMatchObject({ rateLimited: true, checked: 1, remaining: 1 });
    expect(Object.keys(JSON.parse(await readFile(join(directory, "Limited", LOGO_MISSES_FILE), "utf8")))).toEqual(["kukowitsch"]);

    clearIndustryCache();
    const now = Date.UTC(2026, 10, 1);
    const fetch = fetcher();
    const first = await sweepMissingLogos(store, userId, state(), { directory: logos, fetcher: fetch, ai: false, throttleMs: 0, now });
    expect(first).toMatchObject({ checked: 2, remaining: 0, rateLimited: false });
    expect(first.saved).toEqual([{ name: "Kukowitsch", file: "Kukowitsch.png", source: "https://www.kukowitsch.at/t.png" }]);
    // A person-like PayPal payee never gets a guessed website.
    expect(fetch.calls.some((call) => call.includes("appleservices"))).toBe(false);

    const again = fetcher();
    expect(await sweepMissingLogos(store, userId, state(), { directory: logos, fetcher: again, ai: false, throttleMs: 0, now: now + 86_400_000 }))
      .toMatchObject({ checked: 0, remaining: 0 });
    expect(again.calls).toEqual([]);
    const later = await sweepMissingLogos(store, userId, state(), {
      directory: logos, fetcher: fetcher(), ai: false, throttleMs: 0, now: now + 31 * 86_400_000,
    });
    expect(later.checked).toBe(2);
  });
});
