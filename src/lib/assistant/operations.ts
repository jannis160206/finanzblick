import { applyAiReviewDecisions } from "@/lib/ai/apply-review-decisions";
import { classify } from "@/lib/calc";
import { canonicalCategory } from "@/lib/categories";
import { planningEndMonth } from "@/lib/planning-range";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { corePocket, pocketKey, preserveGoalOpeningBalances, savingsGoals } from "@/lib/goals";
import { assignTransactions } from "@/lib/transaction-tools";
import { contractPatch, detectContracts, intervalLabel, noticeLabel, upsertContractOverride, type Contract } from "@/lib/contracts";
import { removeFixedPlanRow } from "@/lib/fixed-plan";
import { legacyFingerprint, statementFingerprint } from "@/lib/import/identity";
import { successBonusPercent } from "@/lib/payroll-analysis";
import { autoBudgetCorrections, confirmPayslip, heldPayslips, reviewPayrollBudget, syncPayrollBudget } from "@/lib/payroll-budget";
import { payrollEmployerKey, payslipKey } from "@/lib/payslip-schema";
import { chooseSeasonalTheme, resetSeasonalTheme, seasonalLabels } from "@/lib/seasonal-theme";
import type { BudgetCorrection } from "@/lib/budget-corrections";
import { setTag } from "@/lib/tags";
import { addMonth } from "./intent";
import { defaultBudgetAmount, variableBudgetLines } from "@/lib/variable-budgets";
import {
  assistantMemorySchema, contractOverrideSchema, emptyMonth, financeRowSchema, MAX_ACCOUNT_RULES, MAX_ASSISTANT_CHANGES, MAX_ASSISTANT_MEMORY, MAX_CONTRACTS,
  plannedOneOffSchema, savingsGoalSchema, type AccountRule, type AppState, type AssistantChangeLog, type AssistantOperation, type AssistantUndo, type ContractOverride,
  type FinanceRow, type PlannedOneOff, type SavingsGoal, type Transaction,
} from "@/lib/types";

export type Diff = { label: string; before: string; after: string };
export type AppliedChange = { state: AppState; diffs: Diff[]; undo: AssistantUndo };

const settingLabels = { emergencyTarget: "Notgroschen-Ziel", vacationTarget: "Urlaubs-Ziel", savingsTarget: "Sparkonto-Ziel" } as const;
const statusLabels: Record<Contract["status"], string> = { review: "Vorschlag", active: "aktiv", cancelled: "gekündigt", ignored: "ausgeblendet" };
const kindLabels: Record<FinanceRow["kind"], string> = { income: "Einnahme", fixed: "Fixkosten", variable: "variabel" };
// Fields the contract wizard edits; "Änderungen verwerfen" clears exactly these.
const editedKeys = ["name", "category", "amount", "interval", "nextDate", "notice", "termEnd", "autoRenew", "renewalMonths", "note"] as const;
const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const ruleText = (rule: Pick<AccountRule, "use" | "purposes">) =>
  rule.use === "any" ? "für alle Ausgaben" : rule.use === "never" ? "nie angreifen" : `nur für ${rule.purposes.join(", ")}`;
const matchText = (match: ContractOverride["match"]) => !match ? "aus" : [match.text && `Text „${match.text}“`,
  match.amountMin !== undefined && `ab ${currency(match.amountMin)}`, match.amountMax !== undefined && `bis ${currency(match.amountMax)}`,
  match.account && `Konto ${match.account}`].filter(Boolean).join(", ") || "aus";
const none = "–";
const rate = (goal: SavingsGoal) => goal.funding ? `${currency(goal.funding.monthly)} / Monat` : "automatisch";
const plannedTotal = (item: PlannedOneOff) => item.total ?? Math.round(item.amount * item.installments * 100) / 100;
const plannedText = (item: PlannedOneOff) => item.installments > 1
  ? `${currency(plannedTotal(item))} in ${item.installments} Raten ab ${monthLabel(item.date.slice(0, 7))}`
  : `${currency(item.amount)} im ${monthLabel(item.date.slice(0, 7))}`;

export class OperationError extends Error {}

function snapshotGoal(undo: AssistantUndo, state: AppState, id: string) {
  if (state.savingsGoals === undefined && undo.goalsUnset === undefined) undo.goalsUnset = true;
  undo.goals ??= [];
  if (!undo.goals.some((entry) => entry.id === id)) {
    const before = savingsGoals(state).find((goal) => goal.id === id) ?? null;
    undo.goals.push({ id, before });
    if (before && pocketKey(before.pocket) === "motorrad") {
      snapshotSetting(undo, state, "bikeTarget");
      snapshotSetting(undo, state, "bikePurchaseDate");
    }
  }
}
function snapshotPlanned(undo: AssistantUndo, state: AppState, id: string) {
  undo.planned ??= [];
  if (!undo.planned.some((entry) => entry.id === id))
    undo.planned.push({ id, before: (state.plannedOneOffs ?? []).find((item) => item.id === id) ?? null });
}
function snapshotSetting(undo: AssistantUndo, state: AppState, key: NonNullable<AssistantUndo["settings"]>[number]["key"]) {
  undo.settings ??= [];
  if (!undo.settings.some((entry) => entry.key === key)) undo.settings.push({ key, before: state.settings[key] ?? null });
}
function snapshotContract(undo: AssistantUndo, state: AppState, id: string) {
  undo.contracts ??= [];
  if (!undo.contracts.some((entry) => entry.id === id)) undo.contracts.push({ id, before: (state.contracts ?? []).find((entry) => entry.id === id) ?? null });
}
function snapshotRow(undo: AssistantUndo, state: AppState, id: string) {
  undo.financeRows ??= [];
  const index = state.financeRows.findIndex((row) => row.id === id);
  if (!undo.financeRows.some((entry) => entry.id === id)) undo.financeRows.push({ id, before: state.financeRows[index] ?? null, ...(index >= 0 ? { index } : {}) });
}
// Puts a restored entry back where it stood, or at the end.
const restoreAt = <T>(items: T[], item: T, index: number | undefined) =>
  index === undefined || index > items.length ? [...items, item] : [...items.slice(0, index), item, ...items.slice(index)];
