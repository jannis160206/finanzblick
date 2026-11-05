import { afterEach, describe, expect, it } from "vitest";
import { knownMerchantCategory } from "@/lib/categories";
import { matchPaypalActivity, parsePaypalActivity } from "@/lib/import/paypal-activity";
import { fixUmlautCase } from "@/lib/import/statements";
import { learningCurve } from "@/lib/insights";
import { importResultSchema } from "@/lib/import/result-schema";
import { queueLedgerReview } from "@/lib/import/review";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { assignAfterImport, autoAssignOpenReviews } from "./auto-assign";
import {
  amexEntertainmentCredit, amexReversalPair, partnerContribution, partnerPurpose, paypalCreditPair, paypalRecurringMonths,
  returnedDebitPair,
} from "./booking-matchers";
import { decideReviewWithEvidence, industryContext, refundOrigin } from "./evidence";
import { clearIndustryCache, industryCategory, lookupIndustry } from "./industry";

const booking = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-09-03", bank: "Raiffeisen", pocket: "Testkonto",
  description: "Testladen Nordlicht", amount: -24, category: "Prüfen", includeInPlan: true, ...overrides,
});
const confirmed = (id: string, overrides: Partial<Transaction>) =>
  booking(id, { categoryOverride: true, manualCategory: true, reviewed: true, ...overrides });

function base(transactions: Transaction[]): AppState {
  return appStateSchema.parse({
    ...createSeed(), transactions, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
    ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [],
  });
}
const withOpen = (ledger: Transaction[], open: Transaction[]): AppState => ({
  ...queueLedgerReview(base(ledger)),
  reviewQueue: open.map((draft) => ({ kind: "booking" as const, id: draft.id, draft, message: "Händlerzuordnung unsicher – bitte prüfen." })),
});

