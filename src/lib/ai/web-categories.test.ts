import { afterEach, describe, expect, it } from "vitest";
import { queueLedgerReview } from "@/lib/import/review";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { autoAssignOpenReviews, webContextFor } from "./auto-assign";
import { clearIndustryCache, lookupIndustryResult, osmCategory, osmNameMatches } from "./industry";
import { aiSuggestionFor } from "./suggestions";
import { parseDescriptor, pendingWebLookups, recordWebCategories, webHabits, webTarget, type WebTarget } from "./web-categories";

const card = (text: string) =>
  `Verwendungszweck: ${text} Zahlungsreferenz: POS 1,00 AT D3 03.09. 10:15 K1 001`;
const booking = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-09-03", bank: "Raiffeisen", pocket: "Testkonto",
  description: "Testladen Nordlicht", amount: -24, category: "Prüfen", includeInPlan: true, ...overrides,
});
const cardBooking = (id: string, text: string, overrides: Partial<Transaction> = {}) =>
  booking(id, { description: text, rawDescription: card(text), ...overrides });
const confirmed = (id: string, overrides: Partial<Transaction>) =>
  booking(id, { categoryOverride: true, manualCategory: true, reviewed: true, ...overrides });

function stateWith(ledger: Transaction[], open: Transaction[]): AppState {
  const base = appStateSchema.parse({
    ...createSeed(), transactions: ledger, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
    ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [],
  });
  return {
    ...queueLedgerReview(base),
    reviewQueue: open.map((draft) => ({ kind: "booking" as const, id: draft.id, draft, message: "Händlerzuordnung unsicher – bitte prüfen." })),
  };
}

type Place = { name: string; category: string; type: string; display_name: string };
function fakeWeb(places: Record<string, Place[]>, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === "nominatim.openstreetmap.org") return Response.json(places[url.searchParams.get("q") ?? ""] ?? []);
    if (url.hostname === "www.wikidata.org") return Response.json({ search: [] });
    return new Response("", { status: 404 });
  }) as typeof fetch;
}
const known = (target: WebTarget, category: string, kind: string, strong: boolean) => ({
  target, industry: { category, kind, strong, source: "OpenStreetMap" as const, label: `${target.name} (${kind})` },
}) as Parameters<typeof recordWebCategories>[1][number];

afterEach(() => clearIndustryCache());

describe("bank descriptors", () => {
  it("separates shop, city and postcode", () => {
    expect(parseDescriptor("MARTIN AUER ATRIOVIL VILLACH 9500")).toMatchObject({
      name: "Martin Auer Atriovil", place: { city: "Villach", postcode: "9500" }, key: "martinaueratriovil@9500",
    });
    expect(parseDescriptor("ELFS MANUFAKTUR KLAGENFURT AM 9020")).toMatchObject({ name: "Elfs Manufaktur", place: { city: "Klagenfurt" } });
    expect(parseDescriptor("SUMUP *BLUMEN B B VILLACH 9500")).toMatchObject({ name: "Blumen B B", place: { postcode: "9500" } });
    expect(parseDescriptor("MCDONALDS186 VILLACH")).toMatchObject({ name: "Mcdonalds", place: { city: "Villach" } });
    expect(parseDescriptor("12345678")).toBeUndefined();
  });

  it("looks up card payments and PayPal shops but never transfers", () => {
    expect(webTarget({ description: "BURGSCHENKE", rawDescription: card("BURGSCHENKE FINKENSTEIN 9584") }))
      .toMatchObject({ name: "Burgschenke", place: { city: "Finkenstein", postcode: "9584" } });
    expect(webTarget({ description: "PayPal Europe *Zalando", rawDescription: "" })?.place).toBeUndefined();
    expect(webTarget({ description: "Max Mustermann", rawDescription: "Empfänger: Max Mustermann IBAN: AT12 3456" })).toBeUndefined();
    expect(webTarget({ description: "Miete", rawDescription: "Verwendungszweck: Miete Oktober Zahlungsreferenz: 123" })).toBeUndefined();
  });

  it("queues each unknown shop once", () => {
    const state = stateWith([], [
      cardBooking("a", "APOTHEKE ZUM HIRSCHEN VILLACH 9500"),
      cardBooking("b", "APOTHEKE ZUM HIRSCHEN VILLACH 9500", { amount: -8 }),
      cardBooking("c", "GUTSCHRIFT VILLACH 9500", { amount: 30 }),
    ]);
    const pending = pendingWebLookups(state, 10);
    expect(pending.map((target) => target.name)).toEqual(["Apotheke Zum Hirschen"]);
    const done = recordWebCategories(state, [{ target: pending[0] }], 1_000);
    expect(pendingWebLookups(done, 10, new Set(), 2_000)).toEqual([]);
    // Nothing found is asked again a month later.
    expect(pendingWebLookups(done, 10, new Set(), 1_000 + 31 * 86_400_000)).toHaveLength(1);
  });
});

