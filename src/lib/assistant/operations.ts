import { classify } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { pocketKey, preserveGoalOpeningBalances, savingsGoals } from "@/lib/goals";
import { assignTransactions } from "@/lib/transaction-tools";
import {
  assistantMemorySchema, MAX_ASSISTANT_CHANGES, MAX_ASSISTANT_MEMORY, plannedOneOffSchema, savingsGoalSchema,
  type AppState, type AssistantChangeLog, type AssistantOperation, type AssistantUndo, type PlannedOneOff, type SavingsGoal,
} from "@/lib/types";

export type Diff = { label: string; before: string; after: string };
export type AppliedChange = { state: AppState; diffs: Diff[]; undo: AssistantUndo };

const settingLabels = { emergencyTarget: "Notgroschen-Ziel", vacationTarget: "Urlaubs-Ziel", savingsTarget: "Sparkonto-Ziel" } as const;
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
  if (!undo.settings.some((entry) => entry.key === key)) undo.settings.push({ key, before: state.settings[key] });
}

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
      const candidate: PlannedOneOff = { ...item, name: operation.name ?? item.name, date: operation.date ?? item.date, amount, installments };
      delete candidate.total;
      if (installments > 1 && Math.round(amount * installments * 100) !== Math.round(total * 100)) candidate.total = total;
      if (candidate.date.slice(0, 7) < context.asOf.slice(0, 7)) throw new OperationError("Der neue Termin liegt in der Vergangenheit.");
      const parsed = plannedOneOffSchema.safeParse(candidate);
      if (!parsed.success) throw new OperationError("Die neuen Werte für die geplante Ausgabe sind ungültig.");
      const before = plannedText(item);
      const after = plannedText(parsed.data);
      if (before === after && candidate.name === item.name) throw new OperationError(`An „${item.name}“ würde sich nichts ändern.`);
      if (candidate.name !== item.name) diffs.push({ label: `${item.name}: Name`, before: item.name, after: candidate.name });
      if (before !== after) diffs.push({ label: candidate.name, before, after });
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
      undo.transactions ??= [];
      const known = new Set(undo.transactions.map((entry) => entry.id));
      for (const row of rows) if (!known.has(row.id)) undo.transactions.push({
        id: row.id, category: row.category, includeInPlan: row.includeInPlan,
        ...(row.categoryOverride !== undefined ? { categoryOverride: row.categoryOverride } : {}),
        ...(row.manualCategory !== undefined ? { manualCategory: row.manualCategory } : {}),
        ...(row.reviewed !== undefined ? { reviewed: row.reviewed } : {}),
        ...(row.aiAssigned !== undefined ? { aiAssigned: row.aiAssigned } : {}),
        ...(row.fixedCost !== undefined ? { fixedCost: row.fixedCost } : {}),
      });
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
    case "setting": {
      snapshotSetting(undo, state, operation.key);
      const before = state.settings[operation.key];
      if (before === operation.value) throw new OperationError(`${settingLabels[operation.key]} ist schon ${currency(before)}.`);
      diffs.push({ label: settingLabels[operation.key], before: currency(before), after: currency(operation.value) });
      return { ...state, settings: { ...state.settings, [operation.key]: operation.value } };
    }
    case "memory_add": {
      const memory = state.assistantMemory ?? [];
      const replaced = operation.key === "note" ? undefined : memory.find((entry) => entry.key === operation.key);
      undo.memory ??= [];
      if (replaced) undo.memory.push({ id: replaced.id, before: replaced });
      const entry = assistantMemorySchema.parse({ id: context.id(), text: operation.text, key: operation.key,
        ...(operation.value !== undefined ? { value: operation.value } : {}), at: context.now });
      undo.memory.push({ id: entry.id, before: null });
      if (!replaced && memory.length >= MAX_ASSISTANT_MEMORY) throw new OperationError(`Ich kann mir höchstens ${MAX_ASSISTANT_MEMORY} Dinge merken. Lösch zuerst etwas.`);
      diffs.push({ label: "Gedächtnis", before: replaced?.text ?? none, after: entry.text });
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
    for (const { key, before } of undo.settings) Object.assign(settings, { [key]: before });
    next.settings = settings;
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
      for (const key of ["categoryOverride", "manualCategory", "reviewed", "aiAssigned", "fixedCost"] as const) delete restored[key];
      return { ...restored, ...before };
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
  next = { ...next, assistantChanges: (next.assistantChanges ?? []).map((entry) => entry.id === logId ? { ...entry, undoneAt: now } : entry) };
  return next;
}
