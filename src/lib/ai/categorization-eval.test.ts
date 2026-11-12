import { describe, expect, it } from "vitest";
import { MerchantIndex } from "@/lib/automation/merchants";
import { merchantRuleKey } from "@/lib/import/merchant-rules";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import {
  applyLabelOverrides,
  compareCategorization,
  evaluationLabels,
  importSource,
  joinOutcomes,
  reviewWithModel,
  simulateMonth,
  summarizeCategorization,
  trainingState,
  type EvalRecord,
} from "./categorization-eval";

const row = (id: string, date: string, description: string, patch: Partial<Transaction> = {}): Transaction => ({
  id, date, description, bank: "Raiffeisen", pocket: "Testkonto", amount: -24, category: "Prüfen", includeInPlan: true, ...patch,
});
const chosen = { categoryOverride: true, manualCategory: true, reviewed: true } as const;
const fixture = (transactions: Transaction[], extra: Partial<AppState> = {}): AppState => appStateSchema.parse({
  ...createSeed(), transactions, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [], ignoredStatementKeys: [],
  pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [], ...extra,
});
const workshop = "NORDLICHT WERKSTATT";
const ruleKey = merchantRuleKey({ bank: "Raiffeisen", description: workshop });
const ledger = fixture([
  row("jan", "2026-01-12", workshop, { ...chosen, category: "Fahrzeugwartung", amount: -80 }),
  row("feb-rule", "2026-02-03", workshop, { category: "Fahrzeugwartung", categoryOverride: true, amount: -95 }),
  row("feb-new", "2026-02-09", "UNBEKANNT 77", { ...chosen, category: "Sonstiges" }),
  row("feb-ai", "2026-02-11", "IRGENDWAS 12", { ...chosen, aiAssigned: true, category: "Shopping" }),
], { merchantRules: [{ key: ruleKey, category: "Fahrzeugwartung", merchantAlias: "Nordlicht" }] });
const index = new MerchantIndex([]);

describe("categorization replay", () => {
  it("imports only what a statement delivers", () => {
    const source = importSource({ ...ledger.transactions[0], merchantAlias: "Nordlicht", rawDescription: `POS ${workshop}` });
    expect(source).toMatchObject({ id: "jan", category: "Prüfen", description: `POS ${workshop}` });
    expect(source).not.toHaveProperty("manualCategory");
    expect(source).not.toHaveProperty("merchantAlias");
  });

  it("tells the user's own choices from rules, AI decisions and automatic ones", () => {
    const labels = evaluationLabels(ledger);
    expect(Object.fromEntries([...labels].map(([id, label]) => [id, label.strength]))).toEqual({
      jan: "confirmed", "feb-rule": "rule", "feb-new": "confirmed", "feb-ai": "ai",
    });
    const corrected = applyLabelOverrides(labels, { "feb-ai": "Freizeit", "feb-new": "exclude" });
    expect(corrected.get("feb-ai")).toEqual({ category: "Freizeit", strength: "confirmed" });
    expect(corrected.has("feb-new")).toBe(false);
  });

  it("knows a rule only once the user chose a category for its merchant", () => {
    expect(trainingState(ledger, "2026-01-01").merchantRules).toEqual([]);
    expect(trainingState(ledger, "2026-02-01")).toMatchObject({
      transactions: [expect.objectContaining({ id: "jan" })], merchantRules: [expect.objectContaining({ key: ruleKey })],
    });
  });

  it("replays a month like an import and scores it against the labels", () => {
    const simulation = simulateMonth(ledger, "2026-02", index);
    const records = joinOutcomes(ledger, evaluationLabels(ledger), simulation.outcomes);
    expect(records.find((record) => record.id === "feb-rule")).toMatchObject({ status: "decided", correct: true });
    expect(records.find((record) => record.id === "feb-new")).toMatchObject({ status: "open", correct: false });
    const summary = summarizeCategorization(records);
    expect(summary.all).toMatchObject({ total: 3, correct: 1, open: 2, wrong: 0, precision: 1 });
  });

  it("counts the model's answer only when evidence backs it", async () => {
    const simulation = simulateMonth(ledger, "2026-02", index);
    const outcomes = await reviewWithModel(simulation, async (inputs) =>
      inputs.map((input) => ({ ref: input.ref, category: "Shopping" as const, confidence: 95, accepted: true })));
    expect(outcomes.find((outcome) => outcome.id === "feb-new")).toMatchObject({ status: "open", modelAnswer: "Shopping" });
    const summary = summarizeCategorization(joinOutcomes(ledger, evaluationLabels(ledger), outcomes));
    expect(summary.model).toMatchObject({ asked: 2, answered: 2, correct: 1 });
  });

  it("keeps holiday bookings out of the headline and reports regressions per booking", () => {
    const record = (id: string, patch: Partial<EvalRecord>): EvalRecord => ({
      id, month: "2026-02", status: "decided", predicted: "Lebensmittel", label: "Lebensmittel", strength: "confirmed",
      bank: "Raiffeisen", sign: "out", transfer: false, holiday: false, correct: true, ...patch,
    });
    const before = [record("a", {}), record("b", { status: "open", predicted: undefined, correct: false }), record("c", {})];
    const after = [
      record("a", { predicted: "Shopping", correct: false }),
      record("b", {}),
      record("c", { status: "open", predicted: undefined, correct: false, holiday: true }),
    ];
    expect(compareCategorization(before, after)).toMatchObject({ regressions: ["a"], fixes: ["b"], lostCoverage: ["c"] });
    const summary = summarizeCategorization(after);
    expect(summary.holiday.total).toBe(1);
    expect(summary.all).toMatchObject({ total: 2, wrong: 1, correct: 1 });
  });
});
