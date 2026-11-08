import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import type { AppState, Transaction } from "@/lib/types";
import { amexQuestion, balanceQuestion, budgetQuestion } from "./accounts";
import { executeTool } from "./agent";
import { answerQuestion, findBank, findMerchant, parseDateRange, parsePeriod } from "./answers";
import { assistantFacts } from "./facts";
import { detectTool } from "./tools";

const asOf = "2026-11-05";
const row = (id: string, date: string, bank: string, description: string, amount: number, category: Transaction["category"] = "Shopping"): Transaction =>
  ({ id, date, bank, pocket: bank === "Amex" ? "AMEX Jannis" : "Raiffeisen Giro", description, amount, category, includeInPlan: true, ...(bank === "Amex" ? { amexPeriodStart: "2026-10-11" } : {}) });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.transactions = [
    row("a1", "2026-10-09", "Amex", "ALTER EINKAUF", -99),
    row("a2", "2026-10-12", "Amex", "AMAZON", -120),
    row("a3", "2026-10-20", "Amex", "BILLA", -30, "Lebensmittel"),
    row("a4", "2026-11-02", "Amex", "AMAZON GUTSCHRIFT", 20),
    row("r1", "2026-10-15", "Raiffeisen", "SPAR", -40, "Lebensmittel"),
  ];
  return state;
}
const context = (state: AppState) => ({ state, dashboard: calculateDashboard(state), asOf });

describe("date ranges", () => {
  it("reads explicit day ranges in many spellings", () => {
    expect(parseDateRange("seit 11.10.", asOf)).toMatchObject({ from: "2026-10-11", to: asOf, label: "seit 11.10." });
    expect(parseDateRange("ab dem 11.10 bis heute", asOf)).toMatchObject({ from: "2026-10-11", to: asOf });
    expect(parseDateRange("von 11.10-aktuell mit amex", asOf)).toMatchObject({ from: "2026-10-11", to: asOf });
    expect(parseDateRange("vom 1.10. bis 15.10.", asOf)).toMatchObject({ from: "2026-10-01", to: "2026-10-15", label: "1.10.–15.10." });
    expect(parseDateRange("seit 11.10.2025", asOf)).toMatchObject({ from: "2025-10-11" });
    // A day later this year lies in the future, so last year is meant.
    expect(parseDateRange("seit 24.12.", asOf)).toMatchObject({ from: "2025-12-24" });
    expect(parseDateRange("Ich zahle 12,50 € im Oktober", asOf)).toBeUndefined();
    expect(parsePeriod("seit 11.10.", asOf)).toMatchObject({ from: "2026-10-11", to: asOf });
  });
});

