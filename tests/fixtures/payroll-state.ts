import { appStateSchema } from "../../src/lib/types";
import type { Payslip } from "../../src/lib/payslip-schema";
import { pocketFixture } from "./pocket-state";

export const payrollEmployer = "Fabelwald Robotik GmbH";
export const otherPayrollEmployer =
  "Synthetischer Arbeitgeber mit einem bewusst sehr langen Namen zur Prüfung der mobilen Darstellung GmbH";

export function payrollFixture() {
  const state = pocketFixture();
  const base: Payslip = {
    year: 2026,
    month: 1,
    employer: payrollEmployer,
    regularGross: 4000,
    specialGross: 0,
    baseSalary: 3000,
    regularSv: 720,
    regularTax: 500,
    monthlyTaxableBase: 3280,
    monthlyPayroll: true,
  };
  state.payslips = [
    ...Array.from({ length: 9 }, (_, index) => ({
      ...base,
      month: index + 1,
      ...(index === 5 ? { specialGross: 3000, specialSv: 512.1 } : {}),
    })),
    {
      ...base,
      employer: otherPayrollEmployer,
      regularGross: 3000,
      baseSalary: 2800,
      regularSv: 540,
      monthlyTaxableBase: 2460,
    },
    { ...base, year: 2027 },
  ];
  return appStateSchema.parse(state);
}

export function syntheticPayslipPdf(month = 10, gross = 4000): Buffer {
  const money = (value: number) =>
    value.toLocaleString("de-DE", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const monthNames = [
    "Jaenner",
    "Februar",
    "Maerz",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
  ];
  const items: [number, number, string][] = [
    [50, 800, `Gehaltsabrechnung ${monthNames[month - 1]} 2026`],
    [50, 760, payrollEmployer],
    [290, 550, "LSt-Tg"],
    [350, 550, "SV-Tg"],
    [298, 538, "30"],
    [358, 538, "30"],
    [54, 510, "LA-Nr."],
    [89, 510, "Bezeichnung"],
    [254, 510, "Menge"],
    [329, 510, "Satz"],
    [392, 510, "Betrag"],
    [455, 510, "BMG SV"],
    [526, 510, "BMG LSt"],
    [54, 490, "1000"],
    [89, 490, "Gehalt"],
    [379, 490, money(gross)],
    [451, 490, money(gross)],
    [525, 490, money(gross)],
    [89, 470, "Brutto"],
    [379, 470, money(gross)],
    [89, 450, "SV Beitrag lfd"],
    [379, 450, "-720,00"],
    [451, 450, money(gross)],
    [89, 430, "LSt Beitrag lfd"],
    [379, 430, "-500,00"],
    [525, 430, money(gross - 720)],
  ];
  const stream = items
    .map(
      ([x, y, text]) =>
        `BT /F1 10 Tf 1 0 0 1 ${x} ${y} Tm (${text.replace(/[\\()]/g, "\\$&")}) Tj ET`,
    )
    .join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}
