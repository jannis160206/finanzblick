import { z } from "zod";
import { accountLabel } from "@/lib/accounts";
import { actualBookings, classify } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { statementFingerprint } from "@/lib/import/identity";
import { rememberMerchantRename, rememberMerchants } from "@/lib/import/merchant-rules";
import { merchantAliasAssignment } from "@/lib/merchant-identity";
import {
  isSharedHoliday,
  personalAmount,
  type AccountedTransaction,
} from "@/lib/shared-holiday";
import {
  categorySchema,
  transactionSchema,
  type AppState,
  type Category,
  type Transaction,
} from "@/lib/types";

export function normalizeSearch(text: string): string {
  return text
    .toLocaleLowerCase("de")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function matchesTransactionSearch(
  row: AccountedTransaction,
  query: string,
  merchant?: string,
): boolean {
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const text = normalizeSearch(
    [
      row.description,
      row.merchantAlias,
      row.rawDescription,
      ...(row.rawDetails ?? []),
      row.bank,
      accountLabel(row),
      merchant ?? classify(row).merchant,
    ]
      .filter(Boolean)
      .join(" "),
  );
  return words.every((word) => text.includes(word));
}

function csvText(value: string): string {
  // Quoting alone does not stop spreadsheet formulas, even after invisible prefixes.
  const safe = /^[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]/u.test(value)
    ? `'${value}`
    : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csvMoney(value: number): string {
  return `"${(Math.round(value * 100) / 100).toFixed(2).replace(".", ",")}"`;
}

export function exportTransactionsCsv(
  rows: readonly AccountedTransaction[],
): string {
  const header = [
    "ID",
    "Datum",
    "Händler",
    "Original-Banktext",
    "Kategorie",
    "Bank",
    "Pocket / Konto",
    "Originalbetrag",
    "Eigenanteil",
    "Geteilt / Erstattung",
    "Planrelevant",
  ]
    .map(csvText)
    .join(";");
  const lines = rows.map((row) => {
    const result = classify(row);
    const reimbursement = !!row.holidayReimbursementFor;
    const status = reimbursement
      ? `Erstattung für ${row.holidayReimbursementFor} (kein Einkommen)`
      : isSharedHoliday(row)
        ? `Geteilt · 50 % Eigenanteil${row.sharedPaidManually ? " · manuell bezahlt" : ""}`
        : "";
    return [
      ...[
        row.id,
        row.date,
        result.merchant,
        row.rawDescription ?? row.description,
        reimbursement ? "Transfer" : result.category,
        row.bank,
        accountLabel(row),
      ].map(csvText),
      csvMoney(row.amount),
      csvMoney(personalAmount(row)),
      csvText(status),
      csvText(!reimbursement && result.includeInPlan ? "Ja" : "Nein"),
    ].join(";");
  });
  return `\uFEFF${[header, ...lines].join("\r\n")}\r\n`;
}

export type TransactionAssignment = {
  category: Category;
  fixedCost?: boolean;
  merchantAlias?: string;
};

const assignmentSchema = z
  .object({
    category: categorySchema,
    fixedCost: transactionSchema.shape.fixedCost,
    merchantAlias: transactionSchema.shape.merchantAlias,
  })
  .strict();

export function assignTransactions(
  state: AppState,
  ids: readonly string[],
  assignment: TransactionAssignment,
): AppState {
  const choice = assignmentSchema.parse(assignment);
  const selected = new Set(ids);
  if (choice.merchantAlias !== undefined && selected.size > 1)
    throw new Error(
      "Ein Händlername kann nur für eine einzelne Buchung geändert werden.",
    );
  if (!selected.size) return state;

  const ledger = new Map(actualBookings(state).map((row) => [row.id, row]));
  const originals = new Map(state.transactions.map((row) => [row.id, row]));
  const receipts = new Map(
    (state.fixedReceipts ?? []).map((receipt) => [receipt.key, receipt]),
  );
  const receiptIds = new Map(
    (state.fixedReceipts ?? []).flatMap((receipt) =>
      receipt.booking ? [[receipt.booking.id, receipt] as const] : [],
    ),
  );
  const targets = [...selected].map((id) => {
    const receipt = receipts.get(id) ?? receiptIds.get(id);
    const row =
      ledger.get(id) ??
      originals.get(id) ??
      (receipt ? ledger.get(receipt.key) : undefined);
    if (!row) throw new Error(`Buchung nicht mehr vorhanden: ${id}`);
    return row;
  });
  const changes = new Map<string, Partial<Transaction>>();
  const receiptChanges = new Map<
    string,
    { row: Transaction; change: Partial<Transaction> }
  >();
  const learned = new Map<string, Transaction>();
  for (const row of targets) {
    const preview = classify({
      ...row,
      ...choice,
      manualCategory: true,
      includeInPlan: true,
    });
    const canMarkFixed =
      row.amount < 0 &&
      !preview.isTransfer &&
      !isIncomeCategory(preview.category);
    const change = {
      category: choice.category,
      categoryOverride: true,
      manualCategory: true,
      reviewed: choice.category !== "Prüfen",
      includeInPlan: true,
      ...(choice.merchantAlias !== undefined
        ? merchantAliasAssignment(row, choice.merchantAlias)
        : {}),
      ...(choice.fixedCost !== undefined
        ? { fixedCost: canMarkFixed && choice.fixedCost }
        : {}),
    };
    changes.set(row.id, change);
    receiptChanges.set(row.id, { row, change });
    receiptChanges.set(statementFingerprint(row), { row, change });
    learned.set(row.id, { ...row, ...change });
  }
  const apply = (
    row: Transaction,
    change: Partial<Transaction>,
  ): Transaction => ({
    ...row,
    ...change,
    includeInPlan: classify({ ...row, ...change }).includeInPlan,
  });
  const updated = {
    ...state,
    transactions: state.transactions.map((row) => {
      const change = changes.get(row.id);
      return change ? apply(row, change) : row;
    }),
    ...(state.fixedReceipts
      ? {
          fixedReceipts: state.fixedReceipts.map((receipt) => {
            const target =
              receiptChanges.get(receipt.key) ??
              (receipt.booking
                ? receiptChanges.get(receipt.booking.id)
                : undefined);
            return target
              ? {
                  ...receipt,
                  category: choice.category,
                  booking: apply(receipt.booking ?? target.row, target.change),
                }
              : receipt;
          }),
        }
      : {}),
  };
  // FinanceProvider rebuilds the review queue, just as for the former pencil save.
  const remembered = rememberMerchants(updated, [...learned.values()]);
  return choice.merchantAlias !== undefined
    ? rememberMerchantRename(remembered, targets[0], choice.merchantAlias)
    : remembered;
}
