import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { queueLedgerReview } from "@/lib/import/review";
import { appStateSchema, type AppState, type ReviewItem, type Transaction } from "@/lib/types";
import { applyAiReviewDecisions } from "./apply-review-decisions";
import {
  cleanMerchantName, extractJsonArray, interpretCategorization, merchantMatchesText, plausibilityIssue, providerMerchant, resolveCategoryName,
  type AiCategorization,
} from "./categorize";
import { brandKey, decideReviewWithEvidence, similarAmount } from "./evidence";
import { isLoopbackUrl } from "./config";
import { logoFileName } from "./logo-finder";
import { aiReviewCandidates, isAiEligibleReview } from "./review-candidates";

const booking = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-09-03", bank: "Raiffeisen", pocket: "Testkonto",
  description: "Testladen Nordlicht", amount: -24, category: "Prüfen", includeInPlan: true, ...overrides,
});

function fixture(transactions: Transaction[]): AppState {
  return queueLedgerReview(appStateSchema.parse({
    ...createSeed(), transactions, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
    ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [],
  }));
}

const inputs = [
  { ref: "b1", text: "BILLA DANKT", amount: -23.45, date: "2026-10-01", bank: "Erste" },
  { ref: "b2", text: "GEHALT ACME", amount: 2400, date: "2026-10-01", bank: "Erste" },
  { ref: "b3", text: "XYZ GMBH", amount: -10, date: "2026-10-01", bank: "Erste" },
];

describe("interpretCategorization", () => {
  it("keeps valid entries when one entry is malformed", () => {
    const text = `[{"ref":"b1","category":"Lebensmittel","merchant":"BILLA","confidence":95},{"ref":"b2","category":"Gehalt"}]`;
    const [billa, salary] = interpretCategorization(text, inputs, 90);
    expect(billa).toMatchObject({ category: "Lebensmittel", accepted: true });
    expect(salary).toMatchObject({ accepted: false, reason: "keine Antwort" });
  });

  it("accepts confident answers and keeps uncertain ones open", () => {
    const text = `<think>x</think>Antwort: [{"ref":"b1","category":"Lebensmittel: Supermarkt","merchant":"BILLA","confidence":95},
      {"ref":"b2","category":"Gehalt","merchant":null,"confidence":96},
      {"ref":"b3","category":"Prüfen","merchant":"null","confidence":30}]`;
    const [billa, salary, unknown] = interpretCategorization(text, inputs, 90);
    expect(billa).toMatchObject({ category: "Lebensmittel", merchant: "BILLA", accepted: true });
    expect(salary).toMatchObject({ category: "Gehalt", accepted: false });
    expect(unknown).toMatchObject({ category: "Prüfen", accepted: false });
    expect(unknown.merchant).toBeUndefined();
  });

  it("rejects sign mismatches, unknown categories and missing answers", () => {
    const text = `[{"ref":"b1","category":"Gehalt","confidence":100},{"ref":"b2","category":"Erfunden","confidence":99}]`;
    const results = interpretCategorization(text, inputs, 90);
    expect(results.map((item) => item.accepted)).toEqual([false, false, false]);
    expect(results[2].reason).toBe("keine Antwort");
    expect(interpretCategorization("kein json", inputs, 90).every((item) => !item.accepted)).toBe(true);
  });

  it("parses embedded arrays and category names", () => {
    expect(cleanMerchantName("CINEPLEXX Kinobetriebe GmbH")).toBe("CINEPLEXX");
    expect(cleanMerchantName("KUKOWITSCH 3219")).toBe("KUKOWITSCH");
    expect(cleanMerchantName("PayPal Europe S.a.r.l. et Cie S.C.A")).toMatch(/^PayPal/);
    expect(cleanMerchantName("null")).toBeUndefined();
    expect(cleanMerchantName("Sonstiges")).toBeUndefined();
    expect(cleanMerchantName("Zahlungsempfänger")).toBeUndefined();
    const shrug = interpretCategorization(`[{"ref":"b3","category":"Sonstiges","merchant":"Sonstiges","confidence":99}]`, inputs, 90)[2];
    expect(shrug).toMatchObject({ accepted: false });
    const paypal = interpretCategorization(`[{"ref":"b1","category":"Abonnements","merchant":"PayPal Europe","confidence":99}]`, inputs, 90)[0];
    expect(paypal).toMatchObject({ accepted: false, merchant: undefined });
    expect(extractJsonArray('x [1,2] y')).toEqual([1, 2]);
    expect(extractJsonArray("[broken")).toBeUndefined();
    expect(resolveCategoryName(" tanken ")).toBe("Tanken");
    expect(resolveCategoryName("Nichts")).toBeUndefined();
  });
});