// Side effects of shared helpers (fixed-cost marks, learned merchants, receipts) are remembered too, so undo restores them.
function snapshotSideEffects(undo: AssistantUndo, before: AppState, after: AppState) {
  const rows = new Map(before.transactions.map((row) => [row.id, row]));
  snapshotTransactions(undo, after.transactions.flatMap((row) => { const previous = rows.get(row.id); return previous && previous !== row ? [previous] : []; }));
  const rules = new Map((before.merchantRules ?? []).map((rule) => [rule.key, rule]));
  undo.merchantRules ??= [];
  for (const rule of after.merchantRules ?? []) {
    const previous = rules.get(rule.key);
    if (previous !== rule && !undo.merchantRules.some((entry) => entry.key === rule.key)) undo.merchantRules.push({ key: rule.key, before: previous ?? null });
  }
  const receipts = new Map((before.fixedReceipts ?? []).map((receipt) => [receipt.key, receipt]));
  undo.fixedReceipts ??= [];
  for (const receipt of after.fixedReceipts ?? []) {
    const previous = receipts.get(receipt.key);
    if (previous && previous !== receipt && !undo.fixedReceipts.some((entry) => entry.key === receipt.key)) undo.fixedReceipts.push({ key: receipt.key, before: previous });
  }
}
function findContract(state: AppState, id: string, asOf: string): Contract {
  const contract = detectContracts(state, asOf).find((item) => item.id === id);
  if (!contract) throw new OperationError("Diesen Vertrag gibt es nicht mehr.");
  return contract;
}
function saveContract(state: AppState, id: string, patch: Partial<Omit<ContractOverride, "id" | "updatedAt">>, undo: AssistantUndo, now: number): AppState {
  snapshotContract(undo, state, id);
  const contracts = upsertContractOverride(state.contracts, id, patch, Math.floor(now));
  if (contracts.length > MAX_CONTRACTS) throw new OperationError(`Es sind höchstens ${MAX_CONTRACTS} Verträge möglich.`);
  if (!contractOverrideSchema.safeParse(contracts.find((entry) => entry.id === id)).success) throw new OperationError("Die Angaben für den Vertrag sind ungültig.");
  return { ...state, contracts };
}
function snapshotTransactions(undo: AssistantUndo, rows: Transaction[], withTags = false, withNote = false) {
  undo.transactions ??= [];
  const known = new Map(undo.transactions.map((entry) => [entry.id, entry]));
  for (const row of rows) {
    const earlier = known.get(row.id);
    if (earlier && withNote && earlier.note === undefined) earlier.note = row.note ?? "";
  }
  for (const row of rows) if (!known.has(row.id)) undo.transactions.push({
    id: row.id, category: row.category, includeInPlan: row.includeInPlan, merchantAlias: row.merchantAlias ?? "",
    ...(row.categoryOverride !== undefined ? { categoryOverride: row.categoryOverride } : {}),
    ...(row.manualCategory !== undefined ? { manualCategory: row.manualCategory } : {}),
    ...(row.reviewed !== undefined ? { reviewed: row.reviewed } : {}),
    ...(row.aiAssigned !== undefined ? { aiAssigned: row.aiAssigned } : {}),
    ...(row.fixedCost !== undefined ? { fixedCost: row.fixedCost } : {}),
    ...(row.merchantNameConfirmed !== undefined ? { merchantNameConfirmed: row.merchantNameConfirmed } : {}),
    ...(row.ignored !== undefined ? { ignored: row.ignored } : {}),
    ...(withTags ? { tags: row.tags ?? [] } : {}),
    ...(withNote ? { note: row.note ?? "" } : {}),
    sharedWithRaphael: row.sharedWithRaphael === true,
  });
}
// Rows the payroll helpers rewrote (income values, new income rows) are remembered one by one.
function snapshotChangedRows(undo: AssistantUndo, before: AppState, after: AppState) {
  const rows = new Map(before.financeRows.map((row) => [row.id, row]));
  for (const row of after.financeRows) if (rows.get(row.id) !== row) snapshotRow(undo, before, row.id);
}
function snapshotPayroll(undo: AssistantUndo, state: AppState) {
  if (undo.payrollBudget === undefined) undo.payrollBudget = state.payrollBudget ?? null;
}
const payslipMonth = (entry: { year: number; month: number }) => `${entry.year}-${String(entry.month).padStart(2, "0")}`;
function findPayslip(state: AppState, operation: { year: number; month: number; employer: string }) {
  const employer = payrollEmployerKey(operation.employer);
  const entry = (state.payslips ?? []).find((item) => item.year === operation.year && item.month === operation.month && payrollEmployerKey(item.employer) === employer);
  if (!entry) throw new OperationError(`Die Lohnabrechnung ${monthLabel(payslipMonth(operation))} gibt es nicht (mehr).`);
  return entry;
}
const correctionDiffs = (items: readonly BudgetCorrection[], after: (item: BudgetCorrection) => number) => {
  const shown = items.slice(0, 12).map((item) => ({ label: `${item.label} · ${monthLabel(item.month)}`.slice(0, 200), before: currency(item.from), after: currency(after(item)) }));
  if (items.length > 12) shown.push({ label: `${items.length - 12} weitere Budgetwerte`, before: "…", after: "…" });
  return shown;
};
const yesNo = (value: boolean | undefined) => value ? "ja" : "nein";

function findGoal(state: AppState, id: string) {
  const goal = savingsGoals(state).find((item) => item.id === id);
  if (!goal) throw new OperationError("Das Sparziel gibt es nicht mehr.");
  return goal;
}
function findPlanned(state: AppState, id: string) {
  const item = (state.plannedOneOffs ?? []).find((entry) => entry.id === id);
  if (!item) throw new OperationError("Die geplante Ausgabe gibt es nicht mehr.");
  return item;
}

function replaceGoal(state: AppState, goal: SavingsGoal | null, id: string): AppState {
  const goals = savingsGoals(state);
  const next = goal ? goals.map((item) => item.id === id ? goal : item) : goals.filter((item) => item.id !== id);
  const motorcycle = goal && pocketKey(goal.pocket) === "motorrad";
  return { ...preserveGoalOpeningBalances(state), savingsGoals: next,
    ...(motorcycle ? { settings: { ...state.settings, bikeTarget: goal.target, bikePurchaseDate: goal.date } } : {}) };
}

