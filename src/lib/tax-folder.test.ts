import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import type { AppState, Transaction } from "@/lib/types";
import { kzLabel, taxFolder, taxFolderCsv, taxFolderHtml } from "./tax-folder";

const booking = (id: string, date: string, description: string, amount: number, category: Transaction["category"]): Transaction =>
  ({ id, date, bank: "Raiffeisen", pocket: "Raiffeisen Giro", description, amount, category, includeInPlan: true });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-12-31";
  state.transactions = [
    booking("caritas", "2026-05-02", "CARITAS SPENDE", -50, "Sonstiges"),
    booking("laptop", "2026-03-10", "MEDIAMARKT LAPTOP", -1200, "Elektronik"),
    booking("udemy", "2026-04-01", "UDEMY KURS TYPESCRIPT", -19.99, "Weiterbildung"),
    booking("chair", "2026-06-01", "=HACK BÜROSESSEL; \"ERGO\"", -300, "Möbel & Einrichtung"),
    booking("old", "2025-05-02", "CARITAS SPENDE", -80, "Sonstiges"),
    booking("refund", "2026-05-03", "CARITAS SPENDE RETOUR", 20, "Sonstiges"),
    booking("billa", "2026-05-04", "BILLA DANKT", -30, "Lebensmittel"),
  ];
  return state;
}

describe("taxFolder", () => {
  it("groups the year's deductible spending by Kennzahl", () => {
    const folder = taxFolder(fixture(), 2026);
    const byId = Object.fromEntries(folder.groups.map((group) => [group.id, group]));
    expect(byId.donation.rows.map((row) => row.id)).toEqual(["caritas"]);
    expect(byId.equipment).toMatchObject({ kz: "719", total: 1200, count: 1 });
    expect(byId.equipment.rows[0].hint).toMatch(/1\.000/);
    expect(byId.training).toMatchObject({ kz: "722", total: 19.99 });
    expect(byId.homeoffice.rows.map((row) => row.id)).toEqual(["chair"]);
    expect(folder.count).toBe(4);
    expect(folder.total).toBe(1569.99);
    expect(folder.note).toMatch(/keine Steuerberatung/);
  });

  it("labels unverified and automatic groups", () => {
    expect(kzLabel({ kz: "719", verified: true })).toBe("KZ 719");
    expect(kzLabel({ kz: "158", verified: false })).toBe("KZ 158 (bitte prüfen)");
    expect(kzLabel({ kz: undefined, verified: true })).toBe("automatisch");
  });

  it("exports safe CSV and escaped HTML", () => {
    const folder = taxFolder(fixture(), 2026);
    const csv = taxFolderCsv(folder);
    expect(csv.startsWith("\uFEFFDatum;Händler;Betrag (EUR)")).toBe(true);
    expect(csv).toMatch(/\r\n2026-03-10;MEDIAMARKT LAPTOP;1200,00;[^;]+;Arbeitsmittel;KZ 719;Werbungskosten;/);
    expect(csv).toContain(`"'=HACK BÜROSESSEL; ""ERGO"""`);
    const page = taxFolderHtml(folder);
    expect(page).toContain("&quot;ERGO&quot;");
    expect(page).not.toContain("<script");
  });
});
