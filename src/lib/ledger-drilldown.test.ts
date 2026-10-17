import { describe, expect, it } from "vitest";
import { actualBookings, calculateDashboard, round, variableBudgetGroup } from "@/lib/calc";
import { ledgerHref, parseLedgerLink } from "@/lib/ledger-link";
import { personalAmount } from "@/lib/shared-holiday";
import { createSeed } from "@/lib/seed";
import type { Transaction } from "@/lib/types";

const params = (query: string) => new URLSearchParams(query);

describe("ledger link parsing", () => {
  it("reads a valid month and budget group", () => {
    expect(parseLedgerLink(params("month=2026-10&group=food"))).toEqual({ month: "2026-10", group: "food" });
  });
  it("maps month=all to all months", () => {
    expect(parseLedgerLink(params("month=all"))).toEqual({ month: "" });
  });
  it.each(["month=2026-13", "month=abc", "month=2026-1", "month=<script>", "group=unknown", "group=__proto__", "group=", "q=suche"])(
    "ignores invalid parameter %s",
    (query) => expect(parseLedgerLink(params(query))).toEqual({}),
  );
  it("builds hrefs without search text", () => {
    expect(ledgerHref({ month: "2026-10", group: "food" })).toBe("/umsaetze?month=2026-10&group=food");
    expect(ledgerHref({ month: "" })).toBe("/umsaetze?month=all");
    expect(ledgerHref()).toBe("/umsaetze");
  });
  it("round-trips", () => {
    const link = { month: "2026-09", group: "going-out" as const };
    expect(parseLedgerLink(new URL(ledgerHref(link), "http://x").searchParams)).toEqual(link);
  });
});

describe("budget group drilldown", () => {
  const row = (id: string, patch: Partial<Transaction>): Transaction => ({
    id, date: "2026-09-10", description: "Test", amount: -10, bank: "Revolut", pocket: null,
    category: "Lebensmittel", categoryOverride: true, includeInPlan: true, reviewed: true, ...patch,
  });
  const state = createSeed();
  state.settings.asOf = "2026-09-16";
  state.settings.baselineDate = "2026-01-01";
  state.transactions = [
    row("a", { amount: -12.34 }),
    row("b", { amount: -7.66, date: "2026-09-15" }),
    row("c", { category: "Restaurants", amount: -30 }),
    row("d", { amount: -99, date: "2026-08-30" }),
    row("e", { amount: -50, date: "2026-09-20" }),
    row("f", { amount: -20, includeInPlan: false }),
    row("g", { category: "Gehalt", amount: 2000 }),
    row("h", { category: "Shopping", amount: -15 }),
  ];
  const dashboard = calculateDashboard(state);
  const bookings = actualBookings(state);

  it("lists exactly the bookings that make up each card's actual", () => {
    for (const card of dashboard.plan.rows) {
      const ids = bookings.filter((b) => variableBudgetGroup(b, "2026-09", state.settings.asOf) === card.id);
      expect(round(ids.reduce((total, b) => total - personalAmount(b), 0))).toBe(card.actual);
    }
  });

  it("food contains only current, planned food bookings up to the cut-off date", () => {
    const ids = bookings
      .filter((b) => variableBudgetGroup(b, "2026-09", state.settings.asOf) === "food")
      .map((b) => b.id).sort();
    expect(ids).toEqual(["a", "b"]);
    expect(dashboard.plan.rows.find((card) => card.id === "food")?.actual).toBe(20);
  });
});