function applyOne(state: AppState, operation: AssistantOperation, undo: AssistantUndo, diffs: Diff[], context: { asOf: string; now: number; id: () => string }): AppState {
  switch (operation.op) {
    case "goal_update": {
      const goal = findGoal(state, operation.goalId);
      snapshotGoal(undo, state, goal.id);
      const next: SavingsGoal = { ...goal };
      if (operation.name !== undefined && operation.name !== goal.name) {
        const key = pocketKey(operation.name);
        if (["sparkonto", "urlaub", "notgroschen", "giro"].includes(key) ||
          savingsGoals(state).some((item) => item.id !== goal.id && (pocketKey(item.name) === key || pocketKey(item.pocket) === key)))
          throw new OperationError(`Den Namen „${operation.name}“ kann ich nicht verwenden.`);
        diffs.push({ label: `${goal.name}: Name`, before: goal.name, after: operation.name });
        next.name = operation.name;
      }
      if (operation.target !== undefined && operation.target !== goal.target) {
        diffs.push({ label: `${goal.name}: Ziel`, before: currency(goal.target), after: currency(operation.target) });
        next.target = operation.target;
        if (operation.target > goal.target) delete next.completedAt;
      }
      if (operation.date !== undefined && operation.date !== goal.date) {
        if (operation.date < context.asOf) throw new OperationError("Das neue Zieldatum liegt in der Vergangenheit.");
        diffs.push({ label: `${goal.name}: Bis`, before: dateLabel(goal.date), after: dateLabel(operation.date) });
        next.date = operation.date;
      }
      if (operation.monthly !== undefined && operation.monthly !== goal.funding?.monthly) {
        diffs.push({ label: `${goal.name}: Rate`, before: rate(goal), after: `${currency(operation.monthly)} / Monat` });
        next.funding = { ...(goal.funding ?? { extras: {} }), monthly: operation.monthly };
      }
      if (operation.pocket !== undefined && pocketKey(operation.pocket) !== pocketKey(goal.pocket)) {
        const key = pocketKey(operation.pocket);
        if (key === "giro" || savingsGoals(state).some((item) => item.id !== goal.id && (pocketKey(item.pocket) === key || pocketKey(item.name) === key)))
          throw new OperationError(`Das Konto „${operation.pocket}“ gehört schon zu einem anderen Ziel oder ist dein Girokonto.`);
        diffs.push({ label: `${goal.name}: Konto`, before: goal.pocket, after: operation.pocket });
        // A goal on the motorcycle pocket also sets the motorcycle target and date (replaceGoal); undo restores them.
        if (key === "motorrad") { snapshotSetting(undo, state, "bikeTarget"); snapshotSetting(undo, state, "bikePurchaseDate"); }
        next.pocket = operation.pocket;
      }
      const parsed = savingsGoalSchema.safeParse(next);
      if (!parsed.success) throw new OperationError("Die neuen Werte für das Sparziel sind ungültig.");
      return replaceGoal(state, parsed.data, goal.id);
    }
    case "goal_pause": {
      const goal = findGoal(state, operation.goalId);
      if (!goal.funding) throw new OperationError(`„${goal.name}“ hat keine feste Monatsrate, die ich aussetzen könnte.`);
      snapshotGoal(undo, state, goal.id);
      const paused = new Set(goal.funding.paused ?? []);
      if (operation.resume ? !paused.has(operation.month) : paused.has(operation.month))
        throw new OperationError(`Die Rate für „${goal.name}“ im ${monthLabel(operation.month)} ist schon ${operation.resume ? "aktiv" : "ausgesetzt"}.`);
      if (operation.resume) paused.delete(operation.month); else paused.add(operation.month);
      diffs.push({ label: `${goal.name}: Rate ${monthLabel(operation.month)}`,
        before: operation.resume ? "ausgesetzt" : currency(goal.funding.monthly),
        after: operation.resume ? currency(goal.funding.monthly) : "ausgesetzt" });
      const list = [...paused].sort();
      const funding = { ...goal.funding, ...(list.length ? { paused: list } : {}) };
      if (!list.length) delete funding.paused;
      const parsedGoal = savingsGoalSchema.safeParse({ ...goal, funding });
      if (!parsedGoal.success) throw new OperationError(`Für ${monthLabel(operation.month)} kann ich die Rate nicht aussetzen.`);
      return replaceGoal(state, parsedGoal.data, goal.id);
    }
    case "goal_extras": {
      const goal = findGoal(state, operation.goalId);
      if (!goal.funding) throw new OperationError(`„${goal.name}“ wird automatisch befüllt. Leg zuerst eine feste Monatsrate fest, dann kann ich Extra-Beträge eintragen.`);
      if (operation.from && operation.from !== "Giro" && corePocket(goal.pocket) === operation.from)
        throw new OperationError(`„${goal.name}“ liegt selbst auf dem ${operation.from}. Eine Umbuchung dorthin ändert nichts.`);
      const months = Array.from({ length: operation.months }, (_, index) => addMonth(operation.start, index));
      if (months[0] < context.asOf.slice(0, 7)) throw new OperationError("Extra-Beträge gehen nur ab dem aktuellen Monat.");
      if (months.at(-1)! > goal.date.slice(0, 7)) throw new OperationError(`Das geht über das Zieldatum von „${goal.name}“ (${dateLabel(goal.date)}) hinaus.`);
      if (months.at(-1)! > planningEndMonth(context.asOf)) throw new OperationError(`Der Monatsplan reicht nur bis ${monthLabel(planningEndMonth(context.asOf))}.`);
      snapshotGoal(undo, state, goal.id);
      const extras = { ...goal.funding.extras };
      const nextMonths = { ...state.months };
      const pocket = operation.from && operation.from !== "Giro" ? operation.from : undefined;
      const before = months.map((month) => extras[month] ?? 0);
      for (const month of months) {
        const old = extras[month] ?? 0;
        if (operation.amount > 0) extras[month] = operation.amount; else delete extras[month];
        if (pocket) {
          undo.months ??= [];
          if (!undo.months.some((entry) => entry.month === month)) undo.months.push({ month, before: state.months[month] ?? null });
          const input = nextMonths[month] ?? emptyMonth();
          const out = Math.max(0, Math.round((input.pocketOut[pocket] + operation.amount - old) * 100) / 100);
          nextMonths[month] = { ...input, pocketOut: { ...input.pocketOut, [pocket]: out } };
        }
      }
      const range = months.length === 1 ? monthLabel(months[0]) : `${monthLabel(months[0])} – ${monthLabel(months.at(-1)!)}`;
      const beforeText = before.every((value) => value === 0) ? none
        : before.every((value) => value === before[0]) ? `${months.length} × ${currency(before[0])}` : before.map((value) => currency(value)).join(", ");
      const afterText = operation.amount > 0 ? `${months.length} × ${currency(operation.amount)}${operation.from ? ` vom ${operation.from}` : ""}` : "keine";
      if (beforeText === afterText) throw new OperationError(`Bei „${goal.name}“ ist das schon so eingetragen.`);
      diffs.push({ label: `${goal.name}: Extra ${range}`, before: beforeText, after: afterText });
      if (pocket && operation.amount > 0) diffs.push({ label: `${pocket}: Entnahme ${range}`, before: none,
        after: `${currency(Math.round(operation.amount * months.length * 100) / 100)} gesamt` });
      const parsed = savingsGoalSchema.safeParse({ ...goal, funding: { ...goal.funding, extras } });
      if (!parsed.success) throw new OperationError("Die Extra-Beträge sind ungültig.");
      return { ...replaceGoal(state, parsed.data, goal.id), months: nextMonths };
    }
    case "goal_complete": {
      const goal = findGoal(state, operation.goalId);
      if (goal.completedAt) throw new OperationError(`„${goal.name}“ ist schon abgeschlossen.`);
      snapshotGoal(undo, state, goal.id);
      diffs.push({ label: `${goal.name}: Status`, before: "offen", after: `erreicht am ${dateLabel(context.asOf)}` });
      return replaceGoal(state, { ...goal, completedAt: context.asOf }, goal.id);
    }
    case "goal_delete": {
      const goal = findGoal(state, operation.goalId);
      snapshotGoal(undo, state, goal.id);
      diffs.push({ label: `Sparziel ${goal.name}`, before: `${currency(goal.target)} bis ${dateLabel(goal.date)}`, after: "entfernt" });
      return replaceGoal(state, null, goal.id);
    }
    case "planned_update": {
      const item = findPlanned(state, operation.plannedId);
      snapshotPlanned(undo, state, item.id);
      const total = operation.total ?? plannedTotal(item);
      const installments = operation.installments ?? item.installments;
      const amount = installments > 1 ? Math.floor(total * 100 / installments) / 100 : total;
      const candidate: PlannedOneOff = { ...item, name: operation.name ?? item.name, date: operation.date ?? item.date, amount, installments,
        pocket: operation.pocket ?? item.pocket };
      if (operation.shared !== undefined) {
        if (operation.shared) candidate.sharedWithRaphael = true; else delete candidate.sharedWithRaphael;
      }
      delete candidate.total;
      if (installments > 1 && Math.round(amount * installments * 100) !== Math.round(total * 100)) candidate.total = total;
      if (candidate.date.slice(0, 7) < context.asOf.slice(0, 7)) throw new OperationError("Der neue Termin liegt in der Vergangenheit.");
      const parsed = plannedOneOffSchema.safeParse(candidate);
      if (!parsed.success) throw new OperationError("Die neuen Werte für die geplante Ausgabe sind ungültig.");
      const before = plannedText(item);
      const after = plannedText(parsed.data);
      const pocketChanged = parsed.data.pocket !== item.pocket;
      const sharedChanged = Boolean(parsed.data.sharedWithRaphael) !== Boolean(item.sharedWithRaphael);
      if (before === after && candidate.name === item.name && !pocketChanged && !sharedChanged) throw new OperationError(`An „${item.name}“ würde sich nichts ändern.`);
      if (candidate.name !== item.name) diffs.push({ label: `${item.name}: Name`, before: item.name, after: candidate.name });
      if (before !== after) diffs.push({ label: candidate.name, before, after });
      if (pocketChanged) diffs.push({ label: `${candidate.name}: bezahlt von`, before: item.pocket, after: parsed.data.pocket });
      if (sharedChanged) diffs.push({ label: `${candidate.name}: mit Raphael geteilt`, before: yesNo(item.sharedWithRaphael), after: yesNo(parsed.data.sharedWithRaphael) });
      return { ...state, plannedOneOffs: (state.plannedOneOffs ?? []).map((entry) => entry.id === item.id ? parsed.data : entry) };
    }
    case "planned_delete": {
      const item = findPlanned(state, operation.plannedId);
      snapshotPlanned(undo, state, item.id);
      diffs.push({ label: `Geplant: ${item.name}`, before: plannedText(item), after: "entfernt" });
      return { ...state, plannedOneOffs: (state.plannedOneOffs ?? []).filter((entry) => entry.id !== item.id) };
    }
    case "categorize": {
      const byId = new Map(state.transactions.map((row) => [row.id, row]));
      const rows = operation.ids.map((id) => byId.get(id)).filter((row) => row !== undefined);
      if (!rows.length) throw new OperationError("Die Buchungen gibt es nicht mehr.");
      snapshotTransactions(undo, rows);
      const counts = new Map<string, number>();
      for (const row of rows) {
        const current = classify(row).category;
        counts.set(current, (counts.get(current) ?? 0) + 1);
      }
      const rulesBefore = new Map((state.merchantRules ?? []).map((rule) => [rule.key, rule]));
      const receiptsBefore = new Map((state.fixedReceipts ?? []).map((receipt) => [receipt.key, receipt]));
      let next = assignTransactions(state, rows.map((row) => row.id), { category: operation.category });
      if (!operation.learn) next = { ...next, merchantRules: state.merchantRules, merchantNameRules: state.merchantNameRules };
      const rulesAfter = new Map((next.merchantRules ?? []).map((rule) => [rule.key, rule]));
      undo.merchantRules ??= [];
      for (const [key, rule] of rulesAfter) {
        const before = rulesBefore.get(key);
        if (before !== rule && !undo.merchantRules.some((entry) => entry.key === key)) undo.merchantRules.push({ key, before: before ?? null });
      }
      undo.fixedReceipts ??= [];
      for (const receipt of next.fixedReceipts ?? []) {
        const before = receiptsBefore.get(receipt.key);
        if (before && before !== receipt && !undo.fixedReceipts.some((entry) => entry.key === receipt.key)) undo.fixedReceipts.push({ key: receipt.key, before });
      }
      diffs.push({ label: `${rows.length} ${rows.length === 1 ? "Buchung" : "Buchungen"}`,
        before: [...counts].sort((a, b) => b[1] - a[1]).map(([category, count]) => `${category} (${count})`).join(", ").slice(0, 200),
        after: operation.category });
      if (operation.learn) diffs.push({ label: "Künftige Importe", before: "wie bisher", after: `automatisch ${operation.category}` });
      return next;
    }
    case "transaction_update": {
      const ids = new Set(operation.ids);
      const rows = state.transactions.filter((row) => ids.has(row.id));
      if (!rows.length) throw new OperationError("Die Buchungen gibt es nicht mehr.");
      const label = `${rows.length} ${rows.length === 1 ? "Buchung" : "Buchungen"}`;
      const start = diffs.length;
      const changed = (pick: (row: Transaction) => unknown, value: unknown) => rows.filter((row) => pick(row) !== value).length;
      const tally = (pick: (row: Transaction) => string) => {
        const counts = new Map<string, number>();
        for (const row of rows) counts.set(pick(row), (counts.get(pick(row)) ?? 0) + 1);
        return [...counts].sort((a, b) => b[1] - a[1]).map(([value, count]) => rows.length === 1 ? value : `${value} (${count})`).join(", ").slice(0, 200);
      };
      if (operation.alias !== undefined && changed((row) => row.merchantAlias, operation.alias))
        diffs.push({ label: `${label}: Anzeigename`, before: tally((row) => row.merchantAlias || row.description.slice(0, 40)), after: operation.alias });
      if (operation.includeInPlan !== undefined && changed((row) => row.includeInPlan, operation.includeInPlan))
        diffs.push({ label: `${label}: im Monatsplan`, before: tally((row) => yesNo(row.includeInPlan)), after: yesNo(operation.includeInPlan) });
      if (operation.fixedCost !== undefined && changed((row) => Boolean(row.fixedCost), operation.fixedCost))
        diffs.push({ label: `${label}: Fixkosten`, before: tally((row) => yesNo(row.fixedCost)), after: yesNo(operation.fixedCost) });
      if (operation.reviewed !== undefined && changed((row) => Boolean(row.reviewed), operation.reviewed))
        diffs.push({ label: `${label}: geprüft`, before: tally((row) => yesNo(row.reviewed)), after: yesNo(operation.reviewed) });
      if (operation.ignored !== undefined && changed((row) => Boolean(row.ignored), operation.ignored))
        diffs.push({ label: `${label}: ignoriert`, before: tally((row) => yesNo(row.ignored)), after: yesNo(operation.ignored) });
      const note = operation.note === undefined ? undefined : operation.note?.trim() || null;
      if (note !== undefined && changed((row) => row.note ?? null, note))
        diffs.push({ label: `${label}: Notiz`, before: tally((row) => row.note ? `„${row.note}“` : none), after: note ? `„${note}“`.slice(0, 200) : "entfernt" });
      if (operation.sharedWithRaphael) {
        if (!rows.some((row) => row.amount < 0)) throw new OperationError("Teilen geht nur bei Ausgaben.");
        if (changed((row) => row.amount < 0 ? row.sharedWithRaphael === true : true, true))
          diffs.push({ label: `${label}: mit Raphael geteilt`, before: tally((row) => yesNo(row.sharedWithRaphael)), after: "ja, du zahlst die Hälfte" });
      }
      if (diffs.length === start) throw new OperationError(note === null && !rows.some((row) => row.note)
        ? `${rows.length === 1 ? "Diese Buchung hat" : "Diese Buchungen haben"} keine Notiz.`
        : `An ${rows.length === 1 ? "dieser Buchung" : "diesen Buchungen"} würde sich nichts ändern.`);
      snapshotTransactions(undo, rows, false, note !== undefined);
      return { ...state, transactions: state.transactions.map((row) => {
        if (!ids.has(row.id)) return row;
        const next: Transaction = { ...row };
        if (operation.alias !== undefined) { next.merchantAlias = operation.alias; next.merchantNameConfirmed = true; }
        if (operation.includeInPlan !== undefined) next.includeInPlan = operation.includeInPlan;
        if (operation.fixedCost !== undefined) next.fixedCost = operation.fixedCost;
        if (operation.reviewed !== undefined) next.reviewed = operation.reviewed;
        if (operation.ignored === true) next.ignored = true;
        else if (operation.ignored === false) delete next.ignored;
        if (operation.sharedWithRaphael && row.amount < 0) next.sharedWithRaphael = true;
        if (note) next.note = note;
        else if (note === null) delete next.note;
        return next;
      }) };
    }
    case "setting": {
      snapshotSetting(undo, state, operation.key);
      const before = state.settings[operation.key];
      if (before === operation.value) throw new OperationError(`${settingLabels[operation.key]} ist schon ${currency(before)}.`);
      diffs.push({ label: settingLabels[operation.key], before: currency(before), after: currency(operation.value) });
      return { ...state, settings: { ...state.settings, [operation.key]: operation.value } };
    }
    case "memory_add": {
      const memory = state.assistantMemory ?? [];
      const replaced = operation.key === "note" || operation.key === "reminder" ? undefined : memory.find((entry) => entry.key === operation.key);
      undo.memory ??= [];
      if (replaced) undo.memory.push({ id: replaced.id, before: replaced });
      const entry = assistantMemorySchema.parse({ id: context.id(), text: operation.text, key: operation.key,
        ...(operation.value !== undefined ? { value: operation.value } : {}), ...(operation.due ? { due: operation.due } : {}), at: context.now });
      undo.memory.push({ id: entry.id, before: null });
      if (!replaced && memory.length >= MAX_ASSISTANT_MEMORY) throw new OperationError(`Ich kann mir höchstens ${MAX_ASSISTANT_MEMORY} Dinge merken. Lösch zuerst etwas.`);
      diffs.push({ label: entry.key === "reminder" ? "Erinnerung" : "Gedächtnis", before: replaced?.text ?? none, after: entry.text });
      return { ...state, assistantMemory: [...memory.filter((item) => item.id !== replaced?.id), entry] };
    }
    case "memory_delete": {
      const memory = state.assistantMemory ?? [];
      const entry = memory.find((item) => item.id === operation.memoryId);
      if (!entry) throw new OperationError("Diesen Eintrag gibt es nicht mehr.");
      undo.memory ??= [];
      undo.memory.push({ id: entry.id, before: entry });
      diffs.push({ label: "Gedächtnis", before: entry.text, after: "vergessen" });
      return { ...state, assistantMemory: memory.filter((item) => item.id !== entry.id) };
    }
    case "review_resolve": {
      const queue = state.reviewQueue ?? [];
      const decisions = operation.decisions.filter((decision) => queue.some((item) => item.id === decision.reviewId));
      if (!decisions.length) throw new OperationError("Diese Einträge sind schon erledigt.");
      const result = applyAiReviewDecisions(state, decisions);
      if (!result.applied.length) throw new OperationError("Diese Einträge lassen sich so nicht automatisch erledigen.");
      const before = new Map(state.transactions.map((row) => [row.id, row]));
      const added = result.state.transactions.filter((row) => !before.has(row.id));
      // AMEX entries reconcile into an existing booking instead of adding one.
      snapshotTransactions(undo, result.state.transactions.flatMap((row) => {
        const previous = before.get(row.id);
        return previous && previous !== row && JSON.stringify(previous) !== JSON.stringify(row) ? [previous] : [];
      }));
      const done = new Set(result.applied);
      const rulesBefore = new Map((state.merchantRules ?? []).map((rule) => [rule.key, rule]));
      undo.merchantRules ??= [];
      for (const rule of result.state.merchantRules ?? []) {
        const previous = rulesBefore.get(rule.key);
        if (previous !== rule && !undo.merchantRules.some((entry) => entry.key === rule.key)) undo.merchantRules.push({ key: rule.key, before: previous ?? null });
      }
      undo.reviews ??= [];
      for (const item of queue.filter((entry) => done.has(entry.id))) {
        const draft = item.kind === "booking" ? item.draft : undefined;
        const ids = draft ? added.filter((row) => row.date === draft.date && row.amount === draft.amount && row.description === draft.description).map((row) => row.id) : [];
        undo.reviews.push({ item, transactionIds: ids.slice(0, 20) });
        const decision = decisions.find((entry) => entry.reviewId === item.id)!;
        diffs.push({ label: `${draft ? `${dateLabel(draft.date ?? "")} · ${draft.description}` : "Prüf-Eintrag"}`.slice(0, 200), before: "Prüfen", after: canonicalCategory(decision.category) });
      }
      return result.state;
    }
    case "budget_plan": {
      const line = variableBudgetLines.find((item) => item.id === operation.line)!;
      const month = context.asOf.slice(0, 7);
      const base = defaultBudgetAmount(line, month, state.holidayRanges ?? []);
      const current = state.budgetAdjustments ?? {};
      const before = current[line.id] ?? 0;
      const adjustment = Math.round(Math.max(-base, operation.adjustment) * 100) / 100;
      if (adjustment === before) throw new OperationError(`${line.label} ist schon ${currency(Math.max(0, base + before))} im Monat.`);
      undo.budget ??= [];
      if (!undo.budget.some((entry) => entry.line === line.id)) undo.budget.push({ line: line.id, before: current[line.id] ?? null });
      diffs.push({ label: `Budget ${line.label} (pro Monat ab ${monthLabel(month)})`, before: currency(Math.max(0, base + before)), after: currency(Math.max(0, base + adjustment)) });
      const next = { ...current, [line.id]: adjustment };
      if (!adjustment) delete next[line.id];
      return { ...state, budgetAdjustments: next };
    }
    case "contract_create": {
      if ((state.contracts ?? []).some((entry) => entry.id === operation.contractId)) throw new OperationError("Diesen Vertrag gibt es schon.");
      const { op: _op, contractId, ...fields } = operation;
      void _op;
      const patch = { manual: true, status: "confirmed" as const, ...fields,
        ...(fields.termEnd ? { autoRenew: fields.autoRenew ?? true, renewalMonths: fields.autoRenew === false ? undefined : fields.renewalMonths ?? 12 } : { autoRenew: undefined, renewalMonths: undefined }) };
      diffs.push({ label: "Neuer Vertrag", before: none, after: `${fields.name}: ${currency(fields.amount)} ${intervalLabel[fields.interval]}`.slice(0, 200) });
      diffs.push({ label: `${fields.name}: nächste Abbuchung`, before: none, after: dateLabel(fields.nextDate) });
      diffs.push({ label: `${fields.name}: Kategorie`, before: none, after: fields.category });
      if (fields.notice) diffs.push({ label: `${fields.name}: Kündigungsfrist`, before: none, after: noticeLabel(fields.notice) });
      if (fields.termEnd) diffs.push({ label: `${fields.name}: Mindestlaufzeit bis`, before: none,
        after: `${dateLabel(fields.termEnd)}${patch.autoRenew ? `, verlängert sich um ${patch.renewalMonths} Monate` : ", endet dann"}` });
      if (fields.match) diffs.push({ label: `${fields.name}: Buchungen automatisch zuordnen`, before: none, after: matchText(fields.match).slice(0, 200) });
      if (fields.note) diffs.push({ label: `${fields.name}: Notiz`, before: none, after: fields.note.slice(0, 200) });
      if (fields.bookingIds?.length) {
        const known = new Set(state.transactions.map((row) => row.id));
        const picked = fields.bookingIds.filter((id) => known.has(id));
        if (!picked.length) throw new OperationError("Die Buchungen für diesen Vertrag gibt es nicht mehr.");
        patch.bookingIds = picked;
        diffs.push({ label: `${fields.name}: zugeordnete Buchungen`, before: none, after: `${picked.length} ${picked.length === 1 ? "Buchung" : "Buchungen"}` });
      }
      return saveContract(state, contractId, patch, undo, context.now);
    }
    case "contract_update": {
      const contract = findContract(state, operation.contractId, context.asOf);
      const stored = (state.contracts ?? []).find((entry) => entry.id === contract.id);
      const patch: Partial<Omit<ContractOverride, "id" | "updatedAt">> = {};
      const label = (field: string) => `${contract.name}: ${field}`;
      const set = <K extends keyof ContractOverride>(key: K, value: ContractOverride[K] | undefined, field: string, before: string, after: string) => {
        if (before === after) return;
        Object.assign(patch, { [key]: value });
        diffs.push({ label: label(field), before, after });
      };
      if (operation.name !== undefined) set("name", operation.name, "Name", contract.name, operation.name);
      if (operation.category !== undefined) set("category", operation.category, "Kategorie", contract.category, operation.category);
      if (operation.amount !== undefined) set("amount", operation.amount, "Betrag", currency(contract.amount), currency(operation.amount));
      if (operation.interval !== undefined) set("interval", operation.interval, "Rhythmus", intervalLabel[contract.interval], intervalLabel[operation.interval]);
      if (operation.nextDate !== undefined) set("nextDate", operation.nextDate, "Nächste Abbuchung", contract.nextDate ? dateLabel(contract.nextDate) : none, dateLabel(operation.nextDate));
      if (operation.notice !== undefined) set("notice", operation.notice ?? undefined, "Kündigungsfrist", contract.notice ? noticeLabel(contract.notice) : none, operation.notice ? noticeLabel(operation.notice) : none);
      if (operation.termEnd !== undefined) {
        set("termEnd", operation.termEnd ?? undefined, "Mindestlaufzeit bis", contract.termEnd ? dateLabel(contract.termEnd) : none, operation.termEnd ? dateLabel(operation.termEnd) : none);
        if (operation.termEnd === null) Object.assign(patch, { autoRenew: undefined, renewalMonths: undefined });
      }
      if (operation.autoRenew !== undefined) set("autoRenew", operation.autoRenew, "Verlängert sich automatisch", yesNo(contract.autoRenew), yesNo(operation.autoRenew));
      if (operation.renewalMonths !== undefined) set("renewalMonths", operation.renewalMonths, "Verlängerung", `${contract.renewalMonths} Monate`, `${operation.renewalMonths} Monate`);
      if (operation.note !== undefined) set("note", operation.note || undefined, "Notiz", contract.note ?? none, operation.note || none);
      if (operation.match !== undefined) set("match", operation.match ?? undefined, "Buchungen automatisch zuordnen", matchText(stored?.match), matchText(operation.match ?? undefined));
      if (!Object.keys(patch).length) throw new OperationError(`An „${contract.name}“ würde sich nichts ändern.`);
      // Editing a suggestion confirms it, like saving it in the wizard.
      if (contract.status === "review") {
        patch.status = "confirmed";
        diffs.push({ label: label("Status"), before: statusLabels.review, after: "bestätigt" });
      }
      return saveContract(state, contract.id, contractPatch(contract, patch), undo, context.now);
    }
    case "contract_bookings": {
      const contract = findContract(state, operation.contractId, context.asOf);
      const stored = (state.contracts ?? []).find((entry) => entry.id === contract.id);
      const rows = new Map(state.transactions.map((row) => [row.id, row]));
      const charged = new Set(contract.charges.map((charge) => charge.id));
      const add = [...new Set(operation.add ?? [])].filter((id) => rows.has(id) && !charged.has(id));
      const remove = [...new Set(operation.remove ?? [])].filter((id) => charged.has(id) || stored?.bookingIds?.includes(id));
      if (!add.length && !remove.length) throw new OperationError((operation.add?.length ? `Diese Buchung gehört schon zu „${contract.name}“.` : `Diese Buchung gehört nicht zu „${contract.name}“.`));
      const describe = (id: string) => { const row = rows.get(id); return row ? `${dateLabel(row.date)} · ${currency(row.amount)}` : id; };
      for (const id of add) diffs.push({ label: `${contract.name}: Buchung ${describe(id)}`.slice(0, 200), before: "nicht zugeordnet", after: "zugeordnet" });
      for (const id of remove) diffs.push({ label: `${contract.name}: Buchung ${describe(id)}`.slice(0, 200), before: "zugeordnet", after: "nicht mehr zugeordnet" });
      const removed = new Set(remove);
      const picked = [...new Set([...(stored?.bookingIds ?? []).filter((id) => !removed.has(id)), ...add])].slice(-500);
      const added = new Set(add);
      const excluded = [...new Set([...(stored?.excludedBookingIds ?? []).filter((id) => !added.has(id)), ...remove])].slice(-500);
      const patch: Partial<Omit<ContractOverride, "id" | "updatedAt">> = { bookingIds: picked.length ? picked : undefined, excludedBookingIds: excluded.length ? excluded : undefined };
      if (contract.status === "review") patch.status = "confirmed";
      return saveContract(state, contract.id, patch, undo, context.now);
    }
    case "payslip_confirm": {
      const entry = findPayslip(state, operation);
      if (!heldPayslips(state).some((item) => payslipKey(item.entry) === payslipKey(entry)))
        throw new OperationError(`Die Lohnabrechnung ${monthLabel(payslipMonth(entry))} ist schon im Budget.`);
      snapshotPayroll(undo, state);
      const { state: next } = confirmPayslip(state, entry);
      snapshotChangedRows(undo, state, next);
      diffs.push({ label: `Lohnabrechnung ${monthLabel(payslipMonth(entry))}`, before: "zurückgehalten", after: "ins Budget übernommen" });
      for (const row of next.financeRows) {
        const previous = state.financeRows.find((item) => item.id === row.id);
        const month = payslipMonth(entry);
        if ((previous?.values[month] ?? null) !== (row.values[month] ?? null))
          diffs.push({ label: `${row.label} · ${monthLabel(month)}`, before: previous?.values[month] === undefined || previous.values[month] === null ? none : currency(previous.values[month]!),
            after: row.values[month] === undefined || row.values[month] === null ? none : currency(row.values[month]!) });
      }
      return next;
    }
    case "payslip_remove": {
      const entry = findPayslip(state, operation);
      const key = payslipKey(entry);
      undo.payslips ??= [];
      if (!undo.payslips.some((item) => item.key === key)) undo.payslips.push({ key, before: entry, index: (state.payslips ?? []).findIndex((item) => payslipKey(item) === key) });
      if (undo.payrollForecasts === undefined) undo.payrollForecasts = state.payrollForecasts ?? null;
      const payslips = (state.payslips ?? []).filter((item) => payslipKey(item) !== key);
      const matches = (item: { year: number; employer: string }) => item.year === entry.year && payrollEmployerKey(item.employer) === payrollEmployerKey(entry.employer);
      diffs.push({ label: `Lohnabrechnung ${monthLabel(payslipMonth(entry))} · ${entry.employer}`.slice(0, 200), before: "gespeichert", after: "entfernt (PDF und Kontoumsätze bleiben)" });
      return { ...state, payslips,
        payrollForecasts: state.payrollForecasts?.filter((forecast) => !matches(forecast) || payslips.some(matches))
          .map((forecast) => matches(forecast) ? { ...forecast, standardPayrollConfirmed: false } : forecast) };
    }
    case "payroll_sync": {
      snapshotPayroll(undo, state);
      let next = state;
      if (operation.review) {
        const { review } = autoBudgetCorrections(state);
        if (!review.length) throw new OperationError("Es warten keine Budgetwerte auf deine Prüfung.");
        next = operation.review === "apply" ? reviewPayrollBudget(state, review, []) : reviewPayrollBudget(state, [], review);
        diffs.push(...(operation.review === "apply" ? correctionDiffs(review, (item) => item.to)
          : [{ label: `${review.length === 1 ? "1 Budgetwert" : `${review.length} Budgetwerte`} zur Prüfung`, before: "offen", after: "bleiben wie sie sind" }]));
      } else {
        const synced = syncPayrollBudget(state, context.now);
        if (!synced.applied.length) throw new OperationError(synced.review.length
          ? `Das Budget ist auf dem Stand deiner Abrechnungen. ${synced.review.length === 1 ? "1 Wert wartet" : `${synced.review.length} Werte warten`} noch auf deine Prüfung.`
          : "Das Budget ist schon auf dem Stand deiner Abrechnungen.");
        next = synced.state;
        diffs.push(...correctionDiffs(synced.applied, (item) => item.to));
      }
      snapshotChangedRows(undo, state, next);
      return next;
    }
    case "setting_flag": {
      const before = state.settings.payslipTermLookup !== false;
      if (before === operation.value) throw new OperationError(`Die Begriffserklärung ist schon ${operation.value ? "an" : "aus"}.`);
      snapshotSetting(undo, state, "payslipTermLookup");
      diffs.push({ label: "Gehaltszettel: Begriffe erklären", before: before ? "an" : "aus", after: operation.value ? "an" : "aus" });
      return { ...state, settings: { ...state.settings, payslipTermLookup: operation.value } };
    }
    case "seasonal_theme": {
      const current = state.seasonalTheme;
      const label = (preference: typeof current) => preference?.mode === "fixed" && preference.theme ? seasonalLabels[preference.theme]
        : preference?.mode === "default" ? seasonalLabels.default : "Automatisch (Saison)";
      const next = operation.theme === "auto" ? resetSeasonalTheme(current) : chooseSeasonalTheme(current, operation.theme);
      if (label(current) === label(next)) throw new OperationError(`Das Erscheinungsbild ist schon „${label(next)}“.`);
      if (undo.seasonalTheme === undefined) undo.seasonalTheme = current ?? null;
      diffs.push({ label: "Erscheinungsbild", before: label(current), after: label(next) });
      return { ...state, seasonalTheme: next };
    }
    case "contract_action": {
      const contract = findContract(state, operation.contractId, context.asOf);
      const status = statusLabels[contract.status];
      const change = (patch: Partial<Omit<ContractOverride, "id" | "updatedAt">>, after: string) => {
        diffs.push({ label: `${contract.name}: Status`, before: status, after });
        return saveContract(state, contract.id, contractPatch(contract, patch), undo, context.now);
      };
      switch (operation.action) {
        case "confirm":
          if (contract.status !== "review") throw new OperationError(`„${contract.name}“ ist schon ${contract.status === "ignored" ? "ausgeblendet – stell ihn zuerst wieder her" : "bestätigt"}.`);
          return change({ status: "confirmed" }, "bestätigt");
        case "ignore":
          if (contract.status === "ignored") throw new OperationError(`„${contract.name}“ ist schon ausgeblendet.`);
          return change({ status: "ignored" }, "kein Vertrag (ausgeblendet)");
        case "restore":
          if (contract.status !== "ignored") throw new OperationError(`„${contract.name}“ ist nicht ausgeblendet.`);
          return change({ status: undefined }, "wiederhergestellt");
        case "cancel": {
          const end = operation.date ?? contract.effectiveEnd ?? contract.nextDate ?? context.asOf;
          if (contract.status === "cancelled" && contract.cancelledAt === end) throw new OperationError(`„${contract.name}“ ist schon zum ${dateLabel(end)} gekündigt.`);
          return change({ status: "cancelled", cancelledAt: end }, `gekündigt, endet ${dateLabel(end)}`);
        }
        case "reactivate":
          if (contract.status !== "cancelled") throw new OperationError(`„${contract.name}“ ist nicht gekündigt.`);
          return change({ status: "confirmed", cancelledAt: undefined }, "wieder aktiv");
        case "reset":
          if (!contract.edited) throw new OperationError(`An „${contract.name}“ gibt es keine eigenen Änderungen zum Verwerfen.`);
          diffs.push({ label: `${contract.name}: eigene Angaben`, before: "geändert", after: "verworfen, wie erkannt" });
          return saveContract(state, contract.id, contractPatch(contract, Object.fromEntries(editedKeys.map((key) => [key, undefined]))), undo, context.now);
        case "remove": {
          if (contract.source !== "manual") throw new OperationError(`„${contract.name}“ wurde aus deinen Buchungen erkannt. Entfernen geht nur bei selbst angelegten Verträgen – ausblenden kann ich ihn aber.`);
          snapshotContract(undo, state, contract.id);
          diffs.push({ label: `Vertrag ${contract.name}`, before: `${currency(contract.amount)} ${intervalLabel[contract.interval]}`, after: "entfernt" });
          return { ...state, contracts: (state.contracts ?? []).filter((entry) => entry.id !== contract.id) };
        }
      }
      throw new OperationError("Diese Aktion kenne ich nicht.");
    }
    case "transaction_delete": {
      const ids = new Set(operation.ids);
      const rows = state.transactions.filter((row) => ids.has(row.id));
      if (!rows.length) throw new OperationError("Die Buchungen gibt es nicht mehr.");
      undo.removedTransactions ??= [];
      let receipts = state.fixedReceipts;
      for (const row of rows) {
        const keys = new Set([row.id, statementFingerprint(row), legacyFingerprint(row)]);
        const linked = (receipts ?? []).filter((item) => keys.has(item.key));
        receipts = receipts?.filter((item) => !keys.has(item.key));
        undo.removedTransactions.push({ transaction: row, receipts: linked.slice(0, 20) });
        diffs.push({ label: `${dateLabel(row.date)} · ${row.merchantAlias || row.description}`.slice(0, 200), before: currency(row.amount), after: "gelöscht" });
      }
      return { ...state, transactions: state.transactions.filter((row) => !ids.has(row.id)), ...(receipts ? { fixedReceipts: receipts } : {}) };
    }
    case "transaction_tag": {
      const ids = new Set(operation.ids);
      const rows = state.transactions.filter((row) => ids.has(row.id));
      if (!rows.length) throw new OperationError("Die Buchungen gibt es nicht mehr.");
      const next = setTag(state, ids, operation.tag, operation.remove);
      const touched = rows.filter((row) => next.transactions.find((item) => item.id === row.id) !== row);
      if (!touched.length) throw new OperationError(operation.remove ? `Keine dieser Buchungen hat den Tag „${operation.tag}“.`
        : `${rows.length === 1 ? "Die Buchung hat" : "Die Buchungen haben"} den Tag schon oder schon ${10} Tags.`);
      snapshotTransactions(undo, touched, true);
      diffs.push({ label: `${touched.length} ${touched.length === 1 ? "Buchung" : "Buchungen"}: Tag #${operation.tag.replace(/^#+/, "")}`.slice(0, 200),
        before: operation.remove ? "gesetzt" : "ohne", after: operation.remove ? "entfernt" : "gesetzt" });
      return next;
    }
    case "plan_row_save": {
      const existing = state.financeRows.find((row) => row.id === operation.rowId);
      if (operation.create) {
        if (existing) throw new OperationError("Diese Position gibt es schon.");
        if (state.financeRows.length >= 200) throw new OperationError("Es sind höchstens 200 Positionen möglich. Entferne zuerst eine nicht mehr benötigte Position.");
        if (operation.kind === "variable") throw new OperationError("Eine neue Position ist Einnahme oder Fixkosten; variable Budgets sind fest vorgegeben.");
        const parsed = financeRowSchema.safeParse({ id: operation.rowId, label: operation.label, kind: operation.kind ?? "fixed",
          ...(operation.planCategory ? { planCategory: operation.planCategory } : {}), values: {} });
        if (!parsed.success) throw new OperationError("Für eine neue Position brauche ich eine Bezeichnung.");
        snapshotRow(undo, state, operation.rowId);
        diffs.push({ label: "Neue Position im Monatsplan", before: none, after: `${parsed.data.label} (${kindLabels[parsed.data.kind]})` });
        return { ...state, financeRows: [...state.financeRows, parsed.data] };
      }
      if (!existing) throw new OperationError("Diese Position gibt es nicht mehr.");
      if (operation.kind === "variable" && existing.kind !== "variable") throw new OperationError("Eine Position ist Einnahme oder Fixkosten; variable Budgets sind fest vorgegeben.");
      const revised: FinanceRow = { ...existing, label: operation.label ?? existing.label, kind: operation.kind ?? existing.kind,
        planCategory: operation.planCategory === undefined ? existing.planCategory : operation.planCategory ?? undefined };
      if (revised.planCategory === undefined) delete revised.planCategory;
      if (revised.label !== existing.label) diffs.push({ label: `${existing.label}: Bezeichnung`, before: existing.label, after: revised.label });
      if (revised.kind !== existing.kind) diffs.push({ label: `${existing.label}: Bereich`, before: kindLabels[existing.kind], after: kindLabels[revised.kind] });
      if (revised.planCategory !== existing.planCategory) diffs.push({ label: `${existing.label}: Kategorie`, before: existing.planCategory ?? none, after: revised.planCategory ?? none });
      if (!financeRowSchema.safeParse(revised).success) throw new OperationError("Die neuen Angaben für die Position sind ungültig.");
      snapshotRow(undo, state, existing.id);
      if (revised.fixedSource && revised.kind !== "fixed") {
        const removed = removeFixedPlanRow(state, revised);
        snapshotSideEffects(undo, state, removed);
        return { ...removed, financeRows: [...removed.financeRows, { ...revised, fixedSource: undefined }] };
      }
      return { ...state, financeRows: state.financeRows.map((row) => row.id === existing.id ? revised : row) };
    }
    case "plan_row_delete": {
      const existing = state.financeRows.find((row) => row.id === operation.rowId);
      if (!existing) throw new OperationError("Diese Position gibt es nicht mehr.");
      snapshotRow(undo, state, existing.id);
      diffs.push({ label: `Position ${existing.label}`, before: kindLabels[existing.kind], after: "gelöscht" });
      if (existing.fixedSource) diffs.push({ label: `${existing.label}: Buchungen`, before: "als Fixkosten markiert", after: "bleiben, ohne Fixkosten-Markierung" });
      const next = removeFixedPlanRow(state, existing);
      snapshotSideEffects(undo, state, next);
      return next;
    }
    case "plan_value": {
      const existing = state.financeRows.find((row) => row.id === operation.rowId);
      if (!existing) throw new OperationError("Diese Position gibt es nicht mehr.");
      const shown = (value: number | null | undefined) => value === undefined || value === null ? (existing.kind === "variable" ? "automatisch" : currency(0)) : currency(value);
      // Budget lines are recomputed from their monthly amount for the current and later months (applyVariableBudgets).
      if (existing.kind === "variable" && operation.months.some((month) => month >= context.asOf.slice(0, 7)))
        throw new OperationError(`„${existing.label}“ ist ein Budget und gilt für jeden Monat gleich – einzelne Monate lassen sich dort nicht setzen.`);
      const months = [...new Set(operation.months)].sort().filter((month) => (existing.values[month] ?? null) !== operation.value);
      if (!months.length) throw new OperationError(`${existing.label} ist dort schon ${operation.value === null ? "automatisch" : currency(operation.value)}.`);
      snapshotRow(undo, state, existing.id);
      // One line per month; a long range is summed up as one line.
      if (months.length <= 3) for (const month of months)
        diffs.push({ label: `${existing.label} · ${monthLabel(month)}`, before: shown(existing.values[month]), after: shown(operation.value) });
      else diffs.push({ label: `${existing.label} · ${monthLabel(months[0])} bis ${monthLabel(months.at(-1)!)}`.slice(0, 200),
        before: [...new Set(months.map((month) => shown(existing.values[month])))].join(", ").slice(0, 200), after: `${shown(operation.value)} pro Monat` });
      const values = Object.fromEntries(months.map((month) => [month, operation.value]));
      return { ...state, financeRows: state.financeRows.map((row) => row.id !== existing.id ? row : {
        ...row, ...(row.kind === "variable" ? { overrides: { ...row.overrides, ...values } } : {}), values: { ...row.values, ...values } }) };
    }
    case "account_rule": {
      const rules = state.accountRules ?? [];
      const replaced = rules.find((rule) => squash(rule.account) === squash(operation.account));
      if (!replaced && rules.length >= MAX_ACCOUNT_RULES) throw new OperationError(`Es sind höchstens ${MAX_ACCOUNT_RULES} Kontoregeln möglich. Lösch zuerst eine.`);
      const rule: AccountRule = { id: context.id(), account: operation.account, use: operation.use, purposes: operation.use === "only" ? operation.purposes : [], at: Math.floor(context.now) };
      if (rule.use === "only" && !rule.purposes.length) throw new OperationError("Wofür darf das Konto verwendet werden?");
      if (replaced && replaced.use === rule.use && replaced.purposes.join("|") === rule.purposes.join("|")) throw new OperationError(`Für ${replaced.account} gilt das schon.`);
      undo.accountRules ??= [];
      if (replaced) undo.accountRules.push({ id: replaced.id, before: replaced });
      undo.accountRules.push({ id: rule.id, before: null });
      diffs.push({ label: `Konto ${operation.account}`, before: replaced ? ruleText(replaced) : "keine Regel", after: ruleText(rule) });
      return { ...state, accountRules: [...rules.filter((item) => item.id !== replaced?.id), rule] };
    }
    case "account_rule_delete": {
      const rule = (state.accountRules ?? []).find((item) => item.id === operation.ruleId);
      if (!rule) throw new OperationError("Diese Kontoregel gibt es nicht mehr.");
      undo.accountRules ??= [];
      undo.accountRules.push({ id: rule.id, before: rule });
      diffs.push({ label: `Konto ${rule.account}`, before: ruleText(rule), after: "keine Regel" });
      return { ...state, accountRules: (state.accountRules ?? []).filter((item) => item.id !== rule.id) };
    }
    case "bonus_percent": {
      const before = successBonusPercent(state.settings);
      if (before === operation.value) throw new OperationError(`Der Successbonus ist schon ${before.toLocaleString("de-DE")} %.`);
      snapshotSetting(undo, state, "successBonusPercent");
      diffs.push({ label: "Successbonus (vom Grundgehalt)", before: `${before.toLocaleString("de-DE")} %`, after: operation.value === 0 ? "aus" : `${operation.value.toLocaleString("de-DE")} %` });
      return { ...state, settings: { ...state.settings, successBonusPercent: operation.value } };
    }
  }
}

