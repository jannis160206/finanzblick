import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState } from "../src/lib/types";

const key = "finanzdashboard.v1";
const csvName = "Steuerjahr.csv";
const pdfName = "Reise.pdf";
const unrelated = "Andere.csv, Zeile 12: Weiter prüfen";
const csv = [
  "Revolut", "Persönliches Konto (EUR)", "Kontoauszug zu Transaktionen",
  "Datum;Beschreibung;Kategorie;Geld ein-/ausgezahlt;Guthaben",
  "01.09.2026;Umgetauscht in USD;Umtausch;-90,00€;500,00€",
  "02.09.2026;BIPA;Händler;-9,00€;491,00€",
  "Persönliches Konto (USD)", "Kontoauszug zu Transaktionen",
  "Datum;Beschreibung;Kategorie;Geld ein-/ausgezahlt;Geld ein-/ausgezahlt;Guthaben;Guthaben",
  "01.09.2026;Umgetauscht in USD;Umtausch;100,00$;89,80€;100,00$;89,80€",
  "02.09.2026;BIPA;Händler;-10,00$;-9,00€;90,00$;80,80€",
  "---------", "Investment Services Transaktionsnachweise", "Einheiten, die verkauft wurden",
  "Datum (des Verkaufs);Datum (des Kaufs);Beschreibung, Symbol und ISIN;Units sold;Wert (des Verkaufs);Wert (des Kaufs);Kapitalerträge",
  "03.09.2026;01.08.2026;Beispiel ETF;2;€200;€180;€20",
  "Andere Transaktionen Depotkonto",
  "Datum;Beschreibung und Symbol;ISIN;Anzahl;Bruttowert;Nettowert",
  "01.09.2026;Beispiel ETF;TEST;2;€180;€180",
  "---------", "Rohstoff Transaktionsnachweise",
  "Datum (des Verkaufs);Datum (des Kaufs);Rohstoffname;Verkaufte Einheiten;Wert (des Verkaufs);Wert (des Kaufs);Kapitalerträge",
  "03.09.2026;01.08.2026;XAG;1;+50,00$;-40,00$;10,00$",
].join("\n");