describe("fixed bank pairs", () => {
  it("treats Amex benefit credits as refunds", () => {
    const credit = (description: string, bank = "Amex", amount = 25) => ({ id: "c", amount, description, bank });
    expect(amexEntertainmentCredit(credit("Entertainment Gutschrift"))).toMatchObject({ category: "Rückerstattungen" });
    expect(amexEntertainmentCredit(credit("Gourmet Gutschrift"))?.detail).toContain("Gourmet");
    expect(amexEntertainmentCredit(credit("Entertainment Gutschrift", "Raiffeisen"))).toBeUndefined();
    expect(amexEntertainmentCredit(credit("Entertainment Gutschrift", "Amex", -25))).toBeUndefined();
  });

  it("balances a returned debit with the payment that replaced it", () => {
    const state = withOpen([], [
      booking("r", { bank: "Amex", date: "2026-05-02", amount: -310.2, description: "RÜCKLASTSCHRIFT" }),
      booking("p", { bank: "Amex", date: "2026-05-09", amount: 310.2, description: "ZAHLUNG ERHALTEN. BESTEN DANK." }),
      booking("fee", { bank: "Amex", date: "2026-05-02", amount: -15, description: "GEBÜHREN FÜR RETOURNIERTE LASTSCHRIFT" }),
    ]);
    const draft = (id: string) => state.reviewQueue!.flatMap((item) => item.kind === "booking" && item.id === id ? [item.draft] : [])[0] as Transaction;
    expect(returnedDebitPair(state, draft("r"))).toMatchObject({ category: "Transfer intern" });
    expect(returnedDebitPair(state, draft("p"))).toMatchObject({ category: "Transfer intern" });
    expect(returnedDebitPair(state, draft("fee"))).toBeUndefined();
    expect(knownMerchantCategory("GEBÜHREN FÜR RETOURNIERTE LASTSCHRIFT", -15)).toBe("Rücklastschriftgebühren");
    expect(knownMerchantCategory(fixUmlautCase("GEBüHREN FüR RETOURNIERTE LASTSCHRIFT"), -15)).toBe("Rücklastschriftgebühren");
  });

  it("pairs a generic Amex credit only with a single charge of that amount", () => {
    const charge = booking("m", { bank: "Amex", date: "2026-08-31", amount: -145.71, description: "RENTALMOTORBIKE MANRESA" });
    const credit = booking("c", { bank: "Amex", date: "2026-08-31", amount: 145.71, description: "SONSTIGE GUTSCHRIFT" });
    expect(amexReversalPair(withOpen([], [charge, credit]), credit)).toMatchObject({ category: "Rückerstattungen", refund: true });
    const twin = booking("m2", { ...charge, id: "m2", date: "2026-08-20" });
    expect(amexReversalPair(withOpen([], [charge, twin, credit]), credit)).toBeUndefined();
  });

  it("repays anonymous PayPal debits and spots recurring amounts", () => {
    const debit = (id: string, date: string, amount = -4.9) => booking(id, { date, amount, description: "1051861566294/PAYPAL" });
    const credit = booking("back", { date: "2026-03-10", amount: 4.9, description: "YYW1234567/PAYPAL" });
    const state = withOpen([], [debit("d1", "2026-01-05"), debit("d2", "2026-02-05"), debit("d3", "2026-03-05"), credit,
      debit("v1", "2026-01-07", -1), debit("v2", "2026-02-07", -1), debit("v3", "2026-03-07", -1)]);
    expect(paypalCreditPair(state, credit)).toMatchObject({ category: "Rückerstattungen", detail: expect.stringContaining("2026-03-05") });
    expect(paypalRecurringMonths(state, debit("d1", "2026-01-05"))).toBe(3);
    expect(paypalRecurringMonths(state, debit("v1", "2026-01-07", -1))).toBe(0);
    expect(paypalRecurringMonths(state, { ...debit("d1", "2026-01-05"), merchantAlias: "Spotify" })).toBe(0);
  });

  it("reads the partner's transfer note as a cost share", () => {
    expect(partnerPurpose("Auto tanki")).toBe("Tanken");
    expect(partnerPurpose("Mciii Käffchen")).toBe("Cafés & Snacks");
    expect(partnerPurpose("Flugbuchung Malaysia")).toBe("Urlaub");
    expect(partnerPurpose("Tanken und Kaffee")).toBeUndefined();
    expect(partnerPurpose("Grabstätte")).toBeUndefined();
    const transfer = booking("t", { amount: 40, description: "Raphael Piber Auto tanki" });
    expect(partnerContribution(withOpen([], [transfer]), transfer)).toMatchObject({ category: "Tanken" });
    expect(partnerContribution(withOpen([], [transfer]), { ...transfer, description: "Auto tanki" })).toBeUndefined();
  });
});

describe("refunds", () => {
  const purchase = confirmed("buy", { date: "2026-06-01", amount: -59.9, description: "OBI MARKT 4711 VILLACH", merchantAlias: "OBI", category: "Reparaturen & Instandhaltung" });

  it("accepts exact and partial refunds of a decided purchase", () => {
    const state = withOpen([purchase], []);
    const credit = (amount: number) => ({ id: "c", date: "2026-06-10", amount, description: "OBI SAGT DANKE" });
    expect(refundOrigin(state, credit(59.9))?.id).toBe("buy");
    expect(refundOrigin(state, credit(19.51))?.id).toBe("buy");
    expect(refundOrigin(state, credit(80))).toBeUndefined();
  });

  it("waits while the purchase itself is still open", () => {
    const open = { ...purchase, category: "Prüfen" as const, categoryOverride: false, manualCategory: false, reviewed: false };
    expect(refundOrigin(withOpen([open], [open]), { id: "c", date: "2026-06-10", amount: 19.51, description: "OBI SAGT DANKE" })).toBeUndefined();
  });
});