// Applies allowlisted operations in order; throws OperationError with a readable German reason.
export function applyOperations(state: AppState, operations: AssistantOperation[], context: { asOf?: string; now?: number; id?: () => string } = {}): AppliedChange {
  const undo: AssistantUndo = {};
  const diffs: Diff[] = [];
  const ctx = { asOf: context.asOf ?? state.settings.asOf, now: context.now ?? Date.now(), id: context.id ?? (() => crypto.randomUUID()) };
  let next = state;
  for (const operation of operations) {
    const before = diffs.length;
    next = applyOne(next, operation, undo, diffs, ctx);
    if (diffs.length === before) throw new OperationError("Diese Änderung hätte keine Wirkung.");
  }
  for (const key of Object.keys(undo) as (keyof AssistantUndo)[]) {
    const value = undo[key];
    if (Array.isArray(value) && !value.length) delete undo[key];
  }
  return { state: next, diffs, undo };
}

export function recordChange(state: AppState, applied: AppliedChange, entry: { id: string; at: number; title: string }): AppState {
  const log: AssistantChangeLog = { ...entry, title: entry.title.slice(0, 200),
    summary: applied.diffs.slice(0, 80).map((diff) => `${diff.label}: ${diff.before} → ${diff.after}`.slice(0, 300)), undo: applied.undo };
  return { ...applied.state, assistantChanges: [...(applied.state.assistantChanges ?? []), log].slice(-MAX_ASSISTANT_CHANGES) };
}

