import { describe, expect, it } from "vitest";
import { calculateDashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { detectNotificationEvents } from "./notifications";

let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"], extra: Partial<Transaction> = {}): Transaction => ({
  id: `n${++counter}`, date, bank: "Raiffeisen", pocket: "Testkonto", description, amount, category, includeInPlan: true, ...extra,
});
const stateWith = (transactions: Transaction[]): AppState => {
  const seed = createSeed();
  return appStateSchema.parse({
    ...seed, settings: { ...seed.settings, asOf: "2026-09-20" }, transactions, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
    ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [],
  });
};
const detect = (state: AppState, extra: Partial<{ largeDebitThreshold: number; sinceDate: string }> = {}) =>
  detectNotificationEvents(state, calculateDashboard(state), {
    asOf: state.settings.asOf, largeDebitThreshold: 200, sinceDate: "2026-09-01", ...extra,
  });

describe("notification events", () => {
  it("reports a variable budget overrun in the current month with a stable id", () => {
    const state = stateWith([
      row("2026-09-05", "Supermarkt Nord", -180, "Lebensmittel"),
      row("2026-09-12", "Supermarkt Süd", -120, "Lebensmittel"),
    ]);
    const events = detect(state, { largeDebitThreshold: 1000 });
    const budget = events.find((event) => event.id === "budget:2026-09:food");
    expect(budget).toMatchObject({ title: "Budget überschritten: Lebensmittel & Haushalt", url: "/umsaetze?month=2026-09&group=food" });
    expect(budget?.body).toMatch(/300,00\s€ von 250,00\s€/);
    expect(detect(state, { largeDebitThreshold: 1000 }).map((event) => event.id)).toEqual(events.map((event) => event.id));
  });

  it("does not report budgets that are still within the plan", () => {
    const events = detect(stateWith([row("2026-09-05", "Supermarkt Nord", -40, "Lebensmittel")]));
    expect(events.filter((event) => event.id.startsWith("budget:"))).toEqual([]);
  });

  it("reports large debits since the given date but skips transfers, ignored and older bookings", () => {
    const gadget = row("2026-09-06", "Elektro Shop 7", -250, "Shopping");
    const ignored = row("2026-09-07", "Elektro Shop 8", -900, "Shopping", { ignored: true });
    const transfer = row("2026-09-08", "Einzahlung Sparkonto", -500, "Transfer", { pocket: "Sparkonto" });
    const old = row("2026-08-28", "Elektro Shop 9", -700, "Shopping");
    const small = row("2026-09-09", "Kaffee", -199.99, "Cafés & Snacks");
    const future = row("2026-09-25", "Elektro Shop 10", -400, "Shopping");
    const events = detect(stateWith([gadget, ignored, transfer, old, small, future]));
    const debits = events.filter((event) => event.id.startsWith("debit:"));
    expect(debits.map((event) => event.id)).toEqual([`debit:${gadget.id}`]);
    expect(debits[0].title).toMatch(/^Große Abbuchung: 250,00\s€$/);
    expect(debits[0].url).toBe("/umsaetze?month=2026-09");
  });

  it("reports the salary of the current month once", () => {
    const salary = row("2026-09-02", "Arbeitgeber GmbH Gehalt 9/2026", 2500, "Gehalt", { includeInPlan: false, sourceCategory: "Gehalt" });
    const events = detect(stateWith([salary]));
    const event = events.find((item) => item.id === "salary:2026-09");
    expect(event).toMatchObject({ title: "Gehalt eingegangen", url: "/" });
    expect(event?.body).toMatch(/2\.500,00\s€/);
    expect(events.filter((item) => item.id.startsWith("salary:"))).toHaveLength(1);
  });

  it("returns nothing without relevant bookings", () => {
    expect(detect(stateWith([]))).toEqual([]);
  });
});