describe("plausibility checks", () => {
  const card = (text: string, amount = -20) => ({ ref: "b1", text, amount, date: "2026-10-01", bank: "Raiffeisen" });

  it("rejects answers that contradict bank rules or the booking text", () => {
    expect(plausibilityIssue(card("DM DROGERIE MARKT 2361"), "Lebensmittel", "dm")).toBeTruthy();
    expect(plausibilityIssue(card("H&M 123 VILLACH 9500"), "Shopping", "VILLACH")).toBeTruthy();
    expect(plausibilityIssue(card("ATM S6EE1142 VILLACH 9500"), "Tanken", "ATM")).toBeTruthy();
    expect(plausibilityIssue(card("PayPal Europe S.a.r.l. et Cie"), "Sport & Fitness", undefined)).toBeTruthy();
    expect(plausibilityIssue(card("WIN2DAY WIEN 1030"), "Rücklastschriftgebühren", "WIN2DAY")).toBeTruthy();
    expect(plausibilityIssue(card("VILLACH ATRIO SHOPPING VILLACH"), "Lebensmittel", "VILLACH")).toBeTruthy();
    expect(plausibilityIssue(card("FALKENSTEINER SCHLOSSHOTEL VELDEN"), "Urlaub", "Falkensteiner Schlosshotel Velden")).toBeUndefined();
  });

  it("accepts consistent answers and rule refinements", () => {
    expect(plausibilityIssue(card("SHELL | SHELL FURNITZ 8387 KAER FURNITZ"), "Tanken", "SHELL")).toBeUndefined();
    expect(plausibilityIssue(card("OMV 2595 VILLACH 9500"), "Tanken", "OMV")).toBeUndefined();
    expect(plausibilityIssue(card("OEBB TICKET 1020"), "Öffentliche Verkehrsmittel", "OEBB")).toBeUndefined();
    expect(plausibilityIssue(card("PAYPAL *SWISS | SWISS INTERNATIONAL"), "Urlaub", "SWISS")).toBeUndefined();
    expect(merchantMatchesText("Booking.com", "www.booking.com Amsterdam")).toBe(true);
    expect(merchantMatchesText("VILLACH", "H&M 123 VILLACH 9500")).toBe(false);
  });
});