// Goals and planned purchases created through the chat also land in the change log so they can be undone.
export function recordCreation(before: AppState, after: AppState, created: { kind: "goal" | "planned"; itemId: string; summary: string },
  entry: { id: string; at: number; title: string }): AppState {
  const undo: AssistantUndo = created.kind === "goal"
    ? { ...(before.savingsGoals === undefined ? { goalsUnset: true } : {}), goals: [{ id: created.itemId, before: null }] }
    : { planned: [{ id: created.itemId, before: null }] };
  return recordChange(after, { state: after, undo, diffs: [{ label: created.kind === "goal" ? "Neues Sparziel" : "Neue geplante Ausgabe", before: none, after: created.summary }] }, entry);
}

// Restores exactly the entities the change touched; later unrelated edits stay.
export function undoChange(state: AppState, logId: string, now = Date.now()): AppState {
  const log = (state.assistantChanges ?? []).find((entry) => entry.id === logId);
  if (!log) throw new OperationError("Diese Änderung finde ich nicht mehr.");
  if (log.undoneAt) throw new OperationError("Diese Änderung ist schon rückgängig gemacht.");
  const { undo } = log;
  let next: AppState = { ...state };
  if (undo.goals?.length) {
    let goals = savingsGoals(next);
    for (const { id, before } of [...undo.goals].reverse()) {
      const exists = goals.some((goal) => goal.id === id);
      goals = before === null ? goals.filter((goal) => goal.id !== id)
        : exists ? goals.map((goal) => goal.id === id ? before : goal) : [...goals, before];
    }
    next.savingsGoals = goals;
    if (undo.goalsUnset) delete next.savingsGoals;
  }
  if (undo.planned?.length) {
    let items = [...(next.plannedOneOffs ?? [])];
    for (const { id, before } of [...undo.planned].reverse()) {
      const exists = items.some((item) => item.id === id);
      items = before === null ? items.filter((item) => item.id !== id)
        : exists ? items.map((item) => item.id === id ? before : item) : [...items, before];
    }
    next.plannedOneOffs = items;
  }
  if (undo.settings?.length) {
    const settings = { ...next.settings };
    for (const { key, before } of undo.settings) {
      if (before === null) delete settings[key]; else Object.assign(settings, { [key]: before });
    }
    next.settings = settings;
  }
  if (undo.months?.length) {
    const months = { ...next.months };
    for (const { month, before } of undo.months) {
      if (before) months[month] = before; else delete months[month];
    }
    next.months = months;
  }
  if (undo.memory?.length) {
    let memory = [...(next.assistantMemory ?? [])];
    for (const { id, before } of [...undo.memory].reverse()) {
      memory = memory.filter((entry) => entry.id !== id);
      if (before) memory.push(before);
    }
    next.assistantMemory = memory.sort((a, b) => a.at - b.at).slice(-MAX_ASSISTANT_MEMORY);
  }
  if (undo.transactions?.length) {
    const fields = new Map(undo.transactions.map((entry) => [entry.id, entry]));
    next.transactions = next.transactions.map((row) => {
      const before = fields.get(row.id);
      if (!before) return row;
      const restored = { ...row };
      for (const key of ["categoryOverride", "manualCategory", "reviewed", "aiAssigned", "fixedCost", "ignored"] as const) delete restored[key];
      if (before.merchantAlias !== undefined) delete restored.merchantNameConfirmed;
      const result = { ...restored, ...before };
      if (result.merchantAlias === "") delete result.merchantAlias;
      if (before.tags && !before.tags.length) delete result.tags;
      if (before.sharedWithRaphael === false) delete result.sharedWithRaphael;
      if (before.note === "") delete result.note;
      return result;
    });
  }
  if (undo.merchantRules?.length) {
    const rules = new Map((next.merchantRules ?? []).map((rule) => [rule.key, rule]));
    for (const { key, before } of undo.merchantRules) {
      if (before) rules.set(key, before); else rules.delete(key);
    }
    next.merchantRules = [...rules.values()];
  }
  if (undo.fixedReceipts?.length && next.fixedReceipts) {
    const receipts = new Map(undo.fixedReceipts.map((entry) => [entry.key, entry.before]));
    next.fixedReceipts = next.fixedReceipts.map((receipt) => receipts.get(receipt.key) ?? receipt);
  }
  if (undo.reviews?.length) {
    const remove = new Set(undo.reviews.flatMap((entry) => entry.transactionIds));
    const open = new Set((next.reviewQueue ?? []).map((item) => item.id));
    next.transactions = next.transactions.filter((row) => !remove.has(row.id));
    next.reviewQueue = [...(next.reviewQueue ?? []), ...undo.reviews.map((entry) => entry.item).filter((item) => !open.has(item.id))];
  }
  if (undo.budget?.length) {
    const adjustments = { ...next.budgetAdjustments };
    for (const { line, before } of [...undo.budget].reverse()) {
      if (before === null) delete adjustments[line]; else adjustments[line] = before;
    }
    next.budgetAdjustments = adjustments;
  }
  if (undo.contracts?.length) {
    let contracts = [...(next.contracts ?? [])];
    for (const { id, before } of [...undo.contracts].reverse()) {
      const exists = contracts.some((entry) => entry.id === id);
      contracts = before === null ? contracts.filter((entry) => entry.id !== id)
        : exists ? contracts.map((entry) => entry.id === id ? before : entry) : [...contracts, before];
    }
    next.contracts = contracts;
  }
  if (undo.removedTransactions?.length) {
    const present = new Set(next.transactions.map((row) => row.id));
    next.transactions = [...next.transactions, ...undo.removedTransactions.map((entry) => entry.transaction).filter((row) => !present.has(row.id))];
    const receipts = undo.removedTransactions.flatMap((entry) => entry.receipts);
    if (receipts.length) {
      const known = new Set((next.fixedReceipts ?? []).map((receipt) => receipt.key));
      next.fixedReceipts = [...(next.fixedReceipts ?? []), ...receipts.filter((receipt) => !known.has(receipt.key))];
    }
  }
  if (undo.financeRows?.length) {
    let rows = [...next.financeRows];
    for (const { id, before, index } of [...undo.financeRows].reverse()) {
      const exists = rows.some((row) => row.id === id);
      rows = before === null ? rows.filter((row) => row.id !== id) : exists ? rows.map((row) => row.id === id ? before : row) : restoreAt(rows, before, index);
    }
    next.financeRows = rows;
  }
  if (undo.accountRules?.length) {
    let rules = [...(next.accountRules ?? [])];
    for (const { id, before } of [...undo.accountRules].reverse()) {
      rules = rules.filter((rule) => rule.id !== id);
      if (before) rules.push(before);
    }
    next.accountRules = rules.sort((a, b) => a.at - b.at);
  }
  if (undo.payslips?.length) {
    let payslips = [...(next.payslips ?? [])];
    for (const { key, before, index } of [...undo.payslips].reverse()) {
      payslips = payslips.filter((entry) => payslipKey(entry) !== key);
      if (before) payslips = restoreAt(payslips, before, index);
    }
    next.payslips = payslips;
  }
  if (undo.payrollForecasts !== undefined) {
    if (undo.payrollForecasts === null) delete next.payrollForecasts; else next.payrollForecasts = undo.payrollForecasts;
  }
  if (undo.payrollBudget !== undefined) {
    if (undo.payrollBudget === null) delete next.payrollBudget; else next.payrollBudget = undo.payrollBudget;
  }
  if (undo.seasonalTheme !== undefined) {
    if (undo.seasonalTheme === null) delete next.seasonalTheme; else next.seasonalTheme = undo.seasonalTheme;
  }
  next = { ...next, assistantChanges: (next.assistantChanges ?? []).map((entry) => entry.id === logId ? { ...entry, undoneAt: now } : entry) };
  return next;
}
