import { describe, expect, it } from "vitest";
import { addMonthsToDate, detectContracts } from "@/lib/contracts";
import { currency } from "@/lib/format";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type AssistantOperation, type Transaction } from "@/lib/types";
import { applyOperations, OperationError, recordChange, undoChange } from "./operations";

const asOf = "2026-09-01";
let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"] = "Abonnements", extra: Partial<Transaction> = {}): Transaction => ({
  id: `t${++counter}`, date, bank: "Raiffeisen", pocket: "Testkonto", description, amount, category, includeInPlan: true, ...extra,
});
const stateWith = (transactions: Transaction[], extra: Partial<AppState> = {}): AppState => appStateSchema.parse({
  ...createSeed(), transactions, financeRows: [], merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
  ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [], ...extra,
});
const streamflix = () => [9.99, 9.99, 9.99].map((amount, index) => row(addMonthsToDate("2026-06-15", index), "Streamflix Abo", -amount));

// Applies, records, checks the stored state is valid, then undoes and expects the original data back.
function roundTrip(state: AppState, operations: AssistantOperation[]) {
  const applied = applyOperations(state, operations, { asOf, now: 1_800_000_000_000, id: () => "rule-1" });
  const recorded = recordChange(state, applied, { id: "log-1", at: 1_800_000_000_000, title: "Test" });
  expect(appStateSchema.safeParse(recorded).success).toBe(true);
  const undone = undoChange(recorded, "log-1");
  expect(appStateSchema.safeParse(undone).success).toBe(true);
  return { applied, recorded, undone };
}
const strip = (state: AppState) => ({ ...state, assistantChanges: undefined, contracts: state.contracts ?? [] });

describe("contract actions from the chat", () => {
  it("creates a manual contract like the wizard and removes it again on undo", () => {
    const state = stateWith([]);
    const { applied, undone } = roundTrip(state, [{ op: "contract_create", contractId: "manual:abc12345", name: "Fitness Park", category: "Sport & Fitness",
      amount: 39.9, interval: "monthly", nextDate: "2026-10-01", notice: { value: 1, unit: "months" }, termEnd: "2027-03-31" }]);
    expect(applied.state.contracts).toEqual([expect.objectContaining({ id: "manual:abc12345", manual: true, status: "confirmed", name: "Fitness Park",
      autoRenew: true, renewalMonths: 12 })]);
    expect(detectContracts(applied.state, asOf)).toEqual([expect.objectContaining({ name: "Fitness Park", source: "manual", status: "active", monthly: 39.9 })]);
    expect(applied.diffs.map((diff) => diff.label)).toEqual(["Neuer Vertrag", "Fitness Park: nächste Abbuchung", "Fitness Park: Kategorie",
      "Fitness Park: Kündigungsfrist", "Fitness Park: Mindestlaufzeit bis"]);
    expect(undone.contracts).toEqual([]);
  });

  it("confirms, edits, cancels, reactivates and hides a detected contract", () => {
    const state = stateWith(streamflix());
    const [contract] = detectContracts(state, asOf);
    expect(contract.status).toBe("review");
    const confirmed = applyOperations(state, [{ op: "contract_action", contractId: contract.id, action: "confirm" }], { asOf }).state;
    expect(detectContracts(confirmed, asOf)[0].status).toBe("active");
    expect(confirmed.contracts?.[0].snapshot).toBeDefined();
    expect(() => applyOperations(confirmed, [{ op: "contract_action", contractId: contract.id, action: "confirm" }], { asOf })).toThrow(/schon bestätigt/);

    // Editing a suggestion confirms it, like saving in the wizard.
    const edited = roundTrip(state, [{ op: "contract_update", contractId: contract.id, amount: 12.99, notice: { value: 14, unit: "days" } }]);
    expect(edited.applied.diffs.map((diff) => `${diff.label}: ${diff.after}`)).toEqual([`Streamflix Abo: Betrag: ${currency(12.99)}`, "Streamflix Abo: Kündigungsfrist: 14 Tage",
      "Streamflix Abo: Status: bestätigt"]);
    expect(detectContracts(edited.applied.state, asOf)[0]).toMatchObject({ amount: 12.99, status: "active", edited: true });
    expect(strip(edited.undone)).toEqual(strip(state));

    const cancelled = applyOperations(confirmed, [{ op: "contract_action", contractId: contract.id, action: "cancel", date: "2026-10-15" }], { asOf }).state;
    expect(detectContracts(cancelled, asOf)[0]).toMatchObject({ status: "cancelled", cancelledAt: "2026-10-15" });
    const back = applyOperations(cancelled, [{ op: "contract_action", contractId: contract.id, action: "reactivate" }], { asOf }).state;
    expect(detectContracts(back, asOf)[0]).toMatchObject({ status: "active" });
    expect(detectContracts(back, asOf)[0].cancelledAt).toBeUndefined();

    const hidden = applyOperations(state, [{ op: "contract_action", contractId: contract.id, action: "ignore" }], { asOf }).state;
    expect(detectContracts(hidden, asOf)[0].status).toBe("ignored");
    expect(detectContracts(applyOperations(hidden, [{ op: "contract_action", contractId: contract.id, action: "restore" }], { asOf }).state, asOf)[0].status).toBe("review");
    // Only own contracts can be removed; detected ones are hidden instead.
    expect(() => applyOperations(state, [{ op: "contract_action", contractId: contract.id, action: "remove" }], { asOf })).toThrow(OperationError);
  });

  it("discards own edits", () => {
    const state = stateWith(streamflix());
    const [contract] = detectContracts(state, asOf);
    const edited = applyOperations(state, [{ op: "contract_update", contractId: contract.id, name: "Streamflix" }], { asOf }).state;
    const reset = applyOperations(edited, [{ op: "contract_action", contractId: contract.id, action: "reset" }], { asOf }).state;
    expect(detectContracts(reset, asOf)[0]).toMatchObject({ name: "Streamflix Abo", edited: false });
  });
});