describe("account and card questions", () => {
  it("routes Amex, balances and the monthly plan", () => {
    for (const text of ["Was muss ich bei Amex noch auf das Amex Rückzahlungskonto überweisen",
      "Du siehst ja wie viel von 11.10-aktuell mit amex bezahlt wurde, wie viel muss ich noch auf amex rückzahlung überweisen?",
      "wie viel ist bei amex offen", "Wie viel kostet AMEX?", "reicht das geld für die kreditkartenabrechnung"])
      expect(detectTool(text), text).toBe("amex");
    for (const text of ["Zeig mir meine Kontostände", "wie viel ist am notgroschen", "Wie viel Vermögen hab ich?", "wie viel geld hab ich"])
      expect(detectTool(text), text).toBe("accounts");
    for (const text of ["Was bleibt mir diesen Monat?", "wie viel kann ich im dezember noch ausgeben", "was bleibt übrig", "Monatsplan"])
      expect(detectTool(text), text).toBe("budget");
    expect(detectTool("Was habe ich seit 11.10. mit Amex bezahlt?")).toBe("query");
    expect(detectTool("Kann ich mir im Mai einen Fernseher um 900 € leisten?")).toBe("affordability");
    expect(amexQuestion("amex")).toBe(false);
    expect(balanceQuestion("wie viel hab ich im oktober ausgegeben")).toBe(false);
    expect(budgetQuestion("wie viel hab ich im oktober ausgegeben")).toBe(false);
  });

  it("treats banks as the paying account, never as a merchant", () => {
    const state = fixture();
    expect(findBank("mit Amex bezahlt")?.label).toBe("Amex");
    expect(findMerchant(state, "was hab ich mit amex bezahlt")).toBeUndefined();
    const answer = answerQuestion(state, "Was habe ich seit 11.10. mit Amex bezahlt?", asOf, { category: "Abonnements", merchant: "AMEX" });
    expect(answer.card.title).toBe("Amex · seit 11.10.");
    expect(answer.card.total).toBe(150);
    expect(answer.card.transactionIds).toEqual(["a2", "a3"]);
  });

  it("settles the Amex bill with the dashboard numbers", () => {
    const ctx = context(fixture());
    const result = executeTool("amex", "seit 11.10. mit amex, wie viel muss ich auf amex rückzahlung überweisen", ctx);
    expect(result.card?.title).toBe("Amex-Abrechnung");
    expect(result.card?.total).toBe(ctx.dashboard.amex.shortfall);
    expect(result.card?.lines.find((line) => line.label === "Offen bei Amex")?.value).toBe(ctx.dashboard.amex.outstanding);
    expect(result.card?.lines.find((line) => line.label.startsWith("Amex-Buchungen"))?.value).toBe(130);
  });

  it("shows balances and the month plan from the dashboard", () => {
    const ctx = context(fixture());
    expect(executeTool("accounts", "meine kontostände", ctx).card?.total).toBe(ctx.dashboard.totalAssets);
    const budget = executeTool("budget", "was bleibt mir diesen monat", ctx);
    expect(budget.card?.total).toBe(ctx.dashboard.current.surplus);
    expect(budget.card?.month).toBe(ctx.dashboard.currentMonth);
  });

  it("shows bank balances of giro and main accounts with their date", () => {
    const state = fixture();
    state.accountSnapshots = [
      { bank: "Raiffeisen", name: "Raiffeisen Giro", date: "2026-11-01", balance: 500 },
      { bank: "Raiffeisen", name: "Raiffeisen Giro", date: "2026-11-04", balance: 697.71 },
    ];
    const ctx = context(state);
    const giro = executeTool("accounts", "meine kontostände", ctx).card?.lines.find((line) => line.label === "Raiffeisen Giro");
    expect(giro).toMatchObject({ value: 697.71, detail: expect.stringContaining("Kontostand vom") });
    state.accountSnapshots.push({ bank: "Revolut", name: "Persönliches Konto", date: "2026-11-04", balance: 0 });
    for (const question of ["Wie hoch ist mein kontostand?", "Zeig mir alle Kontostände"]) {
      const overview = executeTool("accounts", question, context(state));
      expect(overview.card?.title, question).toBe("Kontostände");
      expect(overview.card?.total).toBe(Math.round((ctx.dashboard.totalAssets + 697.71) * 100) / 100);
      expect(overview.card?.lines[0]).toMatchObject({ label: "Raiffeisen Giro" });
      expect(overview.text).toContain("Raiffeisen Giro");
    }
    expect(executeTool("accounts", "wie viel liegt auf persönliches konto", context(state)).card?.title).toBe("Kontostand · Persönliches Konto");
    expect(assistantFacts(ctx.state, ctx.dashboard, asOf).balances).toContainEqual({ name: "Raiffeisen Giro", bank: "Raiffeisen", amount: 697.71, asOf: "2026-11-04" });
    // Empty accounts stay in the facts, so "Wieso ist Revolut auf 0?" can be answered.
    expect(assistantFacts(ctx.state, ctx.dashboard, asOf).balances).toContainEqual({ name: "Persönliches Konto", bank: "Revolut", amount: 0, asOf: "2026-11-04" });
  });

  it("builds compact facts for free questions", () => {
    const ctx = context(fixture());
    const facts = assistantFacts(ctx.state, ctx.dashboard, asOf);
    expect(facts.amex.stillToTransfer).toBe(ctx.dashboard.amex.shortfall);
    expect(facts.spendingByMonthAndCategory["2026-10"]?.Lebensmittel).toBe(70);
    expect(JSON.stringify(facts).length).toBeLessThan(60_000);
  });
});
