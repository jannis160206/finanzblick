import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { queueLedgerReview } from "@/lib/import/review";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { applyBulkReview, bulkReviewGroups } from "./bulk-review";

const booking = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-09-03", bank: "Raiffeisen", pocket: "Testkonto",
  description: "NORDLICHT LADEN 4711 WIEN", amount: -24, category: "Prüfen", includeInPlan: true, ...overrides,
});

function withOpen(open: Transaction[], extra: Partial<AppState> = {}): AppState {
  const state = queueLedgerReview(appStateSchema.parse({
    ...createSeed(), transactions: open.filter((row) => typeof row.amount === "number"), merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
    ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [],
  }));
  return {
    ...state, ...extra,
    reviewQueue: open.map((draft) => ({ kind: "booking" as const, id: draft.id, draft, message: "Händlerzuordnung unsicher – bitte prüfen." })),
  };
}

const open = [
  booking("a", { date: "2026-09-01" }),
  booking("b", { amount: -12.35, date: "2026-09-10", description: "Nordlicht Laden 0815 Graz" }),
  booking("c", { amount: -6, date: "2026-09-11", description: "NORDLICHT LADEN 99" }),
  booking("refund", { amount: 12 }),
  booking("other", { description: "Sonnenhof Café 12" }),
  booking("other2", { description: "Sonnenhof Café 13", date: "2026-09-04" }),
  booking("broken", { description: "Kaputt 1", amount: null as unknown as number }),
  booking("broken2", { description: "Kaputt 2", amount: null as unknown as number }),
];

describe("bulkReviewGroups", () => {
  it("groups open bookings by readable merchant and direction", () => {
    const groups = bulkReviewGroups(withOpen(open));
    expect(groups).toEqual([
      { key: "nordlicht laden|-1", label: "Nordlicht Laden", category: "Prüfen", ids: ["a", "b", "c"], count: 3, total: -42.35 },
      { key: "sonnenhof café|-1", label: "Sonnenhof Café", category: "Cafés & Snacks", ids: ["other", "other2"], count: 2, total: -48 },
    ]);
  });

  it("keeps one merchant together and proposes the most common non-Prüfen category", () => {
    const state = withOpen(open, {
      aiSuggestions: [
        { id: "a", category: "Shopping", reason: "x", source: "KI" },
        { id: "b", category: "Shopping", reason: "x", source: "KI" },
      ],
    });
    const groups = bulkReviewGroups(state);
    expect(groups.map((group) => [group.category, group.ids])).toEqual([
      ["Shopping", ["a", "b", "c"]],
      ["Cafés & Snacks", ["other", "other2"]],
    ]);
  });

  it("leaves reviews that need a re-upload out", () => {
    const state = withOpen(open, {
      importResults: [{ uploadId: "u1", fileName: "x.pdf", status: "partial", issues: [{ reviewId: "other", action: "reupload", message: "x" }] }],
    } as unknown as Partial<AppState>);
    expect(bulkReviewGroups(state).map((group) => group.label)).toEqual(["Nordlicht Laden"]);
  });
});

describe("applyBulkReview", () => {
  it("settles the selected reviews like the dialog's group save", () => {
    const state = withOpen(open);
    const result = applyBulkReview(state, ["a", "b", "c"], "Shopping");
    expect(result.applied).toEqual(["a", "b", "c"]);
    expect(result.skipped).toEqual([]);
    expect(result.state.reviewQueue?.map((item) => item.id)).not.toEqual(expect.arrayContaining(["a"]));
    const saved = result.state.transactions.filter((row) => ["a", "b", "c"].includes(row.id));
    expect(saved).toHaveLength(3);
    for (const row of saved) expect(row).toMatchObject({ category: "Shopping", categoryOverride: true, manualCategory: true, reviewed: true });
    expect(result.state.reviewQueue?.some((item) => ["a", "b", "c"].includes(item.id))).toBe(false);
  });

  it("uses the single-booking approval path for one review", () => {
    const result = applyBulkReview(withOpen(open), ["other"], "Restaurants");
    expect(result.applied).toEqual(["other"]);
    expect(result.state.transactions.find((row) => row.id === "other")).toMatchObject({ category: "Restaurants", reviewed: true });
  });

  it("skips unknown, ineligible and invalid ids and refuses 'Prüfen'", () => {
    const state = withOpen(open);
    const result = applyBulkReview(state, ["missing", "broken", "a"], "Shopping");
    expect(result.applied).toEqual(["a"]);
    expect(result.skipped).toEqual(["missing", "broken"]);
    expect(applyBulkReview(state, ["a"], "Prüfen")).toEqual({ state, applied: [], skipped: ["a"] });
    expect(applyBulkReview(state, ["missing"], "Shopping")).toEqual({ state, applied: [], skipped: ["missing"] });
  });
});
