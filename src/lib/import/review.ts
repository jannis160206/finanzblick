import {
  classify,
  classifyStatementRows,
  monthKey,
  monthsForYear,
  round,
} from "@/lib/calc";
import {
  fixedCategories,
  type AppState,
  type Category,
  type FinanceRow,
  type FixedReceipt,
  type PocketSnapshot,
  type Transaction,
} from "@/lib/types";
import {
  matchingFixedRow as matchingGridRow,
  isIncomeCategory as isIncome,
} from "@/lib/fixed";
import {
  applyMerchantRules,
  merchantRuleKey,
  rememberMerchants,
} from "./merchant-rules";
import {
  appendStatementRows,
  deduplicateStatements,
  statementFingerprint,
  type StatementDraft,
  type StatementResult,
} from "./statements";

export type ImportMetadata = {
  pocketSnapshots?: PocketSnapshot[];
  fixedReceipts?: FixedReceipt[];
};
export type FixedChange = {
  id: string;
  category: Category;
  month: string;
  previous: number;
  amount: number;
  rowId?: string;
  bookings: Transaction[];
};
export type ReviewItem =
  | { kind: "booking"; id: string; draft: StatementDraft; message: string }
  | { kind: "fixed"; id: string; change: FixedChange };
export type FixedDecision = { change: FixedChange; accept: boolean };

function receipt(row: Transaction, rowId?: string): FixedReceipt {
  return {
    key: statementFingerprint(row),
    merchantKey: merchantRuleKey(row),
    date: row.date,
    category: row.category,
    amount: row.amount,
    ...(rowId ? { rowId } : {}),
  };
}
function mergeMetadata(state: AppState, metadata: ImportMetadata): AppState {
  const snapshots = new Map(
    (state.pocketSnapshots ?? []).map((item) => [
      `${item.pocket}|${item.date}`,
      item,
    ]),
  );
  for (const item of metadata.pocketSnapshots ?? [])
    snapshots.set(`${item.pocket}|${item.date}`, item);
  const receipts = new Map(
    (state.fixedReceipts ?? []).map((item) => [item.key, item]),
  );
  for (const item of metadata.fixedReceipts ?? []) receipts.set(item.key, item);
  return {
    ...state,
    ...(snapshots.size
      ? {
          pocketSnapshots: [...snapshots.values()].sort(
            (a, b) =>
              a.date.localeCompare(b.date) || a.pocket.localeCompare(b.pocket),
          ),
        }
      : {}),
    ...(receipts.size ? { fixedReceipts: [...receipts.values()] } : {}),
  };
}

export function splitFixedBookings(state: AppState, candidates: Transaction[]) {
  const ignored = new Set([
    ...(state.ignoredStatementKeys ?? []),
    ...(state.fixedReceipts ?? []).map((item) => item.key),
  ]);
  const classified = classifyStatementRows(
    applyMerchantRules(state, candidates),
    state.transactions,
  ).map((row) => {
    // Generic PayPal direct debits may omit the merchant. Only use the configured
    // Apple Care amount for that narrow statement format, never arbitrary merchants.
    const appleCare = matchingGridRow(state, "Apple Care");
    const expected = appleCare?.values[monthKey(row.date)];
    if (
      !row.categoryOverride &&
      row.amount < 0 &&
      (row.category === "Prüfen" || row.category === "PayPal Abo") &&
      /paypal\s+europe|apple\.com\/bill/i.test(row.description) &&
      expected != null &&
      Math.abs(round(Math.abs(row.amount) - expected)) <= 0.05
    )
      return {
        ...row,
        category: "Apple Care" as const,
        includeInPlan: false,
      };
    return row;
  });
  const deduped = deduplicateStatements(classified, state.transactions);
  const rows: Transaction[] = [];
  const receipts: FixedReceipt[] = [];
  const changes = new Map<string, FixedChange>();
  let duplicates = deduped.duplicates;
  const monthly = new Map<string, Transaction>();
  for (const row of state.transactions)
    monthly.set(`${monthKey(row.date)}|${classify(row).category}`, row);
  for (const row of deduped.rows) {
    const category = row.category;
    const isFixed =
      fixedCategories.includes(category) &&
      (isIncome(category) ? row.amount > 0 : row.amount < 0);
    if (ignored.has(statementFingerprint(row))) {
      if (isFixed)
        receipts.push(receipt(row, matchingGridRow(state, category)?.id));
      duplicates++;
      continue;
    }
    if (!isFixed) {
      rows.push(row);
      continue;
    }
    const month = monthKey(row.date);
    const key = `${month}|${category}`;
    const grid = matchingGridRow(state, category);
    const booked = monthly.get(key);
    const previous =
      grid?.values[month] ?? (booked ? Math.abs(booked.amount) : null);
    if (previous === null) {
      rows.push(row);
      receipts.push(receipt(row, grid?.id));
      monthly.set(key, row);
      continue;
    }
    const amount = Math.abs(row.amount);
    if (Math.abs(round(amount - previous)) <= 0.05) {
      receipts.push(receipt(row, grid?.id));
      duplicates++;
      continue;
    }
    const id = `${key}|${amount.toFixed(2)}`;
    const change = changes.get(id) ?? {
      id,
      category,
      month,
      previous,
      amount,
      rowId: grid?.id,
      bookings: [],
    };
    change.bookings.push(row);
    changes.set(id, change);
  }
  return {
    rows,
    receipts,
    changes: [...changes.values()].sort((a, b) =>
      a.month.localeCompare(b.month),
    ),
    duplicates,
  };
}

