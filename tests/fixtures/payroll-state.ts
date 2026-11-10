import { createHash } from "node:crypto";
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

const passwordPadding = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
const padPassword = (password: string) => Buffer.concat([Buffer.from(password, "latin1"), passwordPadding]).subarray(0, 32);
const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();

function rc4(key: Buffer, data: Buffer): Buffer {
  const box = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + box[i] + key[i % key.length]) & 255;
    [box[i], box[j]] = [box[j], box[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < data.length; index++) {
    i = (i + 1) & 255;
    j = (j + box[i]) & 255;
    [box[i], box[j]] = [box[j], box[i]];
    out[index] = data[index] ^ box[(box[i] + box[j]) & 255];
  }
  return out;
}

// PDF standard security handler, revision 2 (40-bit RC4) – enough for PDF.js to ask for a password.
function pdfEncryption(password: string) {
  const permissions = Buffer.alloc(4);
  permissions.writeInt32LE(-44);
  const id = md5(Buffer.from("finanzblick-synthetic-payslip"));
  const owner = rc4(md5(padPassword(`${password}-owner`)).subarray(0, 5), padPassword(password));
  const key = md5(padPassword(password), owner, permissions, id).subarray(0, 5);
  return {
    dictionary: `<< /Filter /Standard /V 1 /R 2 /O <${owner.toString("hex")}> /U <${rc4(key, passwordPadding).toString("hex")}> /P -44 >>`,
    id: id.toString("hex"),
    encrypt: (object: number, data: Buffer) =>
      rc4(md5(key, Buffer.from([object & 255, (object >> 8) & 255, (object >> 16) & 255, 0, 0])).subarray(0, 10), data),
  };
}

export function syntheticPayslipPdf(month = 10, gross = 4000, password?: string): Buffer {
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
  const encryption = password === undefined ? undefined : pdfEncryption(password);
  const content = encryption
    ? encryption.encrypt(5, Buffer.from(stream, "latin1")).toString("latin1")
    : stream;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
    ...(encryption ? [encryption.dictionary] : []),
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
  const secured = encryption ? ` /Encrypt 6 0 R /ID [<${encryption.id}> <${encryption.id}>]` : "";
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R${secured} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}
