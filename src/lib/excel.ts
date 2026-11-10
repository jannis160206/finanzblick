import ExcelJS from "exceljs";
import { isRaiffeisenBank } from "@/lib/accounts";
import { parseMoneyText } from "@/lib/money-parse";
import {
  appStateSchema,
  categorySchema,
  emptyMonth,
  emptyPockets,
  financeRowSchema,
  fixedReceiptSchema,
  merchantRuleSchema,
  merchantNameRuleSchema,
  settingsSchema,
  pocketNames,
  pocketSnapshotSchema,
  transactionSchema,
  type AppState,
  type Category,
  type FinanceRow,
  type Pocket,
  type Settings,
} from "@/lib/types";
import {
  calculateDashboard,
  classify,
  monthKey,
  monthsForYear,
  round,
  roundUpTotal,
} from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { assertImportSize } from "@/lib/import/limits";
import { applyVariableBudgets } from "@/lib/variable-budgets";
import { payslipSchema, payrollForecastSchema } from "@/lib/payslip-schema";
import { bankPocketBalance, coreBalanceKnown } from "@/lib/goals";

export const sheetNames = [
  "Dashboard",
  "Pockets",
  "Variablen-Plan",
  "Umsätze",
  "Finanzen 2026",
  "Finanzen 2027",
] as const;
const marker = "Finanzdashboard · v1";
const workbookMetadataSchema = appStateSchema.omit({
  version: true, settings: true, transactions: true, financeRows: true, months: true,
}).extend({
  interestRates: settingsSchema.shape.interestRates,
  unknownBalances: settingsSchema.shape.unknownBalances,
  asapReserve: settingsSchema.shape.asapReserve,
  savingsRate: settingsSchema.shape.savingsRate,
  accountKeep: settingsSchema.shape.accountKeep,
});
export type ImportResult = {
  state: AppState;
  warnings: string[];
  skipped: number;
  source: string;
  kind: "backup" | "transactions";
};
function value(cell: ExcelJS.Cell): string | number | boolean | Date | null {
  const v = cell.value;
  if (v == null) return null;
  if (typeof v !== "object" || v instanceof Date) return v;
  if ("result" in v)
    return v.result instanceof Date ||
      ["string", "number", "boolean"].includes(typeof v.result)
      ? (v.result as string | number | boolean | Date)
      : null;
  if ("richText" in v) return v.richText.map((part) => part.text).join("");
  if ("text" in v) return v.text;
  return null;
}
const text = (cell: ExcelJS.Cell) => String(value(cell) ?? "").trim();
function nativeIdentifier(cell: ExcelJS.Cell, location: string): string {
  const id = value(cell);
  if (typeof id !== "string" || !id.trim())
    throw new Error(`${location}: ID fehlt oder ist kein Text. Sicherungs-IDs werden nicht neu erzeugt oder umgeschrieben.`);
  return id;
}
function numeric(cell: ExcelJS.Cell): number | null {
  const v = value(cell);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || !v.trim()) return null;
  return parseMoneyText(v);
}
function isoDate(cell: ExcelJS.Cell, date1904 = false): string {
  const v = value(cell);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number")
    return new Date(
      Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30) +
        Math.floor(v) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
  const s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const de = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  return de
    ? `${de[3]}-${de[2].padStart(2, "0")}-${de[1].padStart(2, "0")}`
    : "";
}
function normalizeCategory(raw: string): Category {
  if (!raw.trim()) return "Prüfen";
  const category = categorySchema.safeParse(raw.trim());
  if (category.success) return category.data;
  if (/(?:amex|american express).*(?:abrechnung|sammel|ausgleich)/i.test(raw))
    return "Transfer intern";
  if (/(?:amex|american express).*(?:monatsgeb|platin)/i.test(raw))
    return "Bankgebühren";
  if (/spotify|abonnement|subscription|paypal.*abo/i.test(raw)) return "Abonnements";
  if (/transfer|umbuch|sparkonto|round-up/i.test(raw)) return "Transfer";
  if (/lebensmittel|haushalt/i.test(raw)) return "Lebensmittel";
  if (/mittag|hotspot|trafi/i.test(raw)) return "Mittagessen";
  if (/tanken|verkehr|mobil/i.test(raw)) return "Mobilität";
  if (/g2a|apple-guthaben/i.test(raw)) return "Guthabenkarten";
  if (/essen|restaurant/i.test(raw)) return "Restaurants";
  if (/gehalt|einkommen|rufbereitschaft/i.test(raw)) return "Einkommen";
  return "Sonstiges";
}
function normalizePocket(raw: string): Pocket | null {
  if (/notgroschen/i.test(raw)) return "Notgroschen";
  if (/urlaub/i.test(raw)) return "Urlaub";
  if (/sparkonto|^sparen$/i.test(raw)) return "Sparkonto";
  if (/motorrad/i.test(raw)) return "Motorrad";
  return null;
}
function isFormula(cell: ExcelJS.Cell) {
  return (
    typeof cell.value === "object" &&
    cell.value !== null &&
    ("formula" in cell.value || "sharedFormula" in cell.value)
  );
}

