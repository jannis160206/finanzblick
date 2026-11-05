import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import type { AppState, Transaction } from "@/lib/types";
import { executeTool } from "./agent";
import { annuity, parseDue, parseLoan, parseReminder, reminderTask } from "./extras";
import { applyOperations } from "./operations";
import { detectTool } from "./tools";

const asOf = "2026-11-05";
const row = (id: string, date: string, description: string, amount: number, category: Transaction["category"]): Transaction =>
  ({ id, date, bank: "Raiffeisen", pocket: "Raiffeisen Giro", description, amount, category, includeInPlan: true });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.transactions = [];
  for (const year of [2025, 2026]) for (const month of ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"]) {
    state.transactions.push(row(`g${year}${month}`, `${year}-${month}-25`, "GEHALT", 2000, "Gehalt"));
    state.transactions.push(row(`f${year}${month}`, `${year}-${month}-05`, "BILLA", year === 2026 ? -300 : -250, "Lebensmittel"));
  }
  state.transactions.push(row("tv", "2026-06-12", "MEDIAMARKT", -900, "Shopping"));
  return state;
}
const run = (state: AppState, text: string) => {
  const tool = detectTool(text)!;
  return { tool, ...executeTool(tool, text, { state, dashboard: calculateDashboard(state), asOf }) };
};

describe("Kreditrechner", () => {
  it("rechnet die Annuität", () => {
    expect(annuity(10_000, 0.06, 60)).toBeCloseTo(193.33, 2);
    expect(annuity(1200, 0, 12)).toBe(100);
  });

  it("liest Betrag, Laufzeit und Zins aus freien Sätzen", () => {
    expect(parseLoan("Lohnt sich ein Kredit über 10.000 € auf 5 Jahre zu 6 %?")).toEqual({ principal: 10_000, rate: 0.06, months: 60 });
    expect(parseLoan("Laptop 1.200 € in 12 Raten mit 9,9 %")).toEqual({ principal: 1200, rate: 0.099, months: 12 });
    expect(parseLoan("Autokredit 15k 7 Jahre")).toMatchObject({ principal: 15_000, months: 84, rate: undefined });
  });

  it("wird erkannt und zeigt Rate, Zinsen und Ansparen", () => {
    for (const text of ["Lohnt sich ein Kredit über 10.000 € auf 5 Jahre zu 6 %?", "Soll ich das Auto finanzieren? 12.000 € auf 4 Jahre", "Leasing 20.000 € 48 Monate 5 %"])
      expect(detectTool(text)).toBe("loan");
    expect(detectTool("Was ist ein Kredit?")).not.toBe("loan");
    expect(detectTool("Was muss ich auf die Kreditkarte überweisen?")).not.toBe("loan");
    const result = run(fixture(), "Lohnt sich ein Kredit über 10.000 € auf 5 Jahre zu 6 %?");
    expect(result.card?.kind).toBe("loan");
    expect(result.card?.total).toBeCloseTo(193.33, 2);
    expect(result.text).toContain("Zinsen");
    expect(result.card?.lines.some((line) => line.label === "Stattdessen ansparen")).toBe(true);
  });

  it("vergleicht ohne Zinsangabe drei Zinssätze", () => {
    const result = run(fixture(), "Kredit 5.000 € auf 3 Jahre");
    expect(result.card?.lines.filter((line) => /Sollzins/.test(line.label))).toHaveLength(3);
  });
});

describe("Erinnerungen", () => {
  it("versteht Datumsangaben", () => {
    expect(parseDue("am 1. Dezember", asOf)).toBe("2026-12-01");
    expect(parseDue("am 3.2.", asOf)).toBe("2027-02-03");
    expect(parseDue("morgen", asOf)).toBe("2026-11-06");
    expect(parseDue("in 2 Wochen", asOf)).toBe("2026-11-19");
    expect(parseDue("nächsten Montag", asOf)).toBe("2026-11-09");
    expect(parseDue("Ende des Monats", asOf)).toBe("2026-11-30");
    expect(parseDue("im März", asOf)).toBe("2027-03-01");
  });

  it("zieht die Aufgabe aus dem Satz", () => {
    expect(reminderTask("Erinner mich am 1. Dezember, die Kfz-Versicherung zu kündigen")).toBe("Kfz-Versicherung kündigen");
    expect(reminderTask("Erinnere mich morgen an die Miete")).toBe("Miete");
    expect(parseReminder("Erinner mich bitte", asOf)).toMatch(/Woran/);
    expect(parseReminder("Erinner mich an die Kündigung", asOf)).toMatch(/Wann/);
  });

  it("legt an, zeigt im Wochenüberblick und lässt sich vergessen", () => {
    let state = fixture();
    expect(detectTool("Erinner mich übermorgen, die Kfz-Versicherung zu kündigen")).toBe("reminder");
    const preview = run(state, "Erinner mich übermorgen, die Kfz-Versicherung zu kündigen");
    expect(preview.change?.operations[0]).toMatchObject({ op: "memory_add", key: "reminder", due: "2026-11-07" });
    state = applyOperations(state, preview.change!.operations, { asOf }).state;
    expect(state.assistantMemory?.[0]).toMatchObject({ key: "reminder", due: "2026-11-07" });
    const briefing = run(state, "Gib mir den Wochenüberblick");
    expect(briefing.card?.lines[0].label).toMatch(/Erinnerung: Kfz-Versicherung kündigen/);
    expect(briefing.text).toMatch(/Erinnerung ist dran/);
    expect(detectTool("Welche Erinnerungen habe ich?")).toBe("reminder");
    expect(run(state, "Welche Erinnerungen habe ich?").card?.lines).toHaveLength(1);
    const forget = run(state, "Vergiss die Erinnerung Kfz-Versicherung");
    expect(forget.tool).toBe("forget");
    expect(forget.change?.operations[0]).toMatchObject({ op: "memory_delete" });
  });
});

describe("Jahresrückblick", () => {
  it("wird erkannt", () => {
    for (const text of ["Wie war mein Jahr 2026?", "Jahresrückblick", "Mach mir einen Rückblick auf letztes Jahr", "Fass mein Jahr zusammen"])
      expect(detectTool(text)).toBe("review");
  });

  it("rechnet Sparquote, Top-Kategorie und Vergleich zum Vorjahr", () => {
    const result = run(fixture(), "Wie war mein Jahr 2026?");
    expect(result.card?.kind).toBe("review");
    expect(result.card?.lines[0]).toMatchObject({ label: "Einnahmen", value: 20_000 });
    expect(result.card?.lines[1]).toMatchObject({ label: "Ausgaben", value: -3900 });
    expect(result.card?.total).toBe(16_100);
    expect(result.text).toMatch(/Sparquote 80,5 %/);
    expect(result.card?.lines.find((line) => line.label.startsWith("Größte Ausgabe"))?.value).toBe(-900);
    expect(result.card?.lines.find((line) => line.label.startsWith("Ausgaben ggü."))?.value).toBe(1400);
    expect(result.text).toMatch(/mehr ausgegeben als im gleichen Zeitraum 2025/);
  });

  it("nimmt bei „letztes Jahr“ das Vorjahr", () => {
    expect(run(fixture(), "Jahresrückblick letztes Jahr").card?.title).toMatch(/2025/);
  });
});