describe("text normalization", () => {
  it("repairs lower-case umlauts in upper-case words only", () => {
    expect(fixUmlautCase("GEBüHREN FüR RüCKLASTSCHRIFT")).toBe("GEBÜHREN FÜR RÜCKLASTSCHRIFT");
    expect(fixUmlautCase("Gebühren für Kühe")).toBe("Gebühren für Kühe");
  });
});

describe("industry lookup", () => {
  afterEach(() => clearIndustryCache());
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const html = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { "content-type": "text/html", ...init.headers } });

  it("maps an industry text to exactly one category", () => {
    expect(industryCategory("Baumarkt für Heimwerker")).toBe("Reparaturen & Instandhaltung");
    expect(industryCategory("Online-Shop für Mode und Schuhe")).toBe("Shopping");
    expect(industryCategory("Irgendein Unternehmen")).toBeUndefined();
  });

  it("uses a unique exact Wikidata entity", async () => {
    const fetcher = async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("wbsearchentities")) return json({ search: [{ id: "Q1", label: "Renovaro", match: { text: "Renovaro" } }] });
      if (href.includes("ids=Q1")) return json({ entities: { Q1: { labels: { de: { value: "Renovaro" } }, descriptions: { de: { value: "deutscher Baumarkt" } }, claims: {} } } });
      return json({ entities: {} });
    };
    await expect(lookupIndustry("Renovaro", { fetcher: fetcher as typeof fetch })).resolves.toMatchObject({
      category: "Reparaturen & Instandhaltung", source: "Wikidata" });
  });

  it("falls back to the shop's own page and rejects foreign or parked hosts", async () => {
    const pages: Record<string, () => Response> = {
      "https://www.fugenshop.de/": () => html("<title>Fugenshop – Baumarkt für Fugen &amp; Dichtband</title>"),
      "https://www.umleitung.de/": () => html("", { status: 301, headers: { location: "https://andere-firma.de/" } }),
      "https://www.parkiert.de/": () => html("<title>This domain is for sale</title><meta name=description content='Baumarkt'>"),
    };
    const fetcher = async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes("wikidata")) return json({ search: [] });
      return pages[href]?.() ?? html("", { status: 404 });
    };
    const options = { fetcher: fetcher as typeof fetch };
    await expect(lookupIndustry("Fugenshop", options)).resolves.toMatchObject({ category: "Reparaturen & Instandhaltung", source: "Webseite" });
    await expect(lookupIndustry("Umleitung", options)).resolves.toBeUndefined();
    await expect(lookupIndustry("Parkiert", options)).resolves.toBeUndefined();
  });

  it("does not remember transient failures", async () => {
    let calls = 0;
    const failing = async () => { calls++; throw new Error("429"); };
    await lookupIndustry("Wackelshop", { fetcher: failing as typeof fetch });
    await lookupIndustry("Wackelshop", { fetcher: failing as typeof fetch });
    expect(calls).toBeGreaterThan(1);
  });

  it("only accepts a model answer that the industry confirms", () => {
    const state = withOpen([], [booking("o", { amount: -42, description: "PAYPAL *RENOVARO 06136922270" })]);
    const input = { ref: "b1", text: "PAYPAL *RENOVARO 06136922270", amount: -42, date: "2026-09-03", bank: "Raiffeisen" };
    const answer = (category: string) => ({ ref: "b1", category, merchant: "Renovaro", confidence: 95, accepted: true }) as never;
    const context = industryContext({ category: "Reparaturen & Instandhaltung", label: "Baumarkt" });
    expect(decideReviewWithEvidence(state, "o", input, answer("Reparaturen & Instandhaltung"), context)).toMatchObject({ accepted: true, source: "Branche" });
    expect(decideReviewWithEvidence(state, "o", input, answer("Shopping"), context)).toMatchObject({ accepted: false });
  });
});

