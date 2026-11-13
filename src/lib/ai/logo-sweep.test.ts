import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationStore } from "@/lib/automation/store";
import { AccountDatabase } from "@/lib/server/database";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { clearIndustryCache } from "./industry";
import { LOGO_OVERRIDES_FILE } from "./logo-brands";
import {
  bookingWebsite, LOGO_MISSES_FILE, logoQueries, logoTarget, missingLogoTargets, readMisses, shortenedQuery, sweepMissingLogos,
} from "./logo-sweep";

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

const badge = async (color: string) => sharp({ create: { width: 180, height: 180, channels: 4, background: color } })
  .composite([
    { input: await sharp({ create: { width: 90, height: 40, channels: 4, background: "#ffffff" } }).png().toBuffer(), left: 45, top: 70 },
    { input: await sharp({ create: { width: 20, height: 10, channels: 4, background: "#202020" } }).png().toBuffer(), left: 80, top: 85 },
  ])
  .png().toBuffer();

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
      const png = await badge("#204080");
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
    expect(logoQueries("E-CENTER KOHLER")).toEqual(["E Center Kohler"]);
  });

  it("never searches the town of the card payment, a person or a trade word alone", () => {
    expect(logoTarget(cardBooking("town", "SALZBURG SALZBURG 5020"))).toBeUndefined();
    expect(logoTarget(cardBooking("pharmacy", "FARMACIA SEVILLA 41001"))).toBeUndefined();
    expect(logoTarget(cardBooking("shop", "FARMACIA NORTE SEVILLA 41001"))?.key).toBe("farmacia norte");
    // Plain card texts without a postcode: the last word may be the shop's own, and short brands count.
    expect(logoTarget(booking("plain", { bank: "Revolut", description: "dm drogerie" }))?.queries).toEqual(["DM Drogerie", "DM"]);
    expect(logoTarget(booking("last", { bank: "Revolut", description: "Pizzeria Nordlicht" }))?.key).toBe("pizzeria nordlicht");
    expect(logoTarget(booking("gift", {
      description: "Auftraggeber: Max Muster", rawDescription: "Auftraggeber: Max Muster IBAN Auftraggeber: AT00", merchantAlias: "Max Muster",
      category: "Geschenke & Spenden", amount: 50,
    }))).toBeUndefined();
  });

  it("asks the web address of the booking text and lets company payees guess a website, never people", () => {
    expect(bookingWebsite("PAYPAL *BEISPIEL GG 12345678 BEISPIEL.GG")).toBe("https://beispiel.gg/");
    expect(bookingWebsite("WWW.OEBB.AT TICKET FOR WIEN")).toBe("https://www.oebb.at/");
    expect(bookingWebsite("Zahlung an PAYPAL.COM")).toBeUndefined();
    expect(bookingWebsite("max@example.com")).toBeUndefined();
    expect(logoTarget(booking("company", { description: "1052270339870/PAYPAL", merchantAlias: "Beispielband24 GmbH" })))
      .toMatchObject({ queries: ["Beispielband24 GmbH", "Beispielband24"], guessWebsite: true });
    expect(logoTarget(booking("person", { description: "1052270339870/PAYPAL", merchantAlias: "Anna Beispiel" })))
      .toMatchObject({ queries: ["Anna Beispiel"], guessWebsite: false });
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
    // Without Wikidata nobody knows whether a name is a shop or a town, so nothing is guessed or remembered.
    expect(stopped).toMatchObject({ rateLimited: true, checked: 0, remaining: 2 });
    expect(limited.calls.some((call) => call.includes("kukowitsch.at"))).toBe(false);
    expect(await readMisses(join(directory, "Limited"))).toEqual({});

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

  it("forgets the misses of an older search, so an improved one tries every merchant again", async () => {
    const logos = join(directory, "Logo");
    await mkdir(logos, { recursive: true });
    await writeFile(join(logos, LOGO_MISSES_FILE), JSON.stringify({ kukowitsch: Date.now() }));
    expect(await readMisses(logos)).toEqual({});
    const result = await sweepMissingLogos(store, userId, state(), { directory: logos, fetcher: fetcher(), ai: false, throttleMs: 0 });
    expect(result.checked).toBe(2);
    expect(Object.keys(await readMisses(logos))).toContain("apple services");
  });

  it("looks up curated brands and the user's own overrides at their official website", async () => {
    const logos = join(directory, "Logo");
    await mkdir(logos, { recursive: true });
    await writeFile(join(logos, LOGO_OVERRIDES_FILE), JSON.stringify({ Nordlicht: "https://nordlicht.example.at", Bad: "ftp://x" }));
    const icon = await badge("#a01010");
    const calls: string[] = [];
    const site = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.href);
      if (url.href === "https://www.dm.at/" || url.href === "https://nordlicht.example.at/")
        return new Response('<link rel="apple-touch-icon" href="/t.png">', { headers: { "content-type": "text/html" } });
      if (url.pathname === "/t.png") return new Response(new Uint8Array(icon), { headers: { "content-type": "image/png" } });
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const result = await sweepMissingLogos(store, userId, stateWith([
      cardBooking("dm", "DM-FIL. A001 GRAZ 8010"), cardBooking("shop", "NORDLICHT VILLACH 9500"),
    ]), { directory: logos, fetcher: site, ai: false, throttleMs: 0 });
    expect(result.saved.map((entry) => [entry.name, entry.source])).toEqual([
      ["DM", "https://www.dm.at/t.png"], ["Nordlicht", "https://nordlicht.example.at/t.png"],
    ]);
    // The curated brand's own Wikidata item may be asked, but never a name search or the map.
    expect(calls.some((call) => call.includes("wbsearchentities") || call.includes("nominatim"))).toBe(false);
  });
});
