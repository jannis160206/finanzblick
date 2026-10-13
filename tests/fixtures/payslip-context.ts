import type { PayslipLine, PayslipPage } from "../../src/lib/import/payslip";

export const positionedLine = (y: number, ...items: [number, string][]): PayslipLine => ({
  y, items: items.map(([x, text]) => ({ x, text })),
});

export function syntheticContextPage(
  context: string | PayslipLine,
  employer = "Musterbetrieb GmbH",
): PayslipPage {
  return { lines: [
    positionedLine(800, [50, "Lohn / Gehaltsabrechnung Jänner 2026"]),
    positionedLine(765, [50, employer]),
    positionedLine(720, [50, "Arbeitnehmer: Nur synthetische Identität"]),
    typeof context === "string" ? positionedLine(700, [50, context]) : context,
    positionedLine(550, [290, "LSt-Tg"], [350, "SV-Tg"]),
    positionedLine(538, [298, "30"], [358, "30"]),
    positionedLine(510, [54, "LA-Nr."], [89, "Bezeichnung"], [254, "Menge"],
      [329, "Satz"], [392, "Betrag"], [455, "BMG SV"], [526, "BMG LSt"]),
    positionedLine(490, [54, "1000"], [89, "Gehalt"], [379, "3.000,00"], [451, "3.000,00"], [525, "3.000,00"]),
    positionedLine(340, [89, "Brutto"], [379, "3.000,00"]),
    positionedLine(325, [89, "Abzüge"]),
    positionedLine(310, [89, "SV Beitrag lfd"], [379, "-540,00"], [451, "3.000,00"]),
    positionedLine(295, [89, "LSt Beitrag lfd"], [379, "-200,00"], [525, "2.460,00"]),
    positionedLine(280, [89, "Netto"], [379, "2.260,00"]),
    positionedLine(240, [89, "Jahressechstel"], [379, "6.000,00"]),
  ] };
}