describe("evidence gate", () => {
  const input = (text: string, amount: number) => ({ ref: "b1", text, amount, date: "2026-10-01", bank: "Amex" });
  const answer = (category: string, merchant?: string) => ({ ref: "b1", category, merchant, confidence: 95, accepted: true }) as AiCategorization;
  const history = (id: string, alias: string, amount: number, category: Transaction["category"]) =>
    booking(id, { description: `${alias} 2361`, merchantAlias: alias, amount, category, categoryOverride: true, manualCategory: true, reviewed: true });
  const withOpen = (ledger: Transaction[], open: Transaction[]): AppState => ({
    ...fixture(ledger),
    reviewQueue: open.map((draft) => ({ kind: "booking" as const, id: draft.id, draft, message: "Händlerzuordnung unsicher – bitte prüfen." })),
  });

  it("normalizes brands across banks and ignores payment providers", () => {
    expect(brandKey({ description: "OMV 2595 2040OM2595 Villach" })).toBe("omv");
    expect(brandKey({ description: "x", merchantAlias: "OMV" })).toBe("omv");
    expect(brandKey({ description: "PAYPAL *G2A COM LTD 4029357733" })).toBe("g2a");
    expect(brandKey({ description: "x", merchantAlias: "G2A.com" })).toBe("g2a");
    expect(brandKey({ description: "1051861566294/PAYPAL" })).toBeUndefined();
    expect(brandKey({ description: "PAYPAL *PAYPAL EEA 07517591951" })).toBeUndefined();
    expect(brandKey({ description: "HOTEL SCHLOSS SEEFELS" })).toBe("hotel schloss");
    expect(similarAmount(-4.23, -1.74)).toBe(true);
    expect(similarAmount(-9.22, -67)).toBe(false);
    expect(similarAmount(-5, 5)).toBe(false);
  });

  it("follows the household's own history before the model", () => {
    const state = withOpen([
      history("s1", "INTERSPAR", -12.86, "Cafés & Snacks"), history("s2", "INTERSPAR", -10.36, "Cafés & Snacks"),
    ], [booking("open", { description: "Interspar Fil. 8820 Int VILLACH", amount: -13.55 })]);
    const decision = decideReviewWithEvidence(state, "open", input("Interspar Fil. 8820 Int VILLACH", -13.55), answer("Lebensmittel", "Interspar"));
    expect(decision).toMatchObject({ accepted: true, category: "Cafés & Snacks", source: "Historie", merchantAlias: "INTERSPAR" });
  });

  it("rejects model answers that contradict history or lack a rule", () => {
    const state = withOpen([history("s1", "SHELL", -4.23, "Cafés & Snacks")], [
      booking("snack", { description: "SHELL FURNITZ 8387", amount: -12.5 }),
      booking("flowers", { description: "BLUMEN B B FILNR902 VILLACH", amount: -34 }),
      booking("fuel", { description: "OMV 2595 2040OM2595 Villach", amount: -67 }),
      booking("dm", { description: "DM-FIL. A055 DM-FIL. A0 Villach", amount: -11.15 }),
    ]);
    const decide = (id: string, text: string, amount: number, category: string, merchant?: string) =>
      decideReviewWithEvidence(state, id, input(text, amount), answer(category, merchant));
    expect(decide("snack", "SHELL FURNITZ 8387", -12.5, "Tanken", "SHELL")).toMatchObject({ accepted: true, category: "Cafés & Snacks", source: "Historie" });
    // The flower-shop rule overrides the model's wrong guess.
    expect(decide("flowers", "BLUMEN B B FILNR902 VILLACH", -34, "Cafés & Snacks", "BLUMEN B B")).toMatchObject({ accepted: true, category: "Geschenke & Spenden", source: "Regel" });
    expect(decide("fuel", "OMV 2595 2040OM2595 Villach", -67, "Tanken", "OMV")).toMatchObject({ accepted: true, category: "Tanken", source: "Regel" });
    expect(decide("dm", "DM-FIL. A055 DM-FIL. A0 Villach", -11.15, "Drogerie", "dm")).toMatchObject({ accepted: true, category: "Drogerie" });
    // The fixed merchant rule decides on its own, whatever the model says.
    expect(decide("dm", "DM-FIL. A055 DM-FIL. A0 Villach", -11.15, "Shopping", "dm")).toMatchObject({ accepted: true, category: "Drogerie", source: "Regel" });
    expect(decideReviewWithEvidence(state, "dm", input("DM-FIL. A055 DM-FIL. A0 Villach", -11.15), undefined))
      .toMatchObject({ accepted: true, category: "Drogerie", source: "Regel" });
  });

  it("does not apply a rule the household contradicted or that does not fit", () => {
    const state = withOpen([history("t1", "DM", -60, "Gesundheit")], [
      booking("dm", { description: "DM-FIL. A055 Villach", amount: -5 }),
      booking("shell", { description: "SHELL 8387 VILLACH", amount: -6.4 }),
    ]);
    expect(decideReviewWithEvidence(state, "dm", input("DM-FIL. A055 Villach", -5), undefined)).toMatchObject({ accepted: false });
    expect(decideReviewWithEvidence(state, "shell", input("SHELL 8387 VILLACH", -6.4), undefined)).toMatchObject({ accepted: false });
  });

  it("reads the shop behind PayPal and Klarna", () => {
    expect(providerMerchant("PAYPAL *RENOVARO 06136922270")).toBe("Renovaro");
    expect(providerMerchant("PAYPAL *G2A COM LTD 4029357733")).toBe("G2A");
    expect(providerMerchant("PAYPAL *PAYPAL EEA 07517591951")).toBeUndefined();
    expect(providerMerchant("1051861566294/PAYPAL")).toBeUndefined();
    expect(plausibilityIssue({ ref: "b1", text: "PAYPAL *ETSY 4029357733", amount: -20, date: "2026-10-01", bank: "Amex" }, "Shopping", undefined))
      .toBeUndefined();
    const [etsy] = interpretCategorization(`[{"ref":"b1","category":"Shopping","merchant":"PayPal","confidence":99}]`,
      [{ ref: "b1", text: "PAYPAL *ETSY 4029357733", amount: -20, date: "2026-10-01", bank: "Amex" }], 90);
    expect(etsy).toMatchObject({ merchant: "Etsy", accepted: true });
  });

  it("books a merchant credit for an earlier purchase as its refund", () => {
    const purchase = { ...history("buy", "OBI", -19.51, "Wohnen & Haushalt"), date: "2026-08-20" };
    const state = withOpen([purchase], [booking("credit", { description: "OBI 4711 VILLACH", amount: 19.51, date: "2026-09-02" })]);
    expect(decideReviewWithEvidence(state, "credit", input("OBI 4711 VILLACH", 19.51), undefined))
      .toMatchObject({ accepted: true, category: "Rückerstattungen", source: "Erstattung", merchantAlias: "OBI" });
    const partial = withOpen([purchase], [booking("credit", { description: "OBI 4711 VILLACH", amount: 7, date: "2026-09-02" })]);
    expect(decideReviewWithEvidence(partial, "credit", input("OBI 4711 VILLACH", 7), undefined)).toMatchObject({ accepted: true, source: "Erstattung" });
    const larger = withOpen([purchase], [booking("credit", { description: "OBI 4711 VILLACH", amount: 25, date: "2026-09-02" })]);
    expect(decideReviewWithEvidence(larger, "credit", input("OBI 4711 VILLACH", 25), undefined)).toMatchObject({ accepted: false });
  });

  it("suggests a category for bookings it leaves open", () => {
    const state = withOpen([], [booking("shop", { description: "PAYPAL *NORDLICHT 4029357733", amount: -20 })]);
    const decision = decideReviewWithEvidence(state, "shop", input("PAYPAL *NORDLICHT 4029357733", -20),
      { ref: "b1", category: "Shopping", merchant: "Nordlicht", confidence: 80, accepted: false, reason: "Sicherheit 80 % < 90 %" });
    expect(decision).toMatchObject({ accepted: false, suggestion: { category: "Shopping", merchantAlias: "Nordlicht", source: "KI" } });
  });

  it("does not learn from open reviews or earlier AI decisions", () => {
    const state = withOpen([
      { ...history("ai1", "KANZIANUS AP", -10, "Freizeit"), aiAssigned: true },
      { ...history("ai2", "KANZIANUS AP", -11, "Freizeit"), aiAssigned: true },
    ], [booking("open", { description: "KANZIANUS AP 2372", amount: -10.95 })]);
    expect(decideReviewWithEvidence(state, "open", input("KANZIANUS AP 2372", -10.95), answer("Freizeit", "KANZIANUS AP")))
      .toMatchObject({ accepted: false });
  });

  it("does not call small station receipts fuel", () => {
    expect(plausibilityIssue({ ref: "b1", text: "OMV 2595 VILLACH 9500", amount: -8.17, date: "2026-10-01", bank: "Raiffeisen" }, "Tanken", "OMV"))
      .toBe("Betrag zu klein zum Tanken");
  });
});

