import { expect, test, type Page } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { AppState } from "../src/lib/types";

const key = "finanzdashboard.v1";
const noise = "POS 8,40 AT D1 04.09. 16:55 Kartenfolge-Nr.: 1";
const csv = (date: string, description: string, merchant: string) => Buffer.from(
  `Raiffeisen\nBuchungsdatum;Buchungstext;Valuta;Betrag;Verwendungszweck\n${date};${description};${date};-8,40;${merchant}`,
);

// Minimal text-only PDF fixture, produced locally rather than using bank data.
function pdf(lines: string[]): Buffer {
  const stream = `BT /F1 10 Tf 40 790 Td ${lines.map((line, index) => `${index ? "0 -18 Td " : ""}(${line.replace(/[\\()]/g, "\\$&")}) Tj`).join("\n")} ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(text)); text += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(text);
}
async function saved(page: Page): Promise<AppState> {
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeVisible();
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), key);
}

test("multi-file CSV/PDF drop repairs POS, learns the merchant and uses matching accent bubbles", async ({ page }) => {
  const state = createSeed();
  state.seasonalTheme = { accentColor: "#8b5cf6" };
  state.transactions = [{ id: "legacy-pos", date: "2026-09-04", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
    description: noise, amount: -8.4, category: "Sonstiges", includeInPlan: true }];
  await page.clock.setFixedTime(new Date("2026-09-14T12:00:00Z"));
  await page.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key, state });
  await page.goto("/umsaetze");
  await saved(page);
  const control = page.getByRole("button", { name: "Zuordnung prüfen", exact: true });
  const search = page.getByLabel("Umsätze durchsuchen");
  const dropzone = page.getByRole("region", { name: "Kontoauszüge importieren" });
  const filesButton = page.getByRole("button", { name: "Dateien auswählen", exact: true });
  await expect(dropzone.getByRole("button")).toHaveCount(1);
  const buttonBox = (await filesButton.boundingBox())!;
  const zoneBox = (await dropzone.boundingBox())!;
  expect(zoneBox.x + zoneBox.width - buttonBox.x - buttonBox.width).toBeLessThan(20);
  const iconBox = (await control.boundingBox())!;
  expect(iconBox.x + iconBox.width).toBeLessThan((await search.boundingBox())!.x);
  await expect(control.getByLabel("1 offene Zuordnungen")).toBeVisible();
  const files = [
    { name: "old.csv", type: "text/csv", bytes: [...csv("04.09.2026", noise, "MARTIN AUER ATRIOVIL VILLACH 9500")] },
    { name: "next.csv", type: "text/csv", bytes: [...csv("05.09.2026", "POS 8,40 AT D1 05.09. 17:00", "Martin Auer Klagenfurt 9020")] },
    { name: "card.pdf", type: "application/pdf", bytes: [...pdf(["American Express", "30.09.2026", "Umsatz vom Buchung am Betrag in EUR",
      "13.09 13.09 POS 5,00 AT D1 13.09. 18:30 Kartenfolge-Nr.: 1 5,00", "Verwendungszweck: BIPA VILLACH"])] },
  ];
  await dropzone.evaluate((element, files) => {
    const dataTransfer = new DataTransfer();
    for (const file of files) dataTransfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }, files);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Später prüfen" }).first().click();
  await expect(control.getByLabel("2 offene Zuordnungen")).toBeVisible();
  const nav = page.locator("aside").getByRole("link", { name: /^Umsätze/ });
  const iconBadge = control.getByLabel("2 offene Zuordnungen");
  const navBadge = nav.getByLabel("2 offene Zuordnungen");
  const colors: string[] = [];
  for (const badge of [iconBadge, navBadge]) {
    const shape = await badge.evaluate((element) => { const rect = element.getBoundingClientRect(); const css = getComputedStyle(element); return { width: rect.width, height: rect.height, color: css.backgroundColor, radius: css.borderRadius }; });
    expect(shape.width).toBe(shape.height);
    expect(shape.radius).not.toBe("0px");
    colors.push(shape.color);
    await expect(badge).toHaveClass(/bg-primary/);
  }
  expect(colors[0]).toBe(colors[1]);
  await page.reload();
  await expect(control.getByLabel("2 offene Zuordnungen")).toBeVisible();
  await control.click();
  await dialog.getByLabel("Kategorie", { exact: true }).first().selectOption("Freizeit");
  await dialog.getByRole("button", { name: "Zuordnung übernehmen" }).first().click();
  await expect(dialog).toHaveCount(0);
  await expect(control.locator("span")).toHaveCount(0);
  const learned = await saved(page);
  expect(learned.transactions).toHaveLength(3);
  expect(learned.transactions.find((row) => row.id === "legacy-pos")).toMatchObject({ rawDescription: noise, amount: -8.4, category: "Freizeit" });
  expect(learned.transactions.filter((row) => /martin auer/i.test(row.description)).every((row) => row.category === "Freizeit")).toBe(true);
  expect(learned.transactions.find((row) => row.bank === "Amex")).toMatchObject({ description: "BIPA VILLACH", category: "Mittagessen" });
  await page.reload();
  await page.getByLabel("Kontoauszüge auswählen").setInputFiles({ name: "later.csv", mimeType: "text/csv", buffer: csv("06.09.2026", "POS 8,40 AT D2 06.09. 09:00", "MARTIN AUER ANDERE FILIALE 8010") });
  await expect(page.getByText("1 neu, 0 Duplikate ignoriert", { exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  expect((await saved(page)).transactions).toHaveLength(4);
  await expect(page.getByRole("cell", { name: "MARTIN AUER ANDERE FILIALE 8010", exact: true })).toBeVisible();
  await expect(control.locator("span")).toHaveCount(0);
});
