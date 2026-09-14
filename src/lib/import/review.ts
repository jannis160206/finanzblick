import {
  classify,
  actualBookings,
  classifyStatementRows,
  bookingMonth,
  monthKey,
  monthsForYear,
  round,
} from "@/lib/calc";
import {
  fixedCategories,
  durableCategories,
  type AppState,
  type FinanceRow,
  type FixedReceipt,
  type PocketSnapshot,
  type Transaction,
  type FixedChange,
  type ReviewItem,
} from "@/lib/types";
export type { FixedChange, ReviewItem } from "@/lib/types";
import { legacyFingerprint, numberStatementRows } from "./identity";
import {
  matchingFixedRow as matchingGridRow,
  isIncomeCategory as isIncome,
} from "@/lib/fixed";
import {
  applyMerchantRules,
  merchantRuleKey,
  rememberMerchants,
  storedMerchantKey,
} from "./merchant-rules";
import { recoverMerchant, sameTerminalBooking, unresolvedTerminal } from "./merchant-description";
import { payrollCategory } from "@/lib/payroll";
import { isWorkingDay, statementTime } from "@/lib/holidays-at-kaernten";
import { alwaysLunch, isSharedHoliday, reconcileSharedHoliday, type AccountedTransaction } from "@/lib/shared-holiday";
import {
  appendStatementRows,
  deduplicateStatements,
  statementFingerprint,
  type StatementResult,
} from "./statements";

export type ImportMetadata = {
  pocketSnapshots?: PocketSnapshot[];
  fixedReceipts?: FixedReceipt[];
  accountSnapshots?: AppState["accountSnapshots"];
  reviewQueue?: ReviewItem[];
  issues?: string[];
  reparsedFiles?: string[];
  merchantRepairs?: Transaction[];
};
export type FixedDecision = { change: FixedChange; accept: boolean };

export function bookingReviewReason(state: AppState, row: AccountedTransaction): string | undefined {
  if (unresolvedTerminal(row.description)) return "POS-Händler fehlt: Auszug mit Verwendungszweck erneut ablegen.";
  if (alwaysLunch(row.description) || isSharedHoliday(row) || row.holidayReimbursementFor) return;
  const result = classify(row);
  if (!row.category || row.category === "Prüfen" || result.category === "Prüfen") return "Kategorie noch offen.";
  if (payrollCategory(row) === result.category) return;
  const rules = (state.merchantRules ?? []).filter((rule) => storedMerchantKey(rule.key) === merchantRuleKey(row));
  if (new Set(rules.map((rule) => rule.category)).size > 1 || rules.some((rule) => rule.category !== result.category))
    return "Widersprüchliche Händlerregel: Zuordnung prüfen.";
  if (row.category === "Mittagessen" && result.category !== "Mittagessen") return "Mittagessen: Datum oder Uhrzeit passt nicht zur Regel.";
  if (row.categoryOverride || result.isTransfer) return;
  if (isWorkingDay(row.date) && !statementTime(row.time, row.description) &&
    (/trafik/i.test(row.description) || (/billa|\bspar\b|interspar|eurospar/i.test(row.description) && Math.abs(row.amount) <= 10)))
    return "Mittagessen unklar: keine Uhrzeit im Auszug.";
  if (classify({ ...row, category: "Prüfen", sourceCategory: undefined }).category === "Prüfen")
    return "Händler noch nicht sicher zugeordnet.";
}

export function openReviewCount(items: ReviewItem[]): number {
  return items.reduce((total, item) => total + (item.kind === "fixed" ? item.change.bookings.length : 1), 0);
}

export function repairMerchantBookings(state: AppState, candidates: Transaction[] = []): AppState {
  const recovered = candidates.map(recoverMerchant).filter((row) => row.rawDescription && !unresolvedTerminal(row.description));
  const repair = (row: Transaction): Transaction => {
    let updated = recoverMerchant(row);
    if (unresolvedTerminal(updated.description)) {
      const matches = recovered.filter((candidate) => sameTerminalBooking(row, candidate));
      if (new Set(matches.map((candidate) => candidate.description)).size === 1) {
        const match = matches[0];
        updated = { ...row, description: match.description, rawDescription: row.rawDescription ?? row.description,
          rawDetails: match.rawDetails ?? row.rawDetails, bankReference: row.bankReference ?? match.bankReference };
      }
    }
    return updated === row ? row : classifyStatementRows(applyMerchantRules(state, [updated]))[0];
  };
  return { ...state,
    transactions: state.transactions.map(repair),
    ...(state.reviewQueue ? { reviewQueue: state.reviewQueue.map((item) => item.kind === "booking"
      ? { ...item, draft: item.draft.amount === null ? recoverMerchant(item.draft) : repair(item.draft as Transaction) }
      : item) } : {}),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((item) => {
      if (!item.booking) return item;
      const booking = repair(item.booking);
      return booking === item.booking ? item : { ...item, booking, category: booking.category, merchantKey: merchantRuleKey(booking) };
    }) } : {}),
  };
}