// Text-only synthetic PDF; no private bank files or passenger data.
function pdf(): Buffer {
  const flight = ["01.09 02.09 SWISS Intl Air Lines WIEN 125,00", "Flugstrecke:Von: WIEN", "Nach: ZURICH Fluglinie: LX Klasse: S"];
  const lines = ["American Express", "10.09.26", "Umsatz vom Buchung am Betrag in EUR",
    "01.09 02.09 WWW.OEBB.AT TICKET FOR WIEN 25,00", "111000111 OEBB TICKET 111000111",
    ...flight, ...flight,
    "01.09 02.09 HOTEL EXAMPLE 1,200.00 1.020,00", "UNITED STATES DOLLAR",
    "Referenzwechselkurs 1.2000 + Entgelt in EUR 20,00",
    "03.09 04.09 RENTALMOTORBIKE WIEN 85,00", "Autovermietung Ort: WIEN Datum: 03/09/26",
    "Kilometer Vertragsnummer:TEST_123"];
  const stream = `BT /F1 10 Tf 40 790 Td ${lines.map((line, index) => `${index ? "0 -18 Td " : ""}(${line.replace(/[\\()]/g, "\\$&")}) Tj`).join("\n")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let text = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text);
}

async function saved(page: Page): Promise<AppState> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}

test("travel PDF and Revolut tax CSV replace stale errors, preserve money and survive repeat imports", async ({ page }) => {
  const state = createSeed();
  state.transactions = [];
  state.importStatus = { imported: 0, issues: [
    `${pdfName}, Zeile 42: Alter Amex-Lesefehler`,
    `${csvName}, Zeile 50: Fremdwährung USD: nicht als Euro importiert.`, unrelated,
  ] };
  await page.clock.setFixedTime(new Date("2026-09-14T12:00:00Z"));
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
  await page.goto("/umsaetze");
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeVisible();
  const files = [
    { name: csvName, mimeType: "text/csv", buffer: Buffer.from(csv) },
    { name: pdfName, mimeType: "application/pdf", buffer: pdf() },
  ];
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles(files);
  await expect.poll(async () => (await saved(page)).importStatus?.issues).toEqual([unrelated]);
  // Ordinary merchant categorization remains separate from parser errors.
  const dialog = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
  for (let remaining = 5; remaining > 0; remaining--) {
    const before = (await saved(page)).reviewQueue?.length ?? 0;
    if (!before) break; // The closing dialog may remain mounted during its exit animation.
    await dialog.getByLabel("Kategorie", { exact: true }).first().selectOption("Freizeit");
    await dialog.getByRole("button", { name: "Zuordnung übernehmen" }).first().click();
    await expect.poll(async () => (await saved(page)).reviewQueue?.length ?? 0).toBeLessThan(before);
  }
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await saved(page)).transactions.length).toBe(9);
  const first = await saved(page);
  expect(first.transactions.filter((row) => row.bank === "Amex").map((row) => row.amount).sort((a, b) => a - b))
    .toEqual([-1020, -125, -125, -85, -25]);
  expect(first.transactions.filter((row) => row.description === "BIPA").map((row) => row.pocket).sort())
    .toEqual(["Persönliches Konto", "Persönliches Konto (USD)"]);
  expect(first.transactions.filter((row) => row.description === "BIPA").map((row) => row.amount)).toEqual([-9, -9]);
  expect(first.transactions.filter((row) => row.description.startsWith("Umgetauscht")).every((row) => row.category === "Transfer intern")).toBe(true);
  expect(first.transactions.find((row) => row.description === "HOTEL EXAMPLE")?.rawDetails)
    .toContain("Originalbetrag: 1,200.00 UNITED STATES DOLLAR");
  expect(first.accountSnapshots).toEqual([expect.objectContaining({ name: "Persönliches Konto", balance: 491 })]);
  await page.reload();
  const upload = page.getByRole("dialog", { name: "Uploadstatus", exact: true });
  await page.getByRole("button", { name: "Uploadstatus", exact: true }).click();
  await expect(upload.getByLabel("Importstatus")).toContainText("nicht lesbar 1");
  await page.keyboard.press("Escape");
  await expect(upload).toHaveCount(0);
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles(files);
  await expect(page.getByText("0 neu, 9 Duplikate ignoriert", { exact: true })).toBeVisible();
  if (await dialog.isVisible()) await dialog.getByRole("button", { name: "Prüfung schließen", exact: true }).click();
  expect((await saved(page)).transactions).toEqual(first.transactions);

  const broken = "Revolut\nPersönliches Konto (USD)\nKontoauszug zu Transaktionen\nDatum;Beschreibung;Geld ein-/ausgezahlt;Geld ein-/ausgezahlt\n02.09.2026;BIPA;-10,00$;\n---------\nDatum;Unbekanntes Layout\n03.09.2026;Nicht verstecken";
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles({ name: csvName, mimeType: "text/csv", buffer: Buffer.from(broken) });
  await expect.poll(async () => (await saved(page)).importStatus?.issues.length).toBe(3);
  const issues = (await saved(page)).importStatus!.issues;
  expect(issues).toEqual(expect.arrayContaining([unrelated, expect.stringContaining("Fremdwährung USD"), expect.stringContaining("Unbekannter Dateiabschnitt")]));
  expect((await saved(page)).transactions).toEqual(first.transactions);
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles(files);
  await expect.poll(async () => (await saved(page)).importStatus?.issues).toEqual([unrelated]);
  await page.reload();
  await page.getByRole("button", { name: "Uploadstatus", exact: true }).click();
  await expect(upload.getByLabel("Importstatus")).toContainText("nicht lesbar 1");
  await page.keyboard.press("Escape");
  await expect(upload).toHaveCount(0);
  expect((await saved(page)).transactions).toEqual(first.transactions);
});
