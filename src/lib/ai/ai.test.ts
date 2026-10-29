import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { queueLedgerReview } from "@/lib/import/review";
import { appStateSchema, type AppState, type ReviewItem, type Transaction } from "@/lib/types";
import { applyAiReviewDecisions } from "./apply-review-decisions";
import {
  cleanMerchantName, extractJsonArray, interpretCategorization, merchantMatchesText, plausibilityIssue, resolveCategoryName,
} from "./categorize";
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