function repairPayrollBookings(state: AppState): AppState {
  const repair = (row: Transaction): Transaction => {
    const payroll = payrollCategory(row);
    if (!payroll || classify(row).category !== payroll || row.category === payroll) return row;
    return { ...row, category: payroll, includeInPlan: false };
  };
  return { ...state,
    transactions: state.transactions.map(repair),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((item) => {
      if (!item.booking) return item;
      const booking = repair(item.booking);
      const category = classify(booking).category;
      if (!payrollCategory(booking) || category !== payrollCategory(booking)) return item;
      return { ...item, booking, category, rowId: matchingGridRow(state, category)?.id };
    }) } : {}),
    ...(state.reviewQueue ? { reviewQueue: state.reviewQueue.flatMap((item): ReviewItem[] => {
      if (item.kind === "fixed" && ["Gehalt", "Rufbereitschaft"].includes(item.change.category))
        return item.change.bookings.map((row) => ({ kind: "booking", id: row.id, draft: repair(row), message: "Einkommenszuordnung prüfen." }));
      if (item.kind === "booking" && item.draft.amount !== null)
        return [{ ...item, draft: repair(item.draft as Transaction) }];
      return [item];
    }) } : {}),
  };
}

export function queueLedgerReview(state: AppState): AppState {
  state = repairPayrollBookings(repairMerchantBookings(state));
  const pending = (state.reviewQueue ?? []).flatMap((item) =>
    item.kind === "booking" && item.draft.amount !== null ? [item.draft as Transaction] : []);
  const accounted = reconcileSharedHoliday([...actualBookings(state), ...pending]).bookings;
  const safePending = accounted.slice(accounted.length - pending.length).filter((row) =>
    !bookingReviewReason(state, row));
  if (safePending.length) state = appendStatementRows(state, safePending.map((row) => ({ ...row, category: classify(row).category, includeInPlan: classify(row).includeInPlan }))).state;
  const ledger = actualBookings(state);
  const byId = new Map(ledger.map((row) => [row.id, row]));
  const keys = new Set(ledger.map(statementFingerprint));
  const queue: ReviewItem[] = (state.reviewQueue ?? []).filter((item) => item.kind === "fixed" ||
    (!byId.has(item.draft.id) && (item.draft.amount === null || !keys.has(statementFingerprint(item.draft as Transaction)))));
  for (const draft of ledger) {
    const message = bookingReviewReason(state, draft);
    if (!message) continue;
    queue.push({ kind: "booking", id: draft.id, draft, message });
  }
  return { ...state, reviewQueue: queue };
}