describe("OpenStreetMap", () => {
  it("matches cut-off bank names and maps shop types", () => {
    expect(osmNameMatches("Warmbaderhof Restaura", "Warmbaderhof Restaurant")).toBe(true);
    expect(osmNameMatches("Blumen B B", "Blumen B&B")).toBe(true);
    expect(osmNameMatches("Martin Auer", "Hofer")).toBe(false);
    expect(osmCategory("amenity", "pharmacy")).toEqual({ category: "Gesundheit", strong: true });
    expect(osmCategory("shop", "bakery")?.strong).toBe(false);
    expect(osmCategory("highway", "bus_stop")).toBeUndefined();
  });

  it("finds the shop type at the booking's place", async () => {
    const calls: string[] = [];
    const fetcher = fakeWeb({
      "Hirschen Apotheke Villach": [
        { name: "Hirschen-Apotheke", category: "amenity", type: "pharmacy", display_name: "Hirschen-Apotheke, Hauptplatz, 9500 Villach, Österreich" },
        { name: "Hirschen-Apotheke", category: "amenity", type: "pharmacy", display_name: "Hirschen-Apotheke, 1010 Wien, Österreich" },
      ],
    }, calls);
    const { industry, failed } = await lookupIndustryResult("Hirschen Apotheke", {
      fetcher, throttleMs: 0, place: { city: "Villach", postcode: "9500" },
    });
    expect(failed).toBe(false);
    expect(industry).toMatchObject({ category: "Gesundheit", source: "OpenStreetMap", kind: "amenity=pharmacy", strong: true });
    expect(calls).toHaveLength(1);
  });

  it("ignores shops elsewhere and stays open when trades disagree", async () => {
    const fetcher = fakeWeb({
      "Kukowitsch Villach": [{ name: "Kukowitsch", category: "shop", type: "butcher", display_name: "Kukowitsch, 1010 Wien" }],
      "Warmbaderhof Villach": [
        { name: "Warmbaderhof", category: "tourism", type: "hotel", display_name: "Warmbaderhof, 9504 Villach" },
        { name: "Warmbaderhof Restaurant", category: "amenity", type: "restaurant", display_name: "Warmbaderhof, 9504 Villach" },
      ],
    });
    expect((await lookupIndustryResult("Kukowitsch", { fetcher, throttleMs: 0, place: { city: "Villach", postcode: "9500" } })).industry)
      .toBeUndefined();
    expect((await lookupIndustryResult("Warmbaderhof", { fetcher, throttleMs: 0, place: { city: "Villach", postcode: "9504" } })).industry)
      .toBeUndefined();
    expect((await lookupIndustryResult("Warmbaderhof Restaura", { fetcher, throttleMs: 0, place: { city: "Villach", postcode: "9504" } })).industry)
      .toMatchObject({ category: "Restaurants" });
  });

  it("reports unreachable sources and backs off after a rate limit", async () => {
    let calls = 0;
    const fetcher = (async () => { calls++; return new Response("", { status: 429, headers: { "Retry-After": "60" } }); }) as unknown as typeof fetch;
    expect(await lookupIndustryResult("Hirschen Apotheke", { fetcher, throttleMs: 0, place: { city: "Villach" } }))
      .toEqual({ industry: undefined, failed: true });
    const asked = calls;
    expect((await lookupIndustryResult("Kukowitsch", { fetcher, throttleMs: 0, place: { city: "Villach" } })).failed).toBe(true);
    // Nominatim and Wikidata are left alone; only the shop's own website may still be tried.
    expect(calls - asked).toBeLessThanOrEqual(3);
  });
});