export async function parseWorkbook(
  buffer: ArrayBuffer,
): Promise<ImportResult> {
  assertImportSize(buffer.byteLength);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new Error(
      "Die Datei ist keine lesbare, unverschlüsselte XLSX-Arbeitsmappe.",
    );
  }
  if (
    workbook.worksheets.some(
      (sheet) => sheet.rowCount > 100_005 || sheet.columnCount > 200,
    )
  )
    throw new Error(
      "Die Arbeitsmappe überschreitet die erlaubte Tabellengröße.",
    );
  const state = createSeed();
  state.settings.balances = emptyPockets();
  state.financeRows = [];
  const warnings: string[] = [];
  let skipped = 0;
  const dashboard = workbook.getWorksheet("Dashboard");
  const native = dashboard && text(dashboard.getCell("A1")) === marker;
  const transactionSheet = workbook.getWorksheet("Umsätze");
  const missingSheets = sheetNames.filter((name) => !workbook.getWorksheet(name));
  const kind = missingSheets.length === 0 ? "backup" : "transactions";
  if (native && missingSheets.length) throw new Error(
    `Unvollständige Sicherung: ${missingSheets.join(", ")} fehlen. Einzelne Buchungsdateien bitte unter Umsätze importieren.`,
  );
  if (
    !dashboard &&
    !transactionSheet &&
    !workbook.getWorksheet("Finanzen 2026")
  )
    throw new Error(
      "Keine unterstützten Tabellen gefunden. Erwartet werden Dashboard, Umsätze oder Finanzen 2026.",
    );
  for (const name of sheetNames)
    if (!workbook.getWorksheet(name))
      warnings.push(
        `Blatt „${name}“ fehlt. Keine zugehörigen Anfangswerte werden übernommen; die Datei ist keine vollständige Sicherung.`,
      );
  if (dashboard && native) {
    dashboard.eachRow((row, index) => {
      if (index < 3) return;
      const key = text(row.getCell(1));
      if (
        !(key in state.settings) ||
        key === "balances" ||
        key === "interestRates" ||
        key === "unknownBalances"
      )
        return;
      const original = state.settings[key as keyof Settings];
      const next =
        typeof original === "number"
          ? numeric(row.getCell(3))
          : isoDate(row.getCell(3), workbook.properties.date1904);
      if (next !== null && next !== "")
        Object.assign(state.settings, { [key]: next });
    });
  } else if (dashboard) {
    const map: Record<string, keyof Settings> = {
      C4: "bikeTarget",
      C5: "bikeShare",
      C8: "emergencyTarget",
      C9: "vacationTarget",
      C10: "savingsTarget",
      C11: "afterBikeSavingsShare",
      F8: "oldRate",
      F9: "newRate",
      F10: "taxRate",
    };
    for (const [address, key] of Object.entries(map)) {
      const n = numeric(dashboard.getCell(address));
      if (n !== null) Object.assign(state.settings, { [key]: n });
    }
    const purchase = isoDate(
      dashboard.getCell("C14"),
      workbook.properties.date1904,
    );
    if (purchase) state.settings.bikePurchaseDate = purchase;
  }
  const pockets = workbook.getWorksheet("Pockets");
  const importedPockets = new Set<Pocket>();
  pockets?.eachRow((row) => {
    const name = text(row.getCell(1));
    const n = numeric(row.getCell(2));
    if (pocketNames.includes(name as Pocket) && n !== null) {
      if (importedPockets.has(name as Pocket)) throw new Error(`Doppelter Pocket-Startstand „${name}“ in der Sicherung.`);
      importedPockets.add(name as Pocket);
      state.settings.balances[name as Pocket] = n;
    }
  });
  if (kind === "backup" && importedPockets.size !== pocketNames.length)
    throw new Error("Die Sicherung enthält nicht für jeden Pocket einen belegten Startstand. Vorhandene Daten bleiben unverändert.");
  if (transactionSheet) {
    let headerRow = 0;
    const columns: Record<string, number> = {};
    transactionSheet.eachRow((row, index) => {
      if (headerRow || index > 15) return;
      row.eachCell((cell, col) => {
        if (/^(datum|date)$/i.test(text(cell))) headerRow = index;
        if (text(cell)) columns[text(cell).toLowerCase()] = col;
      });
      if (!headerRow)
        Object.keys(columns).forEach((key) => delete columns[key]);
    });
    const col = (...names: string[]) =>
      names.map((name) => columns[name.toLowerCase()]).find(Boolean);
    const dateCol = col("Datum", "Date");
    const amountCol = col("Betrag", "Amount");
    const descriptionCol = col("Beschreibung", "Description");
    if (!headerRow || !dateCol || !amountCol || !descriptionCol)
      throw new Error(
        "Umsätze: Spalten Datum, Beschreibung und Betrag fehlen.",
      );
    transactionSheet.eachRow((row, index) => {
      if (index <= headerRow) return;
      const amount = numeric(row.getCell(amountCol));
      const description = text(row.getCell(descriptionCol));
      if (amount === null && !description) return;
      const get = (...names: string[]) => row.getCell(col(...names) ?? 200);
      const planCell = get("Im Plan (Eingabe)", "Im Plan");
      const fixedCostCell = text(get("Fixkosten"));
      const reviewedCell = text(get("Geprüft"));
      const manualCategoryCell = text(get("Kategorie ausdrücklich gewählt"));
      const bank = text(get("Bank")) || "Unbekannt";
      const candidate = {
        id: native ? nativeIdentifier(get("ID"), `Umsätze, Zeile ${index}`) : text(get("ID")) || `xlsx-${index}`,
        date: isoDate(row.getCell(dateCol), workbook.properties.date1904),
        amount,
        description,
        bank,
        pocket: native || isRaiffeisenBank(bank)
          ? text(get("Pocket", "Konto")) || null
          : normalizePocket(text(get("Pocket", "Konto"))),
        category: normalizeCategory(text(get("Kategorie", "Category"))),
        includeInPlan:
          isFormula(planCell) || !/^(nein|false|0)$/i.test(text(planCell)),
        ...(fixedCostCell
          ? { fixedCost: /^(ja|true|1)$/i.test(fixedCostCell) ? true : /^(nein|false|0)$/i.test(fixedCostCell) ? false : fixedCostCell }
          : {}),
        ...(native && reviewedCell
          ? { reviewed: /^(ja|true|1)$/i.test(reviewedCell) ? true : /^(nein|false|0)$/i.test(reviewedCell) ? false : reviewedCell }
          : {}),
        ...(native && manualCategoryCell
          ? { manualCategory: /^(ja|true|1)$/i.test(manualCategoryCell) ? true : /^(nein|false|0)$/i.test(manualCategoryCell) ? false : manualCategoryCell }
          : {}),
        ...(native && text(get("Händleralias")) ? { merchantAlias: text(get("Händleralias")) } : {}),
        ...(native && text(get("Händler-ID")) ? { merchantId: text(get("Händler-ID")) } : {}),
        ...(native && text(get("Händlerlogo vorhanden")) ? { merchantLogo:
          /^(ja|true|1)$/i.test(text(get("Händlerlogo vorhanden"))) ? true :
            /^(nein|false|0)$/i.test(text(get("Händlerlogo vorhanden"))) ? false : text(get("Händlerlogo vorhanden")) } : {}),
        ...(native && text(get("Händler-Treffertyp")) ? { merchantMatch: text(get("Händler-Treffertyp")) } : {}),
        ...(native && text(get("Händlername bestätigt")) ? { merchantNameConfirmed:
          /^(ja|true|1)$/i.test(text(get("Händlername bestätigt"))) ? true :
            /^(nein|false|0)$/i.test(text(get("Händlername bestätigt"))) ? false : text(get("Händlername bestätigt")) } : {}),
        ...(native && text(get("Zuordnung gesperrt")) ? { is_locked:
          /^(ja|true|1)$/i.test(text(get("Zuordnung gesperrt"))) ? true :
            /^(nein|false|0)$/i.test(text(get("Zuordnung gesperrt"))) ? false : text(get("Zuordnung gesperrt")) } : {}),
        ...(native && text(get("Automatische Zuordnung unsicher")) ? { requires_manual_review:
          /^(ja|true|1)$/i.test(text(get("Automatische Zuordnung unsicher"))) ? true :
            /^(nein|false|0)$/i.test(text(get("Automatische Zuordnung unsicher"))) ? false : text(get("Automatische Zuordnung unsicher")) } : {}),
        ...(native && text(get("Bankreferenz"))
          ? { bankReference: text(get("Bankreferenz")) }
          : {}),
        ...(native && text(get("Uhrzeit")) ? { time: text(get("Uhrzeit")) } : {}),
        ...(native && text(get("Geteilt mit Raphael")) ? { sharedWithRaphael: /^(ja|true|1)$/i.test(text(get("Geteilt mit Raphael"))) } : {}),
        ...(native && /^(ja|true|1)$/i.test(text(get("Ignoriert"))) ? { ignored: true } : {}),
        ...(native && text(get("Tags")) ? { tags: text(get("Tags")).split(",").map((tag) => tag.trim().slice(0, 40)).filter(Boolean).slice(0, 10) } : {}),
        ...(native && text(get("Geteilt manuell bezahlt")) ? { sharedPaidManually: /^(ja|true|1)$/i.test(text(get("Geteilt manuell bezahlt"))) } : {}),
        ...(native && value(get("Händlererstattung für")) !== null && value(get("Händlererstattung für")) !== ""
          ? { sharedRefundFor: value(get("Händlererstattung für")) } : {}),
        ...(native && text(get("Erstattung nicht geteilt")) ? { sharedRefundUnlinked:
          /^(ja|true|1)$/i.test(text(get("Erstattung nicht geteilt"))) ? true :
            /^(nein|false|0)$/i.test(text(get("Erstattung nicht geteilt"))) ? false : text(get("Erstattung nicht geteilt")) } : {}),
        ...(native && value(get("Partnerzahlung für")) !== null && value(get("Partnerzahlung für")) !== ""
          ? { sharedRepaymentFor: value(get("Partnerzahlung für")) } : {}),
        ...(native && text(get("Manuell bezahlter Partneranteil"))
          ? { sharedPaidAmount: numeric(get("Manuell bezahlter Partneranteil")) } : {}),
        ...(text(get("Originalbeschreibung")) ? { rawDescription: text(get("Originalbeschreibung")) } : {}),
        ...(text(get("Händlerdetails")) ? { rawDetails: text(get("Händlerdetails")).split("\n") } : {}),
        ...(native && text(get("Amex-Quelle")) ? { amexSource: text(get("Amex-Quelle")) } : {}),
        ...(native && text(get("Amex-Status")) ? { amexStatus: text(get("Amex-Status")) } : {}),
        ...(native && text(get("Amex-Aufnahme")) ? { amexCapturedAt: isoDate(get("Amex-Aufnahme"), workbook.properties.date1904) } : {}),
        ...(native && text(get("Amex-Zeitraum")) ? { amexPeriodStart: isoDate(get("Amex-Zeitraum"), workbook.properties.date1904) } : {}),
        ...(native && text(get("Amex-Bildidentitäten")) ? { amexScreenshotKeys: text(get("Amex-Bildidentitäten")).split("\n") } : {}),
        ...(native && numeric(get("Vorkommen")) !== null
          ? { occurrence: numeric(get("Vorkommen")) }
          : {}),
        ...(native && text(get("Nach Ist-Basis"))
          ? {
              afterBaseline: /^(ja|true|1)$/i.test(text(get("Nach Ist-Basis"))),
            }
          : {}),
        ...(native && text(get("Kategorie manuell"))
          ? {
              categoryOverride: /^(ja|true|1)$/i.test(
                text(get("Kategorie manuell")),
              ),
            }
          : {}),
        ...(native && text(get("Quellkategorie"))
          ? { sourceCategory: text(get("Quellkategorie")) }
          : !native && text(get("Kategorie", "Category"))
            ? { sourceCategory: text(get("Kategorie", "Category")) }
            : {}),
      };
      const parsed = transactionSchema.safeParse(candidate);
      if (parsed.success) state.transactions.push(parsed.data);
      else if (native) throw new Error(`Umsätze, Zeile ${index}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
      else skipped++;
    });
    if (
      new Set(state.transactions.map((row) => row.id)).size !==
      state.transactions.length
    )
      throw new Error(
        "Doppelte Umsatz-IDs gefunden. Bitte die IDs in der Datei korrigieren.",
      );
  }
  const rows = new Map<string, FinanceRow>();
  for (const year of [2026, 2027]) {
    const sheet = workbook.getWorksheet(`Finanzen ${year}`);
    if (!sheet) continue;
    const keys = monthsForYear(year);
    if (native) {
      const sheetIds = new Set<string>();
      sheet.eachRow((row, index) => {
        if (index < 2) return;
        const kind = text(row.getCell(1));
        const label = text(row.getCell(2));
        if (["income", "fixed", "variable"].includes(kind)) {
          const id = nativeIdentifier(row.getCell(16), `Finanzen ${year}, Zeile ${index}`);
          if (sheetIds.has(id)) throw new Error(
            `Doppelte Finanzzeilen-ID „${id}“ in Finanzen ${year}, Zeile ${index}. Keine Zeilen wurden zusammengeführt.`,
          );
          sheetIds.add(id);
          const previous = rows.get(id);
          if (previous && (previous.kind !== kind || previous.label !== label)) throw new Error(
            `Finanzzeilen-ID „${id}“ bezeichnet in den Jahresblättern unterschiedliche Zeilen.`,
          );
          const item = rows.get(id) ?? {
            id,
            label,
            kind: kind as FinanceRow["kind"],
            values: {},
          };
          const category = text(row.getCell(15));
          const parsedCategory = categorySchema.safeParse(category);
          if (parsedCategory.success) item.planCategory = parsedCategory.data;
          const overrides = text(row.getCell(17));
          const fixedSource = text(row.getCell(19));
          if (fixedSource) {
            let source: unknown;
            try {
              source = JSON.parse(fixedSource);
            } catch (error) {
              if (error instanceof SyntaxError) throw new Error("Ungültige Fixkosten-Verknüpfung in der Excel-Sicherung.");
              throw error;
            }
            const parsedSource = financeRowSchema.shape.fixedSource.safeParse(source);
            if (!parsedSource.success) throw new Error("Ungültige Fixkosten-Verknüpfung in der Excel-Sicherung.");
            item.fixedSource = parsedSource.data;
          }
          if (overrides) {
            try {
              item.overrides = {
                ...financeRowSchema.shape.overrides.parse(
                  JSON.parse(overrides),
                ),
                ...item.overrides,
              };
            } catch {
              throw new Error(
                "Ungültige Monats-Overrides in der Excel-Sicherung.",
              );
            }
          }
          const referenceText = text(row.getCell(18));
          let reference: FinanceRow["values"] | undefined;
          if (referenceText) {
            try {
              reference = financeRowSchema.shape.values.parse(
                JSON.parse(referenceText),
              );
            } catch {
              throw new Error(
                "Ungültige Exportreferenzwerte in der Excel-Sicherung.",
              );
            }
          }
          keys.forEach((key, i) => {
            const raw = text(row.getCell(i + 3));
            if (raw !== "" || reference?.[key] !== undefined) {
              const next =
                raw === "Auto" || raw === ""
                  ? null
                  : numeric(row.getCell(i + 3));
              item.values[key] = next;
              if (
                kind === "variable" &&
                (reference ? next !== reference[key] : next !== null)
              ) {
                item.overrides = { ...item.overrides, [key]: next };
              }
            }
          });
          rows.set(id, item);
        } else if (kind === "input") {
          keys.forEach((key, i) => {
            const input = state.months[key] ?? emptyMonth();
            const n = numeric(row.getCell(i + 3));
            if (label === "Variabel gesamt (Override)")
              input.variableOverride = n;
            if (label === "Motorradrate (Override)") input.bikeOverride = n;
            for (const pocket of pocketNames) {
              if (label === `${pocket} Startbasis` && n !== null)
                input.openingBalances = {
                  ...(input.openingBalances ?? emptyPockets()),
                  [pocket]: n,
                };
              if (label === `${pocket} + extra`)
                input.pocketIn[pocket] = n ?? 0;
              if (label === `${pocket} Entnahme`)
                input.pocketOut[pocket] = n ?? 0;
            }
            state.months[key] = input;
          });
        }
      });
    } else {
      for (const [kind, first, last] of [
        ["income", 5, 8],
        ["fixed", 12, 26],
        ["variable", 30, 39],
      ] as const) {
        for (let rowIndex = first; rowIndex <= last; rowIndex++) {
          const label = text(sheet.getCell(rowIndex, 3));
          if (!label) continue;
          const id = `${kind}-${rowIndex}`;
          const item: FinanceRow = rows.get(id) ?? {
            id,
            label,
            kind,
            values: {},
          };
          if (kind === "variable" && rowIndex <= 34)
            item.planCategory = normalizeCategory(label);
          keys.forEach((key, i) => {
            const cell = sheet.getCell(rowIndex, i + 6);
            item.values[key] =
              kind === "variable" && isFormula(cell) && item.planCategory
                ? null
                : Math.max(0, numeric(cell) ?? 0);
          });
          rows.set(id, item);
        }
      }
      keys.forEach((key, i) => {
        const input = emptyMonth();
        if (key === "2026-01")
          input.openingBalances = {
            Notgroschen: numeric(sheet.getCell("F55")) ?? 0,
            Urlaub: numeric(sheet.getCell("F59")) ?? 0,
            Sparkonto: numeric(sheet.getCell("F63")) ?? 0,
            Motorrad: numeric(sheet.getCell("F74")) ?? 0,
          };
        if (key !== monthKey(state.settings.baselineDate)) {
          if (key < monthKey(state.settings.baselineDate)) {
            for (const [pocket, rowIndex] of [
              ["Notgroschen", 46],
              ["Urlaub", 47],
              ["Sparkonto", 48],
              ["Motorrad", 49],
            ] as const)
              input.pocketIn[pocket] = Math.max(
                0,
                numeric(sheet.getCell(rowIndex, i + 6)) ?? 0,
              );
          }
          for (const [pocket, rowIndex] of [
            ["Notgroschen", 57],
            ["Urlaub", 61],
            ["Sparkonto", 65],
            ["Motorrad", 76],
          ] as const) {
            const withdrawal = numeric(sheet.getCell(rowIndex, i + 6)) ?? 0;
            if (withdrawal >= 0) input.pocketOut[pocket] = withdrawal;
            else
              input.pocketIn[pocket] = round(
                input.pocketIn[pocket] - withdrawal,
              );
          }
        }
        state.months[key] = input;
      });
    }
  }
  if (rows.size) state.financeRows = [...rows.values()];
  if (native) {
    const automation = workbook.getWorksheet("Import-Abgleich");
    const metadataParts = new Map<number, string>();
    let metadataCount: number | undefined;
    automation?.eachRow((row, index) => {
      if (index <= 1) return;
      const kind = text(row.getCell(1));
      if (kind === "metadata-v1-part") {
        const part = numeric(row.getCell(3));
        const count = numeric(row.getCell(4));
        if (part === null || count === null || !Number.isInteger(part) || !Number.isInteger(count) ||
          count < 1 || count > 1000 || part < 0 || part >= count ||
          (metadataCount !== undefined && metadataCount !== count) || metadataParts.has(part))
          throw new Error("Ungültige oder doppelte Metadaten-Teile in der Excel-Sicherung.");
        metadataCount = count;
        metadataParts.set(part, String(value(row.getCell(2)) ?? ""));
        return;
      }
      try {
        const data = JSON.parse(text(row.getCell(2)));
        if (kind === "ux") {
          Object.assign(
            state,
            appStateSchema
              .pick({
                accountSnapshots: true,
                amexBalanceSnapshots: true,
                amexScreenshotValidation: true,
                trBalances: true,
                reviewQueue: true,
                importStatus: true,
                fixedAmountDecisions: true,
                savingsGoals: true,
                pocketOpeningBalances: true,
                bikeOnlyGoalApplied: true,
                seasonalTheme: true,
                holidayRanges: true,
                plannedOneOffs: true,
                plannedOneOffsSeeded: true,
                annualSixth: true,
              })
              .parse(data),
          );
          if (data.interestRates !== undefined)
            state.settings.interestRates =
              settingsSchema.shape.interestRates.parse(data.interestRates);
        }
        if (kind === "pocket")
          (state.pocketSnapshots ??= []).push(pocketSnapshotSchema.parse(data));
        if (kind === "merchant")
          (state.merchantRules ??= []).push(merchantRuleSchema.parse(data));
        if (kind === "merchant-name")
          (state.merchantNameRules ??= []).push(merchantNameRuleSchema.parse(data));
        if (kind === "fixed")
          (state.fixedReceipts ??= []).push(fixedReceiptSchema.parse(data));
        if (kind === "payslip")
          (state.payslips ??= []).push(payslipSchema.parse(data));
        if (kind === "payroll-forecast")
          (state.payrollForecasts ??= []).push(payrollForecastSchema.parse(data));
        if (kind === "planning-repairs")
          state.planningRepairs =
            appStateSchema.shape.planningRepairs.parse(data);
      } catch {
        throw new Error(
          "Ungültige Import-Abgleichdaten in der Excel-Sicherung.",
        );
      }
    });
    if (metadataCount !== undefined) {
      if (metadataParts.size !== metadataCount)
        throw new Error("Unvollständige Metadaten in der Excel-Sicherung. Vorhandene Daten bleiben unverändert.");
      const raw = Array.from({ length: metadataCount }, (_, index) => metadataParts.get(index)).join("");
      let metadata: unknown;
      try {
        metadata = JSON.parse(raw);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error("Unlesbare Metadaten in der Excel-Sicherung.");
      }
      const parsedMetadata = workbookMetadataSchema.safeParse(metadata);
      if (!parsedMetadata.success) throw new Error(
        `Ungültige Sicherungsmetadaten: ${parsedMetadata.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`,
      );
      const { interestRates, unknownBalances, asapReserve, savingsRate, accountKeep, ...stateMetadata } = parsedMetadata.data;
      Object.assign(state, stateMetadata);
      if (interestRates !== undefined) state.settings.interestRates = interestRates;
      if (unknownBalances !== undefined) state.settings.unknownBalances = unknownBalances;
      if (asapReserve !== undefined) state.settings.asapReserve = asapReserve;
      if (savingsRate !== undefined) state.settings.savingsRate = savingsRate;
      if (accountKeep !== undefined) state.settings.accountKeep = accountKeep;
    }
    if (dashboard && text(dashboard.getCell("E1")) === "metadata-v1" &&
      metadataCount !== numeric(dashboard.getCell("F1")))
      throw new Error("Sicherungsmetadaten fehlen oder sind unvollständig. Vorhandene Daten bleiben unverändert.");
    const decisions = workbook.getWorksheet("Import-Entscheidungen");
    if (decisions) {
      state.ignoredStatementKeys = [];
      decisions.eachRow((row, index) => {
        if (index > 1 && text(row.getCell(1)))
          state.ignoredStatementKeys!.push(text(row.getCell(1)));
      });
    }
  }
  const validated = appStateSchema.safeParse(state);
  if (!validated.success)
    throw new Error(
      `Ungültige Arbeitsmappe: ${validated.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  const normalized = applyVariableBudgets(validated.data);
  normalized.financeRows = appStateSchema.shape.financeRows.parse(normalized.financeRows);
  return {
    state: normalized,
    warnings,
    skipped,
    source: native ? "Finanzdashboard" : "Excel-Originalmappe",
    kind,
  };
}

// Planning settings of the savings goal dialog travel in the metadata, not as sheet rows.
type SheetSetting = Exclude<keyof Settings, "balances" | "interestRates" | "unknownBalances" | "asapReserve" | "savingsRate" | "accountKeep">;
const settingLabels: Record<
  SheetSetting,
  string
> = {
  asOf: "Stichtag",
  baselineDate: "Ist-Datum",
  emergencyTarget: "Ziel Notgroschen",
  vacationTarget: "Ziel Urlaub",
  savingsTarget: "Ziel Sparkonto",
  bikeTarget: "Ziel Motorrad",
  bikePurchaseDate: "Kauf Motorrad",
  allocationStart: "Sparverteilung ab",
  bikeShare: "Motorrad-Anteil vor Ziel",
  afterBikeSavingsShare: "Sparkonto-Anteil nach Ziel",
  oldRate: "TR-Zins vor Wechsel",
  newRate: "TR-Zins nach Wechsel",
  rateChangeDate: "Neuer Zinssatz ab",
  taxRate: "KESt",
  interestStart: "Verzinsung ab",
};
export async function exportWorkbook(state: AppState): Promise<ArrayBuffer> {
  state = applyVariableBudgets(appStateSchema.parse(state));
  state.financeRows = appStateSchema.shape.financeRows.parse(state.financeRows);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Finanzdashboard";
  workbook.created = new Date();
  const d = calculateDashboard(state);
  const dashboard = workbook.addWorksheet("Dashboard");
  dashboard.addRow([marker]);
  dashboard.addRow(["Schlüssel", "Einstellung", "Wert"]);
  for (const [key, label] of Object.entries(settingLabels))
    dashboard.addRow([
      key,
      label,
      state.settings[
        key as SheetSetting
      ],
    ]);
  dashboard.addRow([]);
  dashboard.addRow(["Berechnet", "Gesamtvermögen", d.totalAssets]);
  dashboard.addRow([
    "Berechnet",
    "Motorradrate benötigt",
    d.countdown.required,
  ]);
  dashboard.addRow([
    "90 Tage",
    "Einnahmen",
    "Fixkosten",
    "Variabel",
    "Motorrad",
    "Verfügbar",
  ]);
  d.ninetyDays.forEach((row) =>
    dashboard.addRow([
      row.month,
      row.income,
      row.fixed,
      row.variablePlan,
      row.bikeTransfer,
      row.remaining,
    ]),
  );
  const pockets = workbook.addWorksheet("Pockets");
  pockets.addRow([
    "Pocket",
    "Ist-Basis",
    "Aktueller Ist",
    "Ist-Basis belegt",
    "Aktueller Ist belegt",
    ...d.timeline.filter((row) => row.available).map((row) => row.month),
  ]);
  pocketNames.forEach((pocket) => {
    const actual = bankPocketBalance(state, pocket, d.actual);
    pockets.addRow([
      pocket,
      state.settings.balances[pocket],
      actual,
      coreBalanceKnown(state, pocket) ? "Ja" : "Unbekannt",
      actual !== null ? "Ja" : "Unbekannt",
      ...d.timeline
        .filter((row) => row.available)
        .map((row) => row.end[pocket]),
    ]);
  });
  pockets.addRow([]);
  pockets.addRow(["Monat", "Round-up"]);
  [...new Set(state.transactions.map((row) => monthKey(row.date)))]
    .sort()
    .forEach((month) =>
      pockets.addRow([month, roundUpTotal(state.transactions, month)]),
    );
  const plan = workbook.addWorksheet("Variablen-Plan");
  plan.addRow(["Position", "Kategorie", d.plan.currentMonth]);
  d.plan.rows.forEach((row) => plan.addRow([row.label, row.category ?? "", row.total]));
  plan.addRow(["Gesamt", "", d.plan.total]);
  const transactions = workbook.addWorksheet("Umsätze");
  transactions.addRow([
    "Datum",
    "Bank",
    "Pocket",
    "Beschreibung",
    "Kategorie",
    "Betrag",
    "Monat",
    "Plan-Kat",
    "Im Plan",
    "ID",
    "Im Plan (Eingabe)",
    "Nach Ist-Basis",
    "Kategorie manuell",
    "Quellkategorie",
    "Bankreferenz",
    "Vorkommen",
    "Uhrzeit",
    "Originalbeschreibung",
    "Händlerdetails",
    "Geteilt mit Raphael",
    "Geteilt manuell bezahlt",
    "Fixkosten",
    "Geprüft",
    "Händleralias",
    "Kategorie ausdrücklich gewählt",
    "Amex-Quelle",
    "Amex-Status",
    "Amex-Aufnahme",
    "Amex-Zeitraum",
    "Amex-Bildidentitäten",
    "Händler-ID",
    "Zuordnung gesperrt",
    "Automatische Zuordnung unsicher",
    "Händlerlogo vorhanden",
    "Händler-Treffertyp",
    "Händlername bestätigt",
    "Händlererstattung für",
    "Erstattung nicht geteilt",
    "Partnerzahlung für",
    "Manuell bezahlter Partneranteil",
    "Ignoriert",
    "Tags",
  ]);
  state.transactions.forEach((row) => {
    const result = classify(row);
    transactions.addRow([
      row.date,
      row.bank,
      row.pocket ?? "",
      row.description,
      row.category,
      row.amount,
      monthKey(row.date),
      result.planCategory,
      result.includeInPlan ? "Ja" : "Nein",
      row.id,
      row.includeInPlan ? "Ja" : "Nein",
      row.afterBaseline === undefined ? "" : row.afterBaseline ? "Ja" : "Nein",
      row.categoryOverride === undefined
        ? ""
        : row.categoryOverride
          ? "Ja"
          : "Nein",
      row.sourceCategory ?? "",
      row.bankReference ?? "",
      row.occurrence ?? "",
      row.time ?? "",
      row.rawDescription ?? "",
      row.rawDetails?.join("\n") ?? "",
      row.sharedWithRaphael === undefined ? "" : row.sharedWithRaphael ? "Ja" : "Nein",
      row.sharedPaidManually === undefined ? "" : row.sharedPaidManually ? "Ja" : "Nein",
      row.fixedCost === undefined ? "" : row.fixedCost ? "Ja" : "Nein",
      row.reviewed === undefined ? "" : row.reviewed ? "Ja" : "Nein",
      row.merchantAlias ?? "",
      row.manualCategory === undefined ? "" : row.manualCategory ? "Ja" : "Nein",
      row.amexSource ?? "",
      row.amexStatus ?? "",
      row.amexCapturedAt ?? "",
      row.amexPeriodStart ?? "",
      row.amexScreenshotKeys?.join("\n") ?? "",
      row.merchantId ?? "",
      row.is_locked === undefined ? "" : row.is_locked ? "Ja" : "Nein",
      row.requires_manual_review === undefined ? "" : row.requires_manual_review ? "Ja" : "Nein",
      row.merchantLogo === undefined ? "" : row.merchantLogo ? "Ja" : "Nein",
      row.merchantMatch ?? "",
      row.merchantNameConfirmed === undefined ? "" : row.merchantNameConfirmed ? "Ja" : "Nein",
      row.sharedRefundFor ?? "",
      row.sharedRefundUnlinked === undefined ? "" : row.sharedRefundUnlinked ? "Ja" : "Nein",
      row.sharedRepaymentFor ?? "",
      row.sharedPaidAmount ?? "",
      row.ignored ? "Ja" : "",
      row.tags?.join(", ") ?? "",
    ]);
  });
  for (const year of [2026, 2027]) {
    const sheet = workbook.addWorksheet(`Finanzen ${year}`);
    const keys = monthsForYear(year);
    const timeline = d.timeline.filter((row) =>
      row.month.startsWith(String(year)),
    );
    sheet.addRow([
      "Typ",
      "Position",
      ...keys,
      "Plankategorie",
      "ID",
      "Monats-Overrides",
      "Exportreferenzwerte",
      "Fixkosten-Verknüpfung",
    ]);
    state.financeRows.forEach((row) =>
      sheet.addRow([
        row.kind,
        row.label,
        ...keys.map((key) =>
          row.values[key] === null ? "Auto" : (row.values[key] ?? ""),
        ),
        row.planCategory ?? "",
        row.id,
        row.overrides === undefined ? "" : JSON.stringify(row.overrides),
        JSON.stringify(row.values),
        row.fixedSource ? JSON.stringify(row.fixedSource) : "",
      ]),
    );
    sheet.getColumn(17).hidden = true;
    sheet.getColumn(18).hidden = true;
    sheet.getColumn(19).hidden = true;
    sheet.addRow([
      "input",
      "Variabel gesamt (Override)",
      ...keys.map((key) => state.months[key]?.variableOverride ?? "Auto"),
    ]);
    sheet.addRow([
      "input",
      "Motorradrate (Override)",
      ...keys.map((key) => state.months[key]?.bikeOverride ?? "Auto"),
    ]);
    const calculations = {
      income: "Einnahmen",
      fixed: "Fixkosten",
      amexOpen: "Amex offen",
      variablePlan: "Variable Ausgaben",
      surplus: "Überschuss",
      bikeTransfer: "Motorradrate",
      remaining: "Verfügbar",
      interest: "Zinsen netto TR",
    } as const;
    for (const [key, label] of Object.entries(calculations))
      sheet.addRow([
        "calc",
        label,
        ...timeline.map((row) => row[key as keyof typeof calculations]),
      ]);
    for (const pocket of pocketNames) {
      sheet.addRow([
        "input",
        `${pocket} Startbasis`,
        ...keys.map(
          (key) => state.months[key]?.openingBalances?.[pocket] ?? "",
        ),
      ]);
      sheet.addRow([
        "calc",
        `${pocket} Start`,
        ...timeline.map((row) => (row.available ? row.start[pocket] : "")),
      ]);
      sheet.addRow([
        "calc",
        `${pocket} + Rate`,
        ...timeline.map((row) => row.rates[pocket]),
      ]);
      sheet.addRow([
        "input",
        `${pocket} + extra`,
        ...keys.map((key) => state.months[key]?.pocketIn[pocket] ?? 0),
      ]);
      sheet.addRow([
        "input",
        `${pocket} Entnahme`,
        ...keys.map((key) => state.months[key]?.pocketOut[pocket] ?? 0),
      ]);
      sheet.addRow([
        "calc",
        `${pocket} Buchungen`,
        ...timeline.map((row) => row.movement[pocket]),
      ]);
      sheet.addRow([
        "calc",
        `${pocket} Ende`,
        ...timeline.map((row) => (row.available ? row.end[pocket] : "")),
      ]);
    }
  }
  if (state.ignoredStatementKeys !== undefined) {
    const decisions = workbook.addWorksheet("Import-Entscheidungen", {
      state: "hidden",
    });
    decisions.addRow(["Bereits geprüfte Fixkostenbuchungen"]);
    state.ignoredStatementKeys.forEach((key) => decisions.addRow([key]));
  }
  const metadata = workbookMetadataSchema.parse({
    ...state, interestRates: state.settings.interestRates, unknownBalances: state.settings.unknownBalances,
    asapReserve: state.settings.asapReserve, savingsRate: state.settings.savingsRate, accountKeep: state.settings.accountKeep,
  });
  if (Object.keys(metadata).length) {
    const automation = workbook.addWorksheet("Import-Abgleich", {
      state: "hidden",
    });
    automation.addRow(["Typ", "Sicherungsdaten", "Teil", "Anzahl"]);
    const raw = JSON.stringify(metadata);
    const parts: string[] = [];
    for (let start = 0; start < raw.length;) {
      let end = Math.min(start + 30_000, raw.length);
      const last = raw.charCodeAt(end - 1);
      if (end < raw.length && last >= 0xd800 && last <= 0xdbff) end--;
      parts.push(raw.slice(start, end));
      start = end;
    }
    parts.forEach((part, index) => automation.addRow(["metadata-v1-part", part, index, parts.length]));
    dashboard.getCell("E1").value = "metadata-v1";
    dashboard.getCell("F1").value = parts.length;
  }
  workbook.eachSheet((sheet) => {
    sheet.views = [
      {
        state: "frozen",
        ySplit: sheet.name === "Dashboard" ? 2 : 1,
        xSplit: sheet.name.startsWith("Finanzen") ? 2 : 0,
      },
    ];
    sheet.columns.forEach((column, index) => {
      column.width = index < 2 ? 28 : 17;
    });
    if (sheet.name === "Umsätze") {
      sheet.getColumn(4).width = 65;
      sheet.getColumn(10).hidden = true;
      sheet.autoFilter = { from: "A1", to: "N1" };
    }
    sheet.eachRow((row, rowIndex) => {
      row.height = 21;
      row.eachCell((cell, col) => {
        cell.font = { name: "Aptos", size: 10, color: { argb: "FF17211D" } };
        if (rowIndex === 1 || (sheet.name === "Dashboard" && rowIndex === 2)) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF173B30" },
          };
          cell.font = {
            name: "Aptos",
            size: 10,
            bold: true,
            color: { argb: "FFFFFFFF" },
          };
        } else {
          const kind = text(row.getCell(1));
          const editable =
            sheet.name === "Umsätze"
              ? [1, 2, 3, 4, 5, 6, 11].includes(col)
              : sheet.name === "Pockets"
                ? rowIndex <= 5 && col === 2
                : sheet.name === "Dashboard"
                  ? kind in settingLabels && col === 3
                  : sheet.name.startsWith("Finanzen") &&
                    ["income", "fixed", "variable", "input"].includes(kind) &&
                    col >= 3 &&
                    col <= 14;
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: {
              argb: editable
                ? "FFFFF0B3"
                : rowIndex % 2
                  ? "FFF4F6F5"
                  : "FFFFFFFF",
            },
          };
          if (typeof cell.value === "number") {
            cell.value = round(cell.value);
            cell.numFmt = "#,##0.00;[Red]-#,##0.00";
          }
          if (
            sheet.name === "Dashboard" &&
            col === 3 &&
            /Share|Rate/.test(kind)
          ) {
            cell.value = state.settings[kind as keyof Settings] as number;
            cell.numFmt = "0.00%";
          }
        }
      });
    });
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return Uint8Array.from(new Uint8Array(buffer)).buffer;
}
