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
    "wie viel steuer zahle ich auf meine prämie", "wie viel vom successbonus wird voll versteuert", "warum zahle ich so viel lohnsteuer",
    "wann kommt mein bonus",
  ])("recognises %s", (text) => expect(payrollQuestion(text)).toBe(true));

  it.each([
    "ist mein gehalt schon da", "merk dir mein gehalt kommt am 25.", "wie hoch ist mein nettovermögen", "wie viel hab ich im oktober ausgegeben",
    "kann man mit 3000 netto in wien gut leben", "was kann ich bei der arbeitnehmerveranlagung von der lohnsteuer absetzen",
  ])("leaves %s to other tools", (text) => expect(payrollQuestion(text)).toBe(false));

  it("answers with the latest payslip and splits the next special payment into 6 % and fully taxed", () => {
    const result = payrollAnswer(year2026());
    expect(result.text).toBe(`Deine letzte Abrechnung (September 2026) bringt ${currency(2780)} netto aus ${currency(4000)} brutto, ausgezahlt im Oktober 2026. ` +
      `Als Nächstes kommt die Weihnachtsremuneration mit der November-Abrechnung: ${currency(3000)} brutto, ganz im Jahressechstel zu 6 %.`);
    expect(result.card).toMatchObject({ title: "Gehalt · September 2026", page: { href: "/gehalt-steuern" } });
    expect(result.card?.lines.find((line) => line.label.startsWith("Nächste Sonderzahlung"))?.detail).toMatch(/^ganz im Sechstel zu 6 % · etwa /);
    expect(payrollAnswer({ ...year2026(), payslips: [] }).text).toMatch(/noch keine Lohnabrechnung/);
  });

  it("answers the asked special payment, payroll terms and the wage tax", () => {
    const state = year2026();
    const christmas = payrollAnswer(state, "Was bleibt vom Weihnachtsgeld?");
    expect(christmas.text).toMatch(/^Die Weihnachtsremuneration kommt voraussichtlich mit der November-Abrechnung \(ausgezahlt im Dezember\)/);
    expect(christmas.card?.title).toBe("Weihnachtsremuneration");
    const bonus = payrollAnswer(state, "Wie viel vom Successbonus wird voll versteuert?").text;
    expect(bonus).toMatch(/^Der Successbonus kommt voraussichtlich mit der Dezember-Abrechnung \(ausgezahlt im Jänner\)/);
    expect(bonus).toMatch(/zu 6 %, .+ voll versteuert\. Netto bleiben etwa /);
    expect(payrollAnswer(state, "Wie hoch ist mein Urlaubsgeld?").text).toMatch(/^Der Urlaubszuschuss kam mit der Juni-Abrechnung/);
    expect(payrollAnswer(state, "Was ist das Jahressechstel?").text).toMatch(/^Das Jahressechstel ist .+ Bei dir liegt es derzeit bei /);
    expect(payrollAnswer(state, "Was ist der Unterschied zwischen Brutto und Netto?").text).toMatch(/^Brutto ist dein Gehalt vor allen Abzügen/);
    const tax = payrollAnswer(state, "Warum zahle ich so viel Lohnsteuer?").text;
    expect(tax).toContain(`Von ${currency(4000)} brutto gehen bei dir ${currency(500)} Lohnsteuer ab, rund 13 %.`);
    expect(tax).toContain("mit 40 % besteuert");
    expect(tax).not.toContain("Als Nächstes");
    expect(payrollAnswer(state, "Werden Überstunden anders versteuert?").text).toMatch(/^Überstunden selbst werden wie dein normales Gehalt versteuert\. .*§ 68 EStG/);
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
    // Questions about people in general ("man") get no personal numbers either.
    expect(agentFacts("general", state, dashboard, today, "Kann man mit 3000 netto in Wien gut leben?")).toEqual({ today });
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
