import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { actualPockets, calculateMonthTotals, classify, variableBudgetGroup } from "@/lib/calc";
import { detectDuplicateCharges, detectSubscriptions, summarizeMonth } from "@/lib/insights";
import { applyOperations, undoChange, recordChange } from "@/lib/assistant/operations";
import { bookingEdit, bookingRequest } from "@/lib/assistant/bookings";
import { shouldShowMerchantMark } from "@/lib/merchant-mark-policy";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { createEmptyAccountState } from "@/lib/account-state";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { setBookingsIgnored } from "./ignored-bookings";

let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"], extra: Partial<Transaction> = {}): Transaction => ({
  id: `i${++counter}`, date, bank: "Raiffeisen", pocket: "Testkonto", description, amount, category, includeInPlan: true, ...extra,
});
const stateWith = (transactions: Transaction[]): AppState => {
  const seed = createSeed();
  return appStateSchema.parse({
    ...seed, settings: { ...seed.settings, asOf: "2026-09-20" }, transactions, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
    ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [],
  });
};

describe("ignored bookings", () => {
  const groceries = row("2026-09-05", "Supermarkt Nord", -40, "Lebensmittel");
  const gadget = row("2026-09-06", "Elektro Shop 7", -900, "Shopping");
  const saving = row("2026-09-07", "Einzahlung Sparkonto", -100, "Transfer", { pocket: "Sparkonto" });

  it("drops ignored bookings from spending, budgets and insights but keeps balances", () => {
    const state = stateWith([groceries, gadget, saving]);
    const ignored = setBookingsIgnored(state, [gadget.id, saving.id], true);
    const plan = { currentMonth: "2026-09" };
    expect(calculateMonthTotals(state, "2026-09", plan).actualSpending - calculateMonthTotals(ignored, "2026-09", plan).actualSpending).toBe(900);
    const stored = ignored.transactions.find((item) => item.id === gadget.id)!;
    expect(stored.ignored).toBe(true);
    expect(classify(stored)).toMatchObject({ category: "Shopping", isTransfer: true, includeInPlan: false, ignored: true });
    expect(variableBudgetGroup(stored, "2026-09", "2026-09-20")).toBeUndefined();
    expect(summarizeMonth(ignored, "2026-09").spending).toBe(40);
    expect(actualPockets(ignored)).toEqual(actualPockets(state));
    expect(shouldShowMerchantMark(stored, classify(stored))).toBe(shouldShowMerchantMark(gadget, classify(gadget)));

    const restored = setBookingsIgnored(ignored, [gadget.id], false);
    expect(restored.transactions.find((item) => item.id === gadget.id)).not.toHaveProperty("ignored");
    expect(summarizeMonth(restored, "2026-09").spending).toBe(940);
  });

  it("removes ignored charges from subscription and duplicate detection", () => {
    const abo = ["05", "06", "07", "08"].map((month) => row(`2026-${month}-15`, "Streamflix Abo", -9.99, "Abonnements"));
    const twice = [row("2026-08-01", "Elektro Shop 1", -89.9, "Shopping"), row("2026-08-02", "Elektro Shop 1", -89.9, "Shopping")];
    const state = stateWith([...abo, ...twice]);
    expect(detectSubscriptions(state, "2026-09-01")).toHaveLength(1);
    expect(detectDuplicateCharges(state)).toHaveLength(1);
    const ignored = setBookingsIgnored(state, [...abo, twice[1]].map((item) => item.id), true);
    expect(detectSubscriptions(ignored, "2026-09-01")).toHaveLength(0);
    expect(detectDuplicateCharges(ignored)).toHaveLength(0);
  });

  it("drops the open ledger review of a booking once it is ignored", () => {
    const open = row("2026-09-08", "Unklarer Händler", -12, "Prüfen", { includeInPlan: false });
    const state = { ...stateWith([open]), reviewQueue: [{ kind: "booking" as const, id: "r1", draft: open, message: "Kategorie offen" }] };
    expect(setBookingsIgnored(state, [open.id], true).reviewQueue).toEqual([]);
  });

  it("lets the agent ignore and restore bookings with undo", () => {
    const state = stateWith([groceries, gadget]);
    expect(bookingRequest("Ignorier die Buchung vom 6.9. bei Elektro Shop", false)).toBe(true);
    expect(bookingRequest("Nimm Netflix im Plan ignorieren", false)).toBe(true);
    const plan = bookingEdit(state, "Ignorier die Buchung vom 6.9.", "2026-09-20");
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.operations).toEqual([{ op: "transaction_update", ids: [gadget.id], ignored: true }]);
    const applied = applyOperations(state, plan.operations);
    expect(applied.state.transactions.find((item) => item.id === gadget.id)?.ignored).toBe(true);
    const logged = recordChange(applied.state, applied, { id: "c1", at: 1, title: plan.title });
    expect(undoChange(logged, "c1").transactions.find((item) => item.id === gadget.id)).not.toHaveProperty("ignored");
    const back = bookingEdit(applied.state, "Elektro Shop wieder berücksichtigen", "2026-09-20");
    if (typeof back === "string") throw new Error(back);
    expect(back.operations[0]).toMatchObject({ op: "transaction_update", ignored: false });
  });

  it("round-trips the ignored flag through the Excel backup", async () => {
    const state = createEmptyAccountState();
    state.transactions = [row("2026-09-05", "Supermarkt Nord", -40, "Lebensmittel", { ignored: true }), row("2026-09-06", "Bäckerei", -4, "Lebensmittel")];
    const restored = await parseWorkbook(await exportWorkbook(state));
    expect(restored.state.transactions.map((item) => !!item.ignored)).toEqual([true, false]);
  });
});