describe("assignment from internet knowledge", () => {
  const pharmacy = cardBooking("p", "HIRSCHEN APOTHEKE VILLACH 9500");
  const bakery = cardBooking("b", "BACKSTUBE NORDLICHT VILLACH 9500", { amount: -6.4 });

  it("assigns strong shop types and only suggests weak ones", () => {
    let state = stateWith([], [pharmacy, bakery]);
    state = recordWebCategories(state, [
      known(webTarget(pharmacy)!, "Gesundheit", "amenity=pharmacy", true),
      known(webTarget(bakery)!, "Cafés & Snacks", "shop=bakery", false),
    ]);
    const outcome = autoAssignOpenReviews(state);
    expect(outcome.applied).toEqual(["p"]);
    expect(aiSuggestionFor(outcome.state, "b")).toMatchObject({ category: "Cafés & Snacks", source: "Branche" });
  });

  it("lets the household's own history win", () => {
    const same = confirmed("h", { description: "HIRSCHEN APOTHEKE VILLACH 9500", category: "Körperpflege", date: "2026-08-01" });
    let state = stateWith([same], [pharmacy]);
    state = recordWebCategories(state, [known(webTarget(pharmacy)!, "Gesundheit", "amenity=pharmacy", true)]);
    const outcome = autoAssignOpenReviews(state);
    expect(outcome.applied).toEqual(["p"]);
    expect(outcome.state.transactions.find((row) => row.id === "p")?.category).toBe("Körperpflege");
    // A different amount is no direct history, but a contradicting confirmed choice still blocks the web answer.
    const other = confirmed("h", { description: "HIRSCHEN APOTHEKE VILLACH 9500", category: "Körperpflege", date: "2026-08-01", amount: -300 });
    state = recordWebCategories(stateWith([other], [pharmacy]), [known(webTarget(pharmacy)!, "Gesundheit", "amenity=pharmacy", true)]);
    expect(autoAssignOpenReviews(state).applied).toEqual([]);
  });

  it("never treats a small fuel station payment as fuel", () => {
    const snack = cardBooking("f", "TANKSTELLE NORD VILLACH 9500", { amount: -4.2 });
    let state = stateWith([], [snack]);
    state = recordWebCategories(state, [known(webTarget(snack)!, "Tanken", "amenity=fuel", true)]);
    expect(autoAssignOpenReviews(state).applied).toEqual([]);
  });

  it("learns what the household books for a shop type", () => {
    const earlier = (id: string, text: string) =>
      confirmed(id, { description: text, rawDescription: card(text), category: "Mittagessen", date: "2026-08-01" });
    const old1 = earlier("o1", "BACKHAUS SONNENSCHEIN VILLACH 9500");
    const old2 = earlier("o2", "BROTLADEN ALPENBLICK VILLACH 9500");
    let state = stateWith([old1, old2], [bakery]);
    state = recordWebCategories(state, [
      known(webTarget(old1)!, "Cafés & Snacks", "shop=bakery", false),
      known(webTarget(old2)!, "Cafés & Snacks", "shop=bakery", false),
      known(webTarget(bakery)!, "Cafés & Snacks", "shop=bakery", false),
    ]);
    expect(webHabits(state).get("shop=bakery")).toBe("Mittagessen");
    expect(webContextFor(state, "b").industry).toMatchObject({ category: "Mittagessen", strong: true });
    expect(autoAssignOpenReviews(state).applied).toEqual(["b"]);
    // One shop is no habit for every shop of that type.
    const single = recordWebCategories(stateWith([old1], [bakery]), [known(webTarget(old1)!, "Cafés & Snacks", "shop=bakery", false)]);
    expect(webHabits(single).size).toBe(0);
  });
});