describe("AI review application", () => {
  it("assigns eligible reviews like a manual choice and marks them", () => {
    const state = fixture([booking("first"), booking("second", { description: "Anderer Laden", amount: -5 })]);
    const candidates = aiReviewCandidates(state, new Set());
    expect(candidates.map((item) => item.reviewId).sort()).toEqual(["first", "second"]);
    const result = applyAiReviewDecisions(state, [{ reviewId: "first", category: "Shopping" }]);
    expect(result.applied).toEqual(["first"]);
    const row = result.state.transactions.find((item) => item.id === "first");
    expect(row).toMatchObject({ category: "Shopping", aiAssigned: true, manualCategory: true });
    expect(result.state.reviewQueue?.some((item) => item.id === "first")).toBe(false);
    expect(result.state.reviewQueue?.some((item) => item.id === "second")).toBe(true);
  });

  it("never turns an AI decision into a merchant rule for other bookings", () => {
    const state = fixture([
      booking("first", { description: "Testladen Nordlicht 4711" }),
      booking("twin", { description: "Testladen Nordlicht 4711", date: "2026-09-10", amount: -11 }),
    ]);
    const result = applyAiReviewDecisions(state, [{ reviewId: "first", category: "Shopping", merchantAlias: "Nordlicht" }]);
    expect(result.applied).toEqual(["first"]);
    expect(result.state.merchantRules ?? []).toEqual(state.merchantRules ?? []);
    expect(result.state.merchantNameRules ?? []).toEqual(state.merchantNameRules ?? []);
    expect(result.state.transactions.find((item) => item.id === "twin")?.category).toBe("Prüfen");
  });

  it("skips reviews that need user data", () => {
    const draft = booking("ocr");
    const item: ReviewItem = { kind: "booking", id: "ocr", draft, message: "OCR", importIssues: ["scan.jpeg: unklar"] };
    expect(isAiEligibleReview(item)).toBe(false);
    const state = { ...fixture([draft]), reviewQueue: [item] };
    expect(applyAiReviewDecisions(state, [{ reviewId: "ocr", category: "Shopping" }]).applied).toEqual([]);
    expect(applyAiReviewDecisions(state, [{ reviewId: "missing", category: "Shopping" }]).skipped).toEqual(["missing"]);
  });
});

describe("helpers", () => {
  it("keeps the model endpoint on loopback", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8000/v3")).toBe(true);
    expect(isLoopbackUrl("http://localhost:8000/v3")).toBe(true);
    expect(isLoopbackUrl("http://example.com/v3")).toBe(false);
  });

  it("builds safe logo file names", () => {
    expect(logoFileName("BILLA")).toBe("BILLA.png");
    expect(logoFileName("A/B: Shop")).toMatch(/\.png$/);
    expect(logoFileName("..")).toBeUndefined();
  });
});