describe("PayPal activity export", () => {
  const csv = [
    '"Datum","Uhrzeit","Zeitzone","Name","Typ","Status","Währung","Brutto","Gebühr","Netto","Transaktionscode"',
    '"05.03.2026","10:00:00","MEZ","Renovaro GmbH","Express-Zahlung","Abgeschlossen","EUR","-42,00","0,00","-42,00","AAA1"',
    '"05.03.2026","10:00:01","MEZ","","Bankgutschrift auf PayPal-Konto","Abgeschlossen","EUR","42,00","0,00","42,00","AAA2"',
    '"06.03.2026","11:00:00","MEZ","Shop A","Express-Zahlung","Abgeschlossen","EUR","-9,90","0,00","-9,90","AAA3"',
    '"06.03.2026","11:30:00","MEZ","Shop B","Express-Zahlung","Abgeschlossen","EUR","-9,90","0,00","-9,90","AAA4"',
    '"07.03.2026","12:00:00","MEZ","Ausstehend","Express-Zahlung","Ausstehend","EUR","-5,00","0,00","-5,00","AAA5"',
  ].join("\n");

  it("keeps completed EUR payments to named parties", () => {
    const rows = parsePaypalActivity(csv);
    expect(rows.map((row) => row.name)).toEqual(["Renovaro GmbH", "Shop A", "Shop B"]);
    expect(rows[0]).toMatchObject({ date: "2026-03-05", amount: -42 });
    expect(() => parsePaypalActivity("a;b\n1;2")).toThrow();
  });

  it("names a bank booking only when one shop fits", () => {
    const anonymous = (id: string, date: string, amount: number) => booking(id, { date, amount, description: "1051861566294/PAYPAL" });
    const state = withOpen([], [anonymous("r", "2026-03-07", -42), anonymous("amb", "2026-03-08", -9.9), anonymous("none", "2026-03-20", -42)]);
    const result = matchPaypalActivity(state, parsePaypalActivity(csv));
    expect(result).toMatchObject({ ambiguous: 1, unmatched: 1, matched: [{ id: "r", name: "Renovaro GmbH" }] });
    const draft = result.state.reviewQueue!.find((item) => item.id === "r");
    expect(draft?.kind === "booking" && draft.draft.merchantAlias).toBe("Renovaro GmbH");
  });
});

describe("import-time assignment and learning curve", () => {
  const amexCredit = booking("credit", { bank: "Amex", amount: 25, description: "Entertainment Gutschrift" });
  const unknown = booking("unknown", { amount: -12, description: "XYZ WARENHANDEL 4711" });
  const upload = "6f1c2a7e-4d3b-4c8a-9e1f-2b3c4d5e6f70";
  const imported = (state: AppState): AppState => ({
    ...state,
    reviewQueue: state.reviewQueue?.map((item) => ({ ...item, importUploadId: upload })),
    importResults: [importResultSchema.parse({ uploadId: upload, name: "amex.csv", completedAt: 1_000,
      status: "with-warnings", inserted: 8, updated: 0, duplicates: 0, review: 2, skipped: 0, issues: [] })],
  });

  it("assigns certain bookings without a model and leaves the rest open", () => {
    const { state, applied } = autoAssignOpenReviews(withOpen([], [amexCredit, unknown]));
    expect(applied).toEqual(["credit"]);
    expect(state.reviewQueue?.map((item) => item.id)).toEqual(["unknown"]);
  });

  it("records the automatic share per import", () => {
    const state = assignAfterImport(imported(withOpen([], [amexCredit, unknown])), [upload]);
    expect(state.aiLearning).toEqual([{ id: upload, name: "amex.csv", at: 1_000, rows: 10, automatic: 8, ai: 1 }]);
    const curve = learningCurve({ ...state, aiLearning: [...state.aiLearning!, { id: "u2", name: "b.csv", at: 2_000, rows: 4, automatic: 1, ai: 0, later: 1 }] });
    expect(curve.imports.map((entry) => entry.share)).toEqual([90, 50]);
    expect(curve).toMatchObject({ share: 79, openTotal: 1 });
  });
});
