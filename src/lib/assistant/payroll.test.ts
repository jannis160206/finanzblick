import { describe, expect, it } from "vitest";
import { calculateDashboard } from "@/lib/calc";
import { currency } from "@/lib/format";
import { payrollEmployer, payrollFixture } from "../../../tests/fixtures/payroll-state";
import { payrollAnswer, payrollFacts, payrollQuestion } from "./payroll";
import { agentEvidence, agentFacts } from "./specialist-context";

const year2026 = () => {
  const state = payrollFixture();
  return { ...state, payslips: (state.payslips ?? []).filter((entry) => entry.year === 2026 && entry.employer === payrollEmployer) };
};

describe("payroll specialist", () => {
  it.each([
    "wie viel netto bekomme ich", "was bleibt vom weihnachtsgeld", "zeig mir meinen lohnzettel", "wie hoch ist mein brutto",
    "wie viel steuer zahle ich auf meine prämie", "wie viel vom successbonus wird voll versteuert",
  ])("recognises %s", (text) => expect(payrollQuestion(text)).toBe(true));

  it.each([
    "ist mein gehalt schon da", "merk dir mein gehalt kommt am 25.", "wie hoch ist mein nettovermögen", "wie viel hab ich im oktober ausgegeben",
  ])("leaves %s to other tools", (text) => expect(payrollQuestion(text)).toBe(false));

  it("answers with the latest payslip and splits the next special payment into 6 % and fully taxed", () => {
    const result = payrollAnswer(year2026());
    expect(result.text).toBe(`Deine letzte Abrechnung (September 2026) bringt ${currency(2780)} netto aus ${currency(4000)} brutto, ausgezahlt im Oktober 2026. ` +
      `Als Nächstes kommt die Weihnachtsremuneration mit der November-Abrechnung: ${currency(3000)} brutto, ganz im Jahressechstel zu 6 %.`);
    expect(result.card).toMatchObject({ title: "Gehalt · September 2026", page: { href: "/gehalt-steuern" } });
    expect(result.card?.lines.find((line) => line.label.startsWith("Nächste Sonderzahlung"))?.detail).toMatch(/^ganz im Sechstel zu 6 % · etwa /);
    expect(payrollAnswer({ ...year2026(), payslips: [] }).text).toMatch(/noch keine Lohnabrechnung/);
  });

  it("hands the model finished numbers only", () => {
    expect(payrollFacts(year2026(), "2026-10-15")).toMatchObject({
      latestPayslip: { month: "September 2026", gross: 4000, net: 2780, wageTax: 500, socialSecurity: 720 },
      nextSpecialPayment: { name: "Weihnachtsremuneration", gross: 3000, inSixthAtSixPercent: 3000, fullyTaxed: 0 },
    });
  });
});

describe("specialist context", () => {
  it("gives each agent only its own facts and the general chat none for small talk", () => {
    const state = year2026();
    const dashboard = calculateDashboard(state);
    const today = state.settings.asOf;
    expect(agentFacts("general", state, dashboard, today, "Wie wird das Wetter morgen?")).toEqual({ today });
    const budget = agentFacts("budget", state, dashboard, today, "Was bleibt mir?");
    expect(budget).toHaveProperty("currentMonth");
    expect(budget).not.toHaveProperty("spendingByMonthAndCategory");
    expect(budget).not.toHaveProperty("subscriptions");
    expect(Object.keys(agentFacts("contracts", state, dashboard, today, "Welche Abos?"))).toEqual(["today", "subscriptions", "priceIncreases", "possibleDuplicateFixedCosts", "memory"]);
    expect(agentFacts("payroll", state, dashboard, today, "Wie viel netto?")).toHaveProperty("payroll.latestPayslip.net", 2780);
    // Smaller than the old all-in-one facts: the model reads less and stays on topic.
    const everything = JSON.stringify(agentFacts("general", state, dashboard, today, "Wie viel Geld habe ich?")).length;
    expect(JSON.stringify(agentFacts("contracts", state, dashboard, today, "Abos")).length).toBeLessThan(everything);
    expect(agentEvidence("payroll", state, dashboard, today, "Wie viel netto?")).toContain("netto");
    expect(agentEvidence("general", state, dashboard, today, "Hallo")).toBeUndefined();
  });
});
