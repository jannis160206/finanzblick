import { describe, expect, it } from "vitest";
import { createSeed } from "./seed";
import { payslipInflow, salaryForecast, SPECIAL_NET_RATIO } from "./salary-forecast";
import type { Payslip } from "./payslip-schema";
import type { AppState, Transaction } from "./types";

const employer = "Musterbetrieb GmbH";
// Synthetic payslips: a raise of the Grundgehalt from April, a special payment in June.
function payslips(): Payslip[] {
  return Array.from({ length: 10 }, (_, index) => {
    const month = index + 1;
    const raised = month >= 4;
    const base = raised ? 3150 : 3000;
    return {
      year: 2026, month, employer, monthlyPayroll: true, baseSalary: base,
      regularGross: base + 400, onCallGross: 300, regularSv: 600, regularTax: 400,
      specialGross: month === 6 ? 3150 : 0,
      ...(month === 6 ? { specialSv: 540, specialTax: 150 } : {}),
      netPay: (raised ? 2500 : 2400) + (month === 6 ? 2460 : 0),
    };
  });
}

function payslipState(): AppState {
  const state = createSeed();
  state.settings = { ...state.settings, asOf: "2026-11-10", baselineDate: "2026-11-01" };
  state.payslips = payslips();
  return state;
}

const booking = (date: string, description: string, amount: number): Transaction => ({
  id: `${date}-${amount}`, bank: "Raiffeisen", pocket: null, date, amount, description, category: "Gehalt", includeInPlan: false,
});

// Bank bookings only: 2.400 € salary, December with Weihnachtsgeld, January almost double, a raise to 2.500 € in 2026.
function bankState(): AppState {
  const state = createSeed();
  state.settings = { ...state.settings, asOf: "2026-03-10", baselineDate: "2026-03-01" };
  const months = ["2025-03", "2025-04", "2025-05", "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02"];
  state.transactions = months.flatMap((month) => {
    const period = `${month.slice(5)}/${month.slice(0, 4)}`;
    const salary = month === "2025-11" ? 4700 : month === "2025-12" ? 4300 : month >= "2026-01" ? 2500 : 2400;
    return [
      booking(`${month}-27`, `Gehalt ${period} Team Talent Solutions`, salary),
      ...(month > "2025-03" ? [booking(`${month}-12`, `Rufbereitschaft ${period} Team Talent Solutions`, 300)] : []),
    ];
  });
  return state;
}

describe("salary forecast", () => {
  it("separates overtime from a payslip: gross above the Grundgehalt without on-call, net in proportion", () => {
    const inflow = payslipInflow(payslips()[4])!;
    expect(inflow).toMatchObject({ month: "2026-06", source: "payslip", base: 3150, special: 0, holidayWork: 0 });
    expect(inflow.onCall).toBeCloseTo(211.27, 2);
    expect(inflow.overtime).toBeCloseTo(70.42, 2);
    expect(inflow.salary).toBeCloseTo(2218.31, 2);
    expect(inflow.known).toEqual({ onCall: true, overtime: true, holidayWork: true });
    expect(payslipInflow({ ...payslips()[4], baseSalary: undefined })!.known.overtime).toBe(false);
  });

  it("forecasts every budget month after the last payslip from today's salary level, averages and last year's months", () => {
    const forecast = salaryForecast(payslipState());
    expect(forecast.actualThrough).toBe("2026-11");
    expect(forecast.months[0].month).toBe("2026-12");
    expect(forecast.months.at(-1)!.month).toBe("2027-12");
    expect(forecast.raise).toEqual({ factor: 1.0475, since: "2026-02" });
    const byMonth = Object.fromEntries(forecast.months.map((month) => [month.month, month]));
    for (const month of forecast.months) expect(month.salary.amount).toBe(2218);
    expect(byMonth["2027-03"].onCall).toEqual({ amount: 214, reason: "Ø 10 Monate · inkl. Erhöhung" });
    expect(byMonth["2027-03"].overtime.amount).toBe(71);
    expect(byMonth["2027-07"].special).toEqual({ amount: 2460, reason: "wie Juli 2026" });
    expect(byMonth["2027-02"].special).toMatchObject({ amount: 0, reason: expect.stringContaining("ohne Sonderzahlung") });
    // December has no month of last year: the payroll model's November special payment, paid out in December.
    expect(byMonth["2026-12"].special.reason).toMatch(/^Modell/);
    expect(byMonth["2026-12"].special.amount).toBeGreaterThan(2200);
    expect(byMonth["2026-12"].special.amount).toBeLessThan(3150);
    expect(byMonth["2027-01"].special.amount).toBe(0);
    expect(byMonth["2026-12"].total).toBe(2218 + 214 + 71 + byMonth["2026-12"].special.amount);
    expect(byMonth["2026-12"].salary.reason).toBe("laufendes Netto lt. Abrechnung Okt. 2026");
  });

  it("uses salary bookings without payslips: special payments from December and January, scaled by the raise", () => {
    const forecast = salaryForecast(bankState());
    expect(forecast.actualThrough).toBe("2026-03");
    expect(forecast.months[0].month).toBe("2026-04");
    expect(forecast.history.find((item) => item.month === "2025-12")).toMatchObject({ source: "bank", salary: 2400, special: 2300 });
    const byMonth = Object.fromEntries(forecast.months.map((month) => [month.month, month]));
    expect(byMonth["2026-06"].salary).toEqual({ amount: 2500, reason: "laufendes Netto lt. Gehaltseingang März 2026" });
    expect(byMonth["2026-12"].special.amount).toBe(Math.round(2300 * 2500 / 2400));
    expect(byMonth["2026-12"].special.reason).toMatch(/^wie Dez\. 2025 · \+4,17\s%$/);
    expect(byMonth["2027-01"].special.amount).toBe(Math.round(1900 * 2500 / 2400));
    expect(byMonth["2026-07"].special.amount).toBe(0);
    expect(byMonth["2026-12"].overtime).toEqual({ amount: 0, reason: "keine Daten zu Überstunden" });
    expect(byMonth["2026-12"].onCall.amount).toBeGreaterThanOrEqual(300);
    expect(byMonth["2026-12"].onCall.amount).toBeLessThanOrEqual(313);
  });

  it("models special payments in July and December when there is no month of last year", () => {
    const state = createSeed();
    state.settings = { ...state.settings, asOf: "2027-02-10", baselineDate: "2027-02-01" };
    state.payslips = [{ year: 2027, month: 1, employer, monthlyPayroll: true, baseSalary: 3000, regularGross: 3000, specialGross: 0, netPay: 2100 }];
    const months = Object.fromEntries(salaryForecast(state).months.map((month) => [month.month, month.special]));
    expect(months["2027-07"].amount).toBe(Math.round(3000 * SPECIAL_NET_RATIO));
    expect(months["2027-07"].reason).toMatch(/^Modell: .*Juni.*78\s%/);
    expect(months["2027-12"].amount).toBe(Math.round(3000 * SPECIAL_NET_RATIO));
    expect(months["2027-08"].amount).toBe(0);
  });

  it("forecasts nothing without salary data", () => {
    expect(salaryForecast(createSeed())).toEqual({ history: [], months: [] });
  });
});