describe("booking actions from the chat", () => {
  it("deletes bookings with their receipts and restores both on undo", () => {
    const keep = row("2026-08-02", "BILLA", -20, "Lebensmittel");
    const gone = row("2026-08-03", "MEDIAMARKT", -249, "Shopping");
    const state = stateWith([keep, gone]);
    const { applied, undone } = roundTrip(state, [{ op: "transaction_delete", ids: [gone.id] }]);
    expect(applied.state.transactions.map((item) => item.id)).toEqual([keep.id]);
    expect(applied.diffs).toEqual([{ label: "3.8.2026 · MEDIAMARKT", before: currency(-249), after: "gelöscht" }]);
    expect(undone.transactions.map((item) => item.id).sort()).toEqual([keep.id, gone.id].sort());
  });

  it("tags bookings and removes only the tag again on undo", () => {
    const trip = [row("2026-08-10", "Hotel Malaga", -300, "Urlaub"), row("2026-08-11", "Tapas Bar", -40, "Restaurants", { tags: ["Urlaub"] })];
    const state = stateWith(trip);
    const { applied, undone } = roundTrip(state, [{ op: "transaction_tag", ids: trip.map((item) => item.id), tag: "Malaga 2026" }]);
    expect(applied.state.transactions.map((item) => item.tags)).toEqual([["Malaga 2026"], ["Urlaub", "Malaga 2026"]]);
    expect(undone.transactions.map((item) => item.tags)).toEqual([undefined, ["Urlaub"]]);
    expect(() => applyOperations(state, [{ op: "transaction_tag", ids: [trip[0].id], tag: "Malaga 2026", remove: true }], { asOf })).toThrow(/hat den Tag/);
  });
});

describe("plan, account and payroll actions from the chat", () => {
  it("adds, edits, fills and deletes a month-plan position like the dialogs", () => {
    const state = stateWith([]);
    const created = roundTrip(state, [{ op: "plan_row_save", rowId: "row-1", create: true, label: "Fitnessstudio", kind: "fixed", planCategory: "Sport & Fitness" },
      { op: "plan_value", rowId: "row-1", months: ["2026-10"], value: 39.9 }]);
    expect(created.applied.state.financeRows).toEqual([expect.objectContaining({ id: "row-1", label: "Fitnessstudio", kind: "fixed", planCategory: "Sport & Fitness", values: { "2026-10": 39.9 } })]);
    expect(created.undone.financeRows).toEqual([]);
    const renamed = applyOperations(created.applied.state, [{ op: "plan_row_save", rowId: "row-1", label: "Fitness Park", kind: "income" }], { asOf });
    expect(renamed.diffs.map((diff) => diff.after)).toEqual(["Fitness Park", "Einnahme"]);
    // Like the position dialog: income or fixed costs; the variable budgets are the app's own lines.
    expect(() => applyOperations(created.applied.state, [{ op: "plan_row_save", rowId: "row-1", kind: "variable" }], { asOf })).toThrow(/Einnahme oder Fixkosten/);
    const removed = roundTrip(renamed.state, [{ op: "plan_row_delete", rowId: "row-1" }]);
    expect(removed.applied.state.financeRows).toEqual([]);
    expect(removed.undone.financeRows).toEqual(renamed.state.financeRows);
    expect(() => applyOperations(state, [{ op: "plan_row_save", rowId: "x", create: true }], { asOf })).toThrow(/Bezeichnung/);
  });

  it("stores account rules with confirmation and the successbonus percent", () => {
    const state = stateWith([]);
    const rule = roundTrip(state, [{ op: "account_rule", account: "Sparkonto", use: "any", purposes: [] }]);
    expect(rule.applied.state.accountRules).toEqual([expect.objectContaining({ account: "Sparkonto", use: "any" })]);
    expect(rule.applied.diffs).toEqual([{ label: "Konto Sparkonto", before: "keine Regel", after: "für alle Ausgaben" }]);
    expect(rule.undone.accountRules).toEqual([]);
    const bonus = roundTrip(state, [{ op: "bonus_percent", value: 120 }]);
    expect(bonus.applied.state.settings.successBonusPercent).toBe(120);
    expect(bonus.undone.settings.successBonusPercent).toBe(state.settings.successBonusPercent);
  });
});
