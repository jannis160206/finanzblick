import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard, monthsForYear } from "@/lib/calc";
import type { AppState, Transaction } from "@/lib/types";
import { monthlyVariableBudget } from "@/lib/variable-budgets";
import { executeTool } from "./agent";
import { monthReview, netWorthAnswer, refundAnswer, reviewMonth, securityCheck, sharedAnswer } from "./essentials";
import { detectTool } from "./tools";

const asOf = "2026-11-08";
const booking = (id: string, date: string, description: string, amount: number, category: Transaction["category"] = "Lebensmittel"): Transaction =>
  ({ id, date, bank: "Raiffeisen", pocket: "Raiffeisen Giro", description, amount, category, includeInPlan: true });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.settings.baselineDate = "2026-09-11";
  state.financeRows = [{ id: "salary", label: "Gehalt", kind: "income", values:
    Object.fromEntries([...monthsForYear(2026), ...monthsForYear(2027)].map((month) => [month, monthlyVariableBudget(month).total + 1000])) }];
  state.transactions = [
    booking("spar-sep", "2026-09-15", "SPAR DANKT 1234", -60),
    booking("spar-oct", "2026-10-04", "SPAR DANKT 1234", -80),
    booking("spar-oct-2", "2026-10-20", "SPAR DANKT 1234", -40),
    booking("amazon-buy", "2026-10-10", "AMAZON EU SARL", -55.38, "Shopping"),
    booking("amazon-back", "2026-10-24", "AMAZON EU SARL", 55.38, "Shopping"),
    booking("netflix-1", "2026-11-02", "NETFLIX.COM", -13.99, "Abonnements"),
    booking("netflix-2", "2026-11-02", "NETFLIX.COM", -13.99, "Abonnements"),
    booking("test", "2026-11-05", "XYZ VERIFY CARD", -0.99, "Sonstiges"),
    booking("tv", "2026-11-06", "MEDIAMARKT WIEN", -899, "Shopping"),
  ];
  return state;
}

describe("essential assistant tools", () => {
  it("routes everyday wording to the new tools", () => {
    const cases: [string, string][] = [
      ["Gibt es verdächtige Buchungen?", "security"],
      ["Wurde ich irgendwo doppelt abgebucht?", "security"],
      ["Welche Abos sind teurer geworden?", "contracts"],
      ["Wie war mein Oktober?", "month_review"],
      ["Monatsbericht", "month_review"],
      ["Was schuldet mir Raphael?", "shared"],
      ["Wie viel muss mir Raphael noch zahlen?", "shared"],
      ["Wie hoch ist mein Nettovermögen?", "networth"],
      ["Wie hat sich mein Vermögen entwickelt?", "networth"],
      ["Ist die Rückerstattung von Amazon schon da?", "refunds"],
      ["Welche Retouren sind noch offen?", "refunds"],
      ["Wann kommt die nächste große Abbuchung?", "pulse"],
    ];
    for (const [text, tool] of cases) expect(detectTool(text, ["Japan"]), text).toBe(tool);
    expect(detectTool("Welche Zinsen bekomme ich fürs Sparkonto?")).toBe("market");
    expect(detectTool("Wie viel Zinsen hab ich bekommen?")).not.toBe("market");
  });

  it("finds duplicates, test charges and unusual spending", () => {
    const result = securityCheck(fixture(), asOf);
    const labels = result.card!.lines.map((line) => line.label).join(" | ");
    expect(labels).toMatch(/NETFLIX/i);
    expect(labels).toMatch(/XYZ VERIFY/i);
    expect(labels).toMatch(/MEDIAMARKT/i);
    expect(result.text).toBeTruthy();
  });

  it("reports a calm result when nothing looks wrong", () => {
    const state = fixture();
    state.transactions = state.transactions.filter((row) => row.id.startsWith("spar"));
    const result = securityCheck(state, asOf);
    expect(result.card!.lines.every((line) => line.tone !== "bad")).toBe(true);
  });

  it("picks the right month for a report", () => {
    expect(reviewMonth("wie war mein oktober", asOf)).toBe("2026-10");
    expect(reviewMonth("monatsbericht letzter monat", asOf)).toBe("2026-10");
    expect(reviewMonth("monatsbericht", "2026-11-03")).toBe("2026-10");
    expect(reviewMonth("monatsbericht", "2026-11-20")).toBe("2026-10");
    expect(reviewMonth("bericht für diesen monat", "2026-11-20")).toBe("2026-11");
  });

  it("summarises a month against the previous one", () => {
    const result = monthReview(fixture(), "wie war mein oktober", asOf);
    expect(result.card!.kind).toBe("review");
    expect(result.text).toMatch(/Oktober/);
  });

  it("answers shared costs, net worth and refunds", () => {
    const state = fixture();
    expect(sharedAnswer(state, asOf).text).toBeTruthy();
    expect(netWorthAnswer(state, calculateDashboard(state)).text).toBeTruthy();
    const refunds = refundAnswer(state, "ist die rückerstattung von amazon schon da", asOf);
    expect(refunds.text).toMatch(/Amazon|AMAZON/);
    expect(refunds.card!.lines.some((line) => line.transactionIds?.includes("amazon-back"))).toBe(true);
  });

  it("runs every new tool through the agent", async () => {
    const state = fixture();
    const context = { state, dashboard: calculateDashboard(state), asOf };
    for (const [tool, text] of [["security", "verdächtige buchungen"], ["month_review", "wie war mein oktober"], ["shared", "was schuldet mir raphael"],
      ["networth", "nettovermögen"], ["refunds", "rückerstattung amazon"]] as const) {
      const result = await executeTool(tool, text, context);
      expect(result.text, tool).toBeTruthy();
    }
  });
});