export function prepareStatementImport(
  results: StatementResult[],
  state: AppState,
) {
  const split = splitFixedBookings(
    state,
    results.flatMap((result) => result.rows),
  );
  const automatic: Transaction[] = [];
  const review: ReviewItem[] = split.changes.map((change) => ({
    kind: "fixed",
    id: change.id,
    change,
  }));
  for (const row of split.rows) {
    if (row.category === "Prüfen")
      review.push({
        kind: "booking",
        id: row.id,
        draft: row,
        message: "Händler noch nicht sicher zugeordnet.",
      });
    else automatic.push(row);
  }
  const issues = results.flatMap((result) =>
    result.issues.map(
      (issue) =>
        `${issue.file}${issue.line ? `, Zeile ${issue.line}` : ""}: ${issue.message}`,
    ),
  );
  return {
    automatic,
    review,
    duplicates: split.duplicates,
    issues,
    metadata: {
      pocketSnapshots: results.flatMap(
        (result) => result.pocketSnapshots ?? [],
      ),
      fixedReceipts: split.receipts,
    } satisfies ImportMetadata,
  };
}

export function applyFixedDecisions(
  state: AppState,
  decisions: FixedDecision[],
): AppState {
  const ignored = new Set(state.ignoredStatementKeys ?? []);
  let financeRows = state.financeRows;
  for (const { change, accept } of [...decisions].sort((a, b) =>
    a.change.month.localeCompare(b.change.month),
  )) {
    change.bookings.forEach((row) => ignored.add(statementFingerprint(row)));
    if (!accept) continue;
    const existing =
      financeRows.find((row) => row.id === change.rowId) ??
      matchingGridRow({ ...state, financeRows }, change.category);
    const row: FinanceRow = existing ?? {
      id: crypto.randomUUID(),
      kind: isIncome(change.category) ? "income" : "fixed",
      label: change.category,
      values: {},
    };
    const values = { ...row.values };
    for (const month of [...monthsForYear(2026), ...monthsForYear(2027)])
      if (month >= change.month) values[month] = change.amount;
    const updated = { ...row, values };
    financeRows = existing
      ? financeRows.map((item) => (item.id === row.id ? updated : item))
      : [...financeRows, updated];
  }
  return {
    ...state,
    financeRows,
    ...(ignored.size ? { ignoredStatementKeys: [...ignored] } : {}),
  };
}

// Recheck against the reducer's latest state, not the state captured before file parsing.
export function commitStatementImport(
  state: AppState,
  rows: Transaction[],
  decisions: FixedDecision[] = [],
  metadata: ImportMetadata = {},
) {
  const learned = rememberMerchants(state, [
    ...rows,
    ...decisions.flatMap(({ change }) => change.bookings),
  ]);
  const current = applyFixedDecisions(learned, decisions);
  const split = splitFixedBookings(current, rows);
  const appended = appendStatementRows(current, split.rows);
  return {
    ...appended,
    state: mergeMetadata(appended.state, {
      ...metadata,
      fixedReceipts: [
        ...(metadata.fixedReceipts ?? []),
        ...split.receipts,
        ...decisions.flatMap(({ change }) =>
          change.bookings.map((row) => receipt(row, change.rowId)),
        ),
      ],
    }),
    duplicates: appended.duplicates + split.duplicates,
    changes: split.changes,
  };
}
