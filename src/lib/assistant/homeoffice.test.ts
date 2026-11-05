import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { assistantMessageSchema, type AppState, type Transaction } from "@/lib/types";
import { executeTool } from "./agent";
import {
  calculateHomeOffice, estimateIncome, guessArticle, homeOfficeCandidates, homeOfficeResultCard, incomeTax, type HomeOfficeInput,
} from "./homeoffice";
import { detectTool } from "./tools";

const booking = (id: string, date: string, description: string, amount: number, category: Transaction["category"] = "Shopping"): Transaction =>
  ({ id, date, bank: "Raiffeisen", pocket: "Raiffeisen Giro", description, amount, category, includeInPlan: true });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.transactions = [
    booking("laptop", "2026-08-11", "MEDIAMARKT LENOVO THINKPAD", -1200),
    booking("monitor", "2026-03-02", "AMAZON DELL MONITOR 27", -250),
    booking("chair", "2026-02-10", "XXXLUTZ BUEROSTUHL ERGO", -420, "Möbel & Einrichtung"),
    booking("spar", "2026-03-03", "SPAR DANKT", -40, "Lebensmittel"),
    booking("old", "2025-05-03", "AMAZON MONITOR", -150),
  ];
  return state;
}
const base = (items: HomeOfficeInput["items"], extra: Partial<HomeOfficeInput> = {}): HomeOfficeInput =>
  ({ year: 2026, items, days: 0, employerPaid: 0, otherCosts: 0, rate: 0.3, ...extra });

describe("home-office tax calculator", () => {
  it("detects the tool and opens the interactive card for the asked year", () => {
    expect(detectTool("Was bekomme ich für meine Home-Office-Sachen beim Steuerausgleich zurück?")).toBe("homeoffice");
    expect(detectTool("Wie viel kann ich für meinen Bürostuhl absetzen?")).toBe("homeoffice");
    expect(detectTool("Was kann ich bei der Arbeitnehmerveranlagung absetzen?")).toBe("tax");
    const state = fixture();
    const result = executeTool("homeoffice", "Home Office absetzen 2025", { state, dashboard: calculateDashboard(state), asOf: "2026-10-07" });
    expect(result.card).toMatchObject({ kind: "homeoffice", year: 2025 });
    expect(assistantMessageSchema.safeParse({ id: "m", role: "assistant", text: result.text, at: 1, card: result.card }).success).toBe(true);
  });

  it("finds plausible purchases of the year and guesses the article", () => {
    const ids = homeOfficeCandidates(fixture(), 2026).map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining(["laptop", "monitor", "chair"]));
    expect(ids).not.toContain("spar");
    expect(ids).not.toContain("old");
    const rows = new Map(fixture().transactions.map((row) => [row.id, row]));
    expect(guessArticle(rows.get("laptop")!)).toBe("computer");
    expect(guessArticle(rows.get("monitor")!)).toBe("monitor");
    expect(guessArticle(rows.get("chair")!)).toBe("chair");
  });

  it("follows the BMF example: 1.200 € in August, 40 % private, 3 years with half-year depreciation", () => {
    const result = calculateHomeOffice(base([{ id: "pc", label: "PC", date: "2025-08-11", price: 1200, type: "computer", business: 60 }], { year: 2025 }));
    expect(result.lines[0]).toMatchObject({ deductible: 120, later: [240, 240, 120] });
    expect(result.work).toBe(120);
  });

  it("deducts small items at once, caps ergonomic furniture and subtracts the flat allowance", () => {
    const items: HomeOfficeInput["items"] = [
      { id: "m", label: "Monitor", date: "2026-03-02", price: 250, type: "monitor", business: 60 },
      { id: "c", label: "Stuhl", date: "2026-02-10", price: 420, type: "chair", business: 100 },
      { id: "x", label: "Privat", date: "2026-02-10", price: 99, type: "private", business: 0 },
    ];
    const result = calculateHomeOffice(base(items, { days: 80, employerPaid: 60 }));
    expect(result.work).toBe(150);
    expect(result.furniture).toBe(300);
    expect(result.furnitureCarry).toBe(120);
    expect(result.telework).toBe(180);
    expect(result.werbungskosten).toBe(630);
    expect(result.aboveFlat).toBe(498);
    expect(result.refund).toBe(149.4);
    const few = calculateHomeOffice(base(items, { days: 20 }));
    expect(few.furniture).toBe(0);
    expect(few.warnings.join(" ")).toMatch(/26 Homeoffice-Tagen/);
  });

  it("uses the progressive tariff when the income is known", () => {
    expect(incomeTax(13539, 2026)).toBe(0);
    expect(incomeTax(21992, 2026)).toBeCloseTo(1690.6, 1);
    const input = base([{ id: "m", label: "Monitor", date: "2026-03-02", price: 500, type: "monitor", business: 100 }], { income: 22100, rate: undefined });
    const result = calculateHomeOffice(input);
    // 22.100 − 132 = 21.968 is in the 20 % step, minus 368 € stays there.
    expect(result.aboveFlat).toBe(368);
    expect(result.refund).toBe(73.6);
    const { card } = homeOfficeResultCard(input, result);
    expect(card.kind).toBe("homeoffice_result");
    expect(card.total).toBe(73.6);
    expect(assistantMessageSchema.safeParse({ id: "r", role: "assistant", text: "x", at: 1, card }).success).toBe(true);
  });

  it("estimates the yearly income from payslips", () => {
    const state = fixture();
    state.payslips = [1, 2].map((month) => ({ year: 2026, month, employer: "Firma", regularGross: 3000, specialGross: 0, monthlyTaxableBase: 2400, monthlyPayroll: true }));
    expect(estimateIncome(state, 2026)).toEqual({ income: 28800, year: 2026, months: 2 });
    expect(estimateIncome(createEmptyAccountState(), 2026)).toBeUndefined();
  });
});