function receipt(row: Transaction, rowId?: string): FixedReceipt {
  return {
    key: statementFingerprint(row),
    merchantKey: merchantRuleKey(row),
    date: row.date,
    category: row.category,
    amount: row.amount,
    booking: row,
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
  for (const item of metadata.fixedReceipts ?? []) {
    const legacyKey = item.booking ? legacyFingerprint(item.booking) : item.key;
    const existing = receipts.get(item.key) ?? receipts.get(legacyKey);
    if (legacyKey !== item.key) receipts.delete(legacyKey);
    receipts.set(
      item.key,
      existing
        ? {
            ...item,
            ...existing,
            key: item.key,
            booking: existing.booking ?? item.booking,
          }
        : item,
    );
  }
  const accounts = new Map(
    (state.accountSnapshots ?? []).map((item) => [
      `${item.name}|${item.date}`,
      item,
    ]),
  );
  for (const item of metadata.accountSnapshots ?? [])
    accounts.set(`${item.name}|${item.date}`, item);
  return {
    ...state,
    ...(accounts.size ? { accountSnapshots: [...accounts.values()] } : {}),
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
  const existing = actualBookings(state);
  const accounted = reconcileSharedHoliday([...existing, ...classified]).bookings.slice(existing.length)
    .map((row) => row.holidayReimbursementFor ? { ...row, category: "Urlaub" as const, includeInPlan: false } : row);
  const deduped = deduplicateStatements(accounted, state.transactions);
  const rows: Transaction[] = [];
  const receipts: FixedReceipt[] = [];
  const changes = new Map<string, FixedChange>();
  let duplicates = deduped.duplicates;
  const monthly = new Map<string, Transaction>();
  for (const row of state.transactions)
    monthly.set(`${bookingMonth(row)}|${classify(row).category}`, row);
  for (const row of deduped.rows) {
    const category = row.category;
    const isFixed =
      fixedCategories.includes(category) &&
      (isIncome(category) ? row.amount > 0 : row.amount < 0);
    if (
      ignored.has(statementFingerprint(row)) ||
      ignored.has(legacyFingerprint(row))
    ) {
      if (isFixed)
        receipts.push(receipt(row, matchingGridRow(state, category)?.id));
      duplicates++;
      continue;
    }
    if (!isFixed) {
      rows.push(row);
      continue;
    }
    const month = bookingMonth(row);
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
    const remembered = [...(state.fixedAmountDecisions ?? [])]
      .reverse()
      .find(
        (item) =>
          item.category === category &&
          item.merchantKey === merchantRuleKey(row) &&
          item.month <= month,
      );
    if (remembered?.amount === amount) {
      receipts.push(receipt(row, grid?.id));
      duplicates++;
      continue;
    }
    if (Math.abs(round(amount - previous)) <= 0.05) {
      receipts.push(receipt(row, grid?.id));
      duplicates++;
      continue;
    }
    if (!durableCategories.includes(category)) {
      rows.push(row);
      receipts.push(receipt(row, grid?.id));
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
  const candidates = results.flatMap((result) => numberStatementRows(result.rows.map(recoverMerchant)));
  state = repairPayrollBookings(repairMerchantBookings(state, candidates));
  const split = splitFixedBookings(
    {
      ...state,
      transactions: [
        ...state.transactions,
        ...(state.reviewQueue ?? []).flatMap((item) =>
          item.kind === "fixed"
            ? item.change.bookings
            : item.draft.amount !== null
              ? [item.draft as Transaction]
              : [],
        ),
      ],
    },
    candidates,
  );
  const automatic: Transaction[] = [];
  const review: ReviewItem[] = split.changes.map((change) => ({
    kind: "fixed",
    id: change.id,
    change,
  }));
  for (const row of split.rows) {
    const message = bookingReviewReason(state, row);
    if (message)
      review.push({
        kind: "booking",
        id: row.id,
        draft: row,
        message,
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
      merchantRepairs: candidates.filter((row) => !!row.rawDescription),
      reviewQueue: review,
      issues,
      reparsedFiles: [...new Set(results.filter((result) => result.source !== null).map((result) => result.file))],
      accountSnapshots: results.flatMap(
        (result) => result.accountSnapshots ?? [],
      ),
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
  const fixedAmountDecisions = [...(state.fixedAmountDecisions ?? [])];
  for (const { change, accept } of [...decisions].sort((a, b) =>
    a.change.month.localeCompare(b.change.month),
  )) {
    change.bookings.forEach((row) => ignored.add(statementFingerprint(row)));
    for (const booking of change.bookings) {
      const merchantKey = merchantRuleKey(booking);
      if (
        !fixedAmountDecisions.some(
          (item) =>
            item.month === change.month &&
            item.merchantKey === merchantKey &&
            item.category === change.category &&
            item.amount === change.amount &&
            item.accept === accept,
        )
      )
        fixedAmountDecisions.push({
          merchantKey,
          category: change.category,
          amount: change.amount,
          month: change.month,
          accept,
        });
    }
    if (
      !accept ||
      !durableCategories.includes(change.category) ||
      change.bookings.some((row) =>
        /13\.?\s*(?:gehalt|lohn)|bonus|sonderzahlung|rufbereitschaft|urlaub|holiday/i.test(
          row.description,
        ),
      )
    )
      continue;
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
    ...(fixedAmountDecisions.length ? { fixedAmountDecisions } : {}),
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
  state = repairPayrollBookings(repairMerchantBookings(state, metadata.merchantRepairs));
  const queueMap = new Map(
    (state.reviewQueue ?? []).map((item) => [item.id, item]),
  );
  for (const item of metadata.reviewQueue ?? []) queueMap.set(item.id, item);
  const queue = [...queueMap.values()];
  const related = queue.flatMap((item) => {
    if (item.kind !== "fixed") return [];
    const decision = decisions.find(
      ({ change }) =>
        change.category === item.change.category &&
        change.amount === item.change.amount &&
        change.bookings.some((row) =>
          item.change.bookings.some(
            (other) => merchantRuleKey(row) === merchantRuleKey(other),
          ),
        ),
    );
    return decision ? [{ change: item.change, accept: decision.accept }] : [];
  });
  decisions = [
    ...new Map(
      [...decisions, ...related].map((item) => [item.change.id, item]),
    ).values(),
  ];
  const choices = new Map(
    rows
      .filter((row) => row.categoryOverride)
      .map((row) => [merchantRuleKey(row), row.category]),
  );
  const selected = new Map(
    numberStatementRows(rows).map((row) => [statementFingerprint(row), row]),
  );
  for (const item of queue) {
    if (item.kind !== "booking" || item.draft.amount === null) continue;
    const category = choices.get(merchantRuleKey(item.draft as Transaction));
    if (category) {
      const row = {
        ...item.draft,
        amount: item.draft.amount,
        category,
        categoryOverride: true,
        includeInPlan: true,
      };
      selected.set(statementFingerprint(row), row);
    }
  }
  rows = [...selected.values()];
  const learned = rememberMerchants(state, [
    ...rows.filter(
      (row) => row.amount < 0 || fixedCategories.includes(row.category),
    ),
    ...decisions.flatMap(({ change }) => change.bookings),
  ]);
  const ledgerIds = new Set(state.transactions.map((row) => row.id));
  const current = applyFixedDecisions({ ...learned,
    transactions: learned.transactions.map((row) => {
      const category = choices.get(merchantRuleKey(row));
      if (!category) return row;
      const updated = { ...row, category, categoryOverride: true, includeInPlan: true };
      const result = classify(updated);
      return { ...updated, category: result.category, includeInPlan: result.includeInPlan };
    }),
  }, decisions);
  // Existing ledger reviews edit in place; never append a second spend or fixed receipt.
  const split = splitFixedBookings(current, rows.filter((row) => !ledgerIds.has(row.id)));
  const appended = appendStatementRows(current, split.rows);
  for (const row of split.rows) {
    const category = classify(row).category;
    const month = bookingMonth(row);
    const grid = matchingGridRow(appended.state, category);
    if (
      durableCategories.includes(category) &&
      grid?.values[month] == null &&
      (isIncome(category) ? row.amount > 0 : row.amount < 0)
    ) {
      appended.state = applyFixedDecisions(appended.state, [
        {
          accept: true,
          change: {
            id: `initial-${row.id}`,
            category,
            month,
            previous: 0,
            amount: Math.abs(row.amount),
            rowId: grid?.id,
            bookings: [row],
          },
        },
      ]);
    }
  }
  const resolved = new Set(rows.map(statementFingerprint));
  const resolvedChanges = new Set(decisions.map(({ change }) => change.id));
  const pending = queue.filter((item) =>
    item.kind === "fixed"
      ? !resolvedChanges.has(item.id)
      : item.draft.amount === null ||
        !resolved.has(statementFingerprint(item.draft as Transaction)),
  );
  for (const change of split.changes)
    if (!pending.some((item) => item.id === change.id))
      pending.push({ kind: "fixed", id: change.id, change });
  const merged = mergeMetadata(appended.state, {
    ...metadata,
    fixedReceipts: [
      ...(metadata.fixedReceipts ?? []),
      ...split.receipts,
      ...decisions.flatMap(({ change }) =>
        change.bookings.map((row) => receipt(row, change.rowId)),
      ),
    ],
  });
  const importedCount =
    actualBookings(merged).length - actualBookings(state).length;
  return {
    ...appended,
    state: {
      ...merged,
      ...(pending.length || state.reviewQueue ? { reviewQueue: pending } : {}),
      ...(metadata.issues !== undefined || state.importStatus
        ? {
            importStatus: {
              imported:
                (state.importStatus?.imported ?? 0) +
                Math.max(0, importedCount),
              issues: [
                ...new Set([
                  ...(state.importStatus?.issues ?? []).filter((issue) =>
                    !(metadata.reparsedFiles ?? []).some((file) =>
                      issue.startsWith(`${file}: `) ||
                      (issue.startsWith(`${file}, Zeile `) && /^\d+: /.test(issue.slice(file.length + 8))),
                    ),
                  ),
                  ...(metadata.issues ?? []),
                ]),
              ],
            },
          }
        : {}),
    },
    duplicates: appended.duplicates + split.duplicates,
    changes: split.changes,
  };
}
