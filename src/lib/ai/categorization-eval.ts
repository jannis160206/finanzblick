import { createAccountMerchantResolver, createHistoryResolver } from "@/lib/automation/aliases";
import { normalizeMerchantText, type MerchantIndex } from "@/lib/automation/merchants";
import { enrichTransaction, retainLockedAssignments } from "@/lib/automation/pipeline";
import { actualBookings, classify } from "@/lib/calc";
import { canonicalCategory, type Category } from "@/lib/categories";
import {
  activeMerchantRules,
  merchantAliasSourceKey,
  merchantRuleKey,
  misfiledShopTransfer,
  storedMerchantKey,
} from "@/lib/import/merchant-rules";
import { statementFingerprint } from "@/lib/import/identity";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "@/lib/import/review";
import { hasCategoryChoice } from "@/lib/manual-category";
import { refreshPlanning } from "@/lib/planning";
import { appStateSchema, transactionSchema, type AppState, type Transaction } from "@/lib/types";
import { assignAfterImport, webContextFor } from "./auto-assign";
import type { AiCategorization } from "./categorize";
import { decideReviewWithEvidence } from "./evidence";
import { aiCategoryExamples, aiReviewCandidates, type AiBookingInput, type AiExample } from "./review-candidates";

export const CATEGORIZATION_EVAL_VERSION = 1 as const;

// confirmed: a person chose the category; rule: a person's merchant rule says so;
// ai: an earlier AI review decided it; accepted: automatic and never questioned.
export type LabelStrength = "confirmed" | "rule" | "ai" | "accepted";
export const LABEL_STRENGTHS: readonly LabelStrength[] = ["confirmed", "rule", "ai", "accepted"];
export const STRONG_LABELS: ReadonlySet<LabelStrength> = new Set<LabelStrength>(["confirmed", "rule"]);

export interface EvalLabel {
  category: Category;
  strength: LabelStrength;
}

export type LabelOverrides = Readonly<Record<string, Category | "exclude">>;

export type DecisionMethod =
  | "transfer"
  | "rule"
  | "history"
  | "merchant"
  | "purpose"
  | "mcc"
  | "source"
  | "review-auto"
  | "model"
  | "classify";

export type OutcomeStatus = "decided" | "open" | "missing";

export interface EvalOutcome {
  id: string;
  month: string;
  status: OutcomeStatus;
  predicted?: Category;
  method?: DecisionMethod;
  /** Why the booking still waits for a person. */
  reason?: string;
  /** The local model's own answer for a booking the rules left open, before the evidence gate. */
  modelAnswer?: Category | "Prüfen";
  modelConfidence?: number;
}

export interface EvalRecord extends EvalOutcome {
  label: Category;
  strength: LabelStrength;
  bank: string;
  sign: "in" | "out";
  transfer: boolean;
  /** Inside a holiday range the user entered: the app shows unknown spending there as Urlaub. */
  holiday: boolean;
  /**
   * Whether the replay could know the truth: the user decided this booking itself, or the rule behind
   * the label came from a decision in an earlier month. A rule learned later and spread back is not.
   */
  knownAtImport: boolean;
  /** The user's first decision about this merchant: nothing in the ledger said so before. */
  firstDecision: boolean;
  correct: boolean;
}

/** Why a sure label was missed, for the report. */
export type ErrorCause = "later-rule" | "first-decision" | "other";
export const errorCause = (record: Pick<EvalRecord, "knownAtImport" | "firstDecision">): ErrorCause =>
  !record.knownAtImport ? "later-rule" : record.firstDecision ? "first-decision" : "other";

export interface Tally {
  total: number;
  decided: number;
  correct: number;
  wrong: number;
  open: number;
  missing: number;
  /** Correct automatic decisions among decided rows. */
  precision: number | null;
  /** Decided rows among evaluated (not missing) rows. */
  coverage: number | null;
  /** Correct automatic decisions among evaluated rows; an open review is not correct. */
  accuracy: number | null;
}

export interface CategorizationSummary {
  version: typeof CATEGORIZATION_EVAL_VERSION;
  records: number;
  /** Scored separately: whether a shop counts as "home" there depends on later visits. */
  holiday: Tally;
  /** Sure labels the replay could know: the user's own choices and rules learned in an earlier month. */
  strongKnown: Tally;
  /** Sure labels decided wrongly, by cause. */
  causes: Record<ErrorCause, number>;
  strong: Tally;
  strongWithoutTransfers: Tally;
  all: Tally;
  byStrength: Record<LabelStrength, Tally>;
  byLabel: Record<string, Tally>;
  byPredicted: Record<string, Tally>;
  byMethod: Record<string, Tally>;
  byBank: Record<string, Tally>;
  bySign: Record<string, Tally>;
  byMonth: Record<string, Tally>;
  confusion: { label: Category; predicted: Category; count: number; strong: number }[];
  /** The model's raw answers on open bookings, before the evidence gate decides. */
  model: { asked: number; abstained: number; answered: number; correct: number; precision: number | null };
}

const TRANSFER_CATEGORIES: ReadonlySet<Category> = new Set<Category>(["Transfer", "Transfer intern"]);

/** Every booking once: ledger rows win over the copy inside a fixed-cost receipt. */
export function evaluationBookings(state: Pick<AppState, "transactions" | "fixedReceipts">): Transaction[] {
  const byId = new Map<string, Transaction>();
  for (const receipt of state.fixedReceipts ?? []) if (receipt.booking) byId.set(receipt.booking.id, receipt.booking);
  for (const row of state.transactions) byId.set(row.id, row);
  return [...byId.values()];
}

/**
 * Bookings as the app shows them (holiday ranges, shared trips, fixed-cost receipts), keyed by
 * the booking's own id: a receipt row is listed under its receipt key otherwise.
 */
export function displayedBookings(state: AppState): Map<string, Transaction> {
  const receiptIds = new Map((state.fixedReceipts ?? []).flatMap((item) =>
    item.booking ? [[item.key, item.booking.id] as const] : []));
  const ledger = new Set(state.transactions.map((row) => row.id));
  const rows = new Map<string, Transaction>();
  for (const row of actualBookings(state)) {
    const id = ledger.has(row.id) ? row.id : receiptIds.get(row.id);
    if (id) rows.set(id, row);
  }
  return rows;
}

/** Only what a statement parser delivers; any assignment field would leak the label. */
export function importSource(row: Transaction): Transaction {
  return transactionSchema.parse({
    id: row.id,
    date: row.date,
    time: row.time,
    bank: row.bank,
    pocket: row.pocket,
    description: row.rawDescription?.trim() ? row.rawDescription : row.description,
    rawDescription: row.rawDescription,
    rawDetails: row.rawDetails,
    amexSource: row.amexSource,
    amexStatus: row.amexStatus,
    amexCapturedAt: row.amexCapturedAt,
    amexPeriodStart: row.amexPeriodStart,
    amexScreenshotKeys: row.amexScreenshotKeys,
    bankReference: row.bankReference,
    sourceCategory: row.sourceCategory,
    amount: row.amount,
    occurrence: row.occurrence,
    category: "Prüfen",
    includeInPlan: true,
  });
}

function sourceKeys(row: Transaction): string[] {
  const source = { ...row, merchantAlias: undefined };
  return [merchantAliasSourceKey(source), merchantRuleKey(source)].filter(
    (key): key is string => key !== undefined,
  );
}

function openReviewIds(state: AppState): Set<string> {
  const ids = new Set<string>();
  for (const item of state.reviewQueue ?? []) {
    if (item.kind === "booking") ids.add(item.draft.id);
    else for (const row of item.change.bookings) ids.add(row.id);
  }
  return ids;
}

export function evaluationLabels(state: AppState): Map<string, EvalLabel> {
  const open = openReviewIds(state);
  const rules = new Map<string, Category>();
  for (const rule of activeMerchantRules(state))
    if (!rule.identityOnly) rules.set(storedMerchantKey(rule.key), canonicalCategory(rule.category));
  const labels = new Map<string, EvalLabel>();
  const displayed = displayedBookings(state);
  for (const row of evaluationBookings(state)) {
    // A shop purchase that a rule learned from a pocket-transfer note turned into a transfer has no trustworthy label.
    if (row.ignored || open.has(row.id) || misfiledShopTransfer(row)) continue;
    const category = classify(displayed.get(row.id) ?? row).category;
    if (category === "Prüfen") continue;
    const strength: LabelStrength | undefined = row.aiAssigned
      ? "ai"
      : hasCategoryChoice(row)
        ? "confirmed"
        : sourceKeys(row).some((key) => rules.get(key) === category)
          ? "rule"
          : row.requires_manual_review === true
            ? undefined
            : "accepted";
    if (strength) labels.set(row.id, { category, strength });
  }
  return labels;
}

/** Manual corrections win: a category counts as the user's own choice, "exclude" drops the booking. */
export function applyLabelOverrides(labels: ReadonlyMap<string, EvalLabel>, overrides: LabelOverrides): Map<string, EvalLabel> {
  const result = new Map(labels);
  for (const [id, override] of Object.entries(overrides)) {
    if (override === "exclude") result.delete(id);
    else result.set(id, { category: canonicalCategory(override), strength: "confirmed" });
  }
  return result;
}

/**
 * The ledger as it stood before a month's statement arrived; open reviews were settled.
 * A merchant rule only exists once the user chose a category or name for a booking with its key,
 * so a rule learned later and spread back to older bookings does not leak into the past.
 */
export function trainingState(state: AppState, before: string, { currentRules = false } = {}): AppState {
  // Today's preferences also know the user's own decisions from this month and the later ones.
  const decidedSince = (row: Transaction) => currentRules && !row.aiAssigned && hasCategoryChoice(row);
  const transactions = state.transactions.filter((row) => row.date < before || decidedSince(row));
  const fixedReceipts = state.fixedReceipts?.filter(
    (item) => item.date < before && (!item.booking || item.booking.date < before),
  );
  const keys = new Set(evaluationBookings({ transactions, fixedReceipts })
    .filter((row) => !row.aiAssigned && (hasCategoryChoice(row) || row.merchantNameConfirmed === true))
    .flatMap(sourceKeys));
  return {
    ...state,
    transactions,
    ...(fixedReceipts ? { fixedReceipts } : {}),
    ...(state.merchantRules && !currentRules
      ? { merchantRules: state.merchantRules.filter((rule) => keys.has(storedMerchantKey(rule.key))) }
      : {}),
    reviewQueue: [],
    ...(state.aiSuggestions ? { aiSuggestions: [] } : {}),
    ...(state.importResults ? { importResults: [] } : {}),
  };
}

export function evaluationMonths(rows: readonly Pick<Transaction, "date">[]): string[] {
  return [...new Set(rows.map((row) => row.date.slice(0, 7)))].sort();
}

function nextMonth(month: string): string {
  const [year, value] = month.split("-").map(Number);
  return value === 12 ? `${year + 1}-01-01` : `${year}-${String(value + 1).padStart(2, "0")}-01`;
}

function methodOf(row: Transaction, isTransfer: boolean): DecisionMethod {
  if (row.aiAssigned) return "review-auto";
  if (isTransfer) return "transfer";
  if (row.automaticCategoryEvidence) return row.automaticCategoryEvidence.method;
  if (row.merchantMatch === "rule") return "rule";
  return "classify";
}

export interface MonthSimulation {
  outcomes: EvalOutcome[];
  enriched: Map<string, Transaction>;
  /** After the review queue was built, before the rule-based AI review ran. */
  reviewed: AppState;
  state: AppState;
}

export interface SimulationOptions {
  enrich?: typeof enrichTransaction;
  /**
   * Replay with today's merchant rules and the user's own decisions from other months instead of only
   * what was known before the month: checks that the household's current preference wins where it
   * changed after these bookings arrived.
   */
  currentRules?: boolean;
}

/** Replays one month exactly like the statement worker: enrich, import, review queue, rule-based AI review. */
export function simulateMonth(
  state: AppState,
  month: string,
  index: MerchantIndex,
  options: SimulationOptions = {},
): MonthSimulation {
  const start = `${month}-01`;
  const end = nextMonth(month);
  const known = trainingState(state, start, { currentRules: options.currentRules });
  const sources = evaluationBookings(state)
    .filter((row) => row.date >= start && row.date < end)
    .map(importSource);
  if (!sources.length) return { outcomes: [], enriched: new Map(), reviewed: known, state: known };
  const enrich = options.enrich ?? enrichTransaction;
  const resolveAccount = createAccountMerchantResolver(known);
  const resolveHistory = createHistoryResolver(known);
  const rows = sources.map((row) => enrich(row, index, resolveAccount, resolveHistory));
  const uploadId = `00000000-0000-4000-8000-${month.replace("-", "").padStart(12, "0")}`;
  const prepared = prepareStatementImport(
    [{ source: null, file: `categorization-eval-${month}.csv`, rows, skipped: 0, issues: [], uploadId }],
    known,
  );
  const committed = commitStatementImport(known, prepared.automatic, [], prepared.metadata);
  const reviewed = appStateSchema.parse(
    retainLockedAssignments(known, refreshPlanning(queueLedgerReview(committed.state))),
  );
  const next = assignAfterImport(reviewed, [uploadId]);
  const open = new Map<string, { suggestion: Category; reason: string }>();
  for (const item of next.reviewQueue ?? []) {
    if (item.kind === "booking") {
      const parsed = transactionSchema.safeParse(item.draft);
      open.set(item.draft.id, {
        suggestion: parsed.success ? classify(parsed.data).category : "Prüfen",
        reason: item.message,
      });
    } else
      for (const row of item.change.bookings)
        open.set(row.id, { suggestion: classify(row).category, reason: "Fixkosten bestätigen" });
  }
  const ledger = displayedBookings(next);
  // The same bank booking stored twice (ledger row and fixed-cost receipt) is merged on import;
  // the surviving copy's result counts for both.
  const survivors = new Map(evaluationBookings(next).map((row) => [statementFingerprint(row), row.id]));
  const outcomes = sources.map((source): EvalOutcome => {
    const pendingId = open.has(source.id) ? source.id : survivors.get(statementFingerprint(source));
    const id = source.id;
    const pending = pendingId ? open.get(pendingId) : undefined;
    if (pending)
      return {
        id, month, status: "open", reason: pending.reason,
        ...(pending.suggestion !== "Prüfen" ? { predicted: pending.suggestion } : {}),
      };
    const row = ledger.get(id) ?? ledger.get(survivors.get(statementFingerprint(source)) ?? "");
    if (!row) return { id, month, status: "missing" };
    const result = classify(row);
    if (result.category === "Prüfen") return { id, month, status: "open", reason: "Kategorie offen" };
    return { id, month, status: "decided", predicted: result.category, method: methodOf(row, result.isTransfer) };
  });
  return { outcomes, enriched: new Map(rows.map((row) => [row.id, row])), reviewed, state: next };
}

export function joinOutcomes(
  state: AppState,
  labels: ReadonlyMap<string, EvalLabel>,
  outcomes: readonly EvalOutcome[],
): EvalRecord[] {
  const rows = new Map(evaluationBookings(state).map((row) => [row.id, row]));
  const ranges = state.holidayRanges ?? [];
  const decided = new Map<string, string>();
  for (const row of rows.values()) {
    if (row.aiAssigned || !(hasCategoryChoice(row) || row.merchantNameConfirmed === true)) continue;
    for (const key of sourceKeys(row)) {
      const month = decided.get(key);
      if (!month || row.date.slice(0, 7) < month) decided.set(key, row.date.slice(0, 7));
    }
  }
  const decidedBefore = (row: Transaction, month: string) =>
    sourceKeys(row).some((key) => (decided.get(key) ?? month) < month);
  return outcomes.flatMap((outcome): EvalRecord[] => {
    const label = labels.get(outcome.id);
    const row = rows.get(outcome.id);
    if (!label || !row) return [];
    return [{
      ...outcome,
      label: label.category,
      strength: label.strength,
      bank: row.bank,
      sign: row.amount < 0 ? "out" : "in",
      transfer: TRANSFER_CATEGORIES.has(label.category),
      holiday: ranges.some((range) => row.date >= range.from && row.date <= range.to),
      knownAtImport: label.strength !== "rule" || decidedBefore(row, outcome.month),
      firstDecision: label.strength === "confirmed" && !decidedBefore(row, outcome.month),
      correct: outcome.status === "decided" && outcome.predicted === label.category,
    }];
  });
}

const ratio = (part: number, whole: number) => (whole ? part / whole : null);

export function tally(records: readonly EvalRecord[]): Tally {
  let decided = 0, correct = 0, open = 0, missing = 0;
  for (const record of records) {
    if (record.status === "decided") decided++;
    else if (record.status === "open") open++;
    else missing++;
    if (record.correct) correct++;
  }
  const evaluated = records.length - missing;
  return {
    total: records.length,
    decided,
    correct,
    wrong: decided - correct,
    open,
    missing,
    precision: ratio(correct, decided),
    coverage: ratio(decided, evaluated),
    accuracy: ratio(correct, evaluated),
  };
}

function groupBy(records: readonly EvalRecord[], key: (record: EvalRecord) => string | undefined) {
  const groups = new Map<string, EvalRecord[]>();
  for (const record of records) {
    const value = key(record);
    if (value === undefined) continue;
    const group = groups.get(value) ?? [];
    group.push(record);
    groups.set(value, group);
  }
  return Object.fromEntries(
    [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([value, group]) => [value, tally(group)]),
  );
}

export function summarizeCategorization(all: readonly EvalRecord[]): CategorizationSummary {
  const records = all.filter((record) => !record.holiday);
  const strong = records.filter((record) => STRONG_LABELS.has(record.strength));
  const confusion = new Map<string, { label: Category; predicted: Category; count: number; strong: number }>();
  for (const record of records) {
    if (record.status !== "decided" || record.correct || !record.predicted) continue;
    const key = `${record.label}→${record.predicted}`;
    const entry = confusion.get(key) ?? { label: record.label, predicted: record.predicted, count: 0, strong: 0 };
    entry.count++;
    if (STRONG_LABELS.has(record.strength)) entry.strong++;
    confusion.set(key, entry);
  }
  return {
    version: CATEGORIZATION_EVAL_VERSION,
    records: records.length,
    holiday: tally(all.filter((record) => record.holiday)),
    strongKnown: tally(strong.filter((record) => record.knownAtImport)),
    causes: strong.reduce<Record<ErrorCause, number>>((causes, record) => {
      if (record.status === "decided" && !record.correct) causes[errorCause(record)]++;
      return causes;
    }, { "later-rule": 0, "first-decision": 0, other: 0 }),
    strong: tally(strong),
    strongWithoutTransfers: tally(strong.filter((record) => !record.transfer)),
    all: tally(records),
    byStrength: Object.fromEntries(
      LABEL_STRENGTHS.map((strength) => [strength, tally(records.filter((record) => record.strength === strength))]),
    ) as Record<LabelStrength, Tally>,
    byLabel: groupBy(records, (record) => record.label),
    byPredicted: groupBy(records, (record) => (record.status === "decided" ? record.predicted : undefined)),
    byMethod: groupBy(records, (record) => record.method),
    byBank: groupBy(records, (record) => record.bank),
    bySign: groupBy(records, (record) => record.sign),
    byMonth: groupBy(records, (record) => record.month),
    confusion: [...confusion.values()].sort((left, right) => right.count - left.count || right.strong - left.strong),
    model: modelTally(records),
  };
}

function modelTally(records: readonly EvalRecord[]): CategorizationSummary["model"] {
  const asked = records.filter((record) => record.modelAnswer !== undefined);
  const answered = asked.filter((record) => record.modelAnswer !== "Prüfen");
  const correct = answered.filter((record) => record.modelAnswer === record.label).length;
  return {
    asked: asked.length, abstained: asked.length - answered.length, answered: answered.length, correct,
    precision: ratio(correct, answered.length),
  };
}

export type AskModel = (bookings: AiBookingInput[], examples: AiExample[]) => Promise<AiCategorization[]>;

/**
 * The AI review the app runs on bookings the rules left open: batches of eight, and the model's
 * answer only counts when the household's history, a bank rule or the shop's industry backs it.
 */
export async function reviewWithModel(
  simulation: Pick<MonthSimulation, "state" | "outcomes">,
  ask: AskModel,
  batchSize = 8,
): Promise<EvalOutcome[]> {
  const { state } = simulation;
  const candidates = aiReviewCandidates(state, new Set(), 100_000);
  const reviewed = new Map<string, Pick<EvalOutcome, "modelAnswer" | "modelConfidence" | "predicted">>();
  for (let offset = 0; offset < candidates.length; offset += batchSize) {
    const batch = candidates.slice(offset, offset + batchSize);
    const inputs = batch.map((candidate) => candidate.input);
    const answers = await ask(inputs, aiCategoryExamples(state, undefined, inputs)).catch(() => []);
    for (const candidate of batch) {
      const item = state.reviewQueue?.find((entry) => entry.id === candidate.reviewId);
      if (item?.kind !== "booking") continue;
      const answer = answers.find((entry) => entry.ref === candidate.input.ref);
      const decision = decideReviewWithEvidence(state, candidate.reviewId, candidate.input, answer,
        webContextFor(state, candidate.reviewId));
      reviewed.set(item.draft.id, {
        ...(answer ? { modelAnswer: answer.category, modelConfidence: answer.confidence } : {}),
        ...(decision.accepted ? { predicted: decision.category } : {}),
      });
    }
  }
  return simulation.outcomes.map((outcome): EvalOutcome => {
    const review = reviewed.get(outcome.id);
    if (outcome.status !== "open" || !review) return outcome;
    const { predicted, ...answer } = review;
    return predicted
      ? { ...outcome, ...answer, status: "decided", predicted, method: "model", reason: undefined }
      : { ...outcome, ...answer };
  });
}

export interface CategorizationComparison {
  /** Correct before, now wrong. */
  regressions: string[];
  /** Correct before, now left open for review. */
  lostCoverage: string[];
  /** Not correct before, now correct. */
  fixes: string[];
  /** Open before, now decided wrongly. */
  newErrors: string[];
  /** Decided wrong before, now decided differently but still wrong, or open. */
  otherChanges: string[];
}

type Comparable = Pick<EvalRecord, "id" | "status" | "predicted" | "correct">;

export function compareCategorization(before: readonly Comparable[], after: readonly Comparable[]): CategorizationComparison {
  const previous = new Map(before.map((record) => [record.id, record]));
  const result: CategorizationComparison = { regressions: [], lostCoverage: [], fixes: [], newErrors: [], otherChanges: [] };
  for (const record of after) {
    const old = previous.get(record.id);
    if (!old || (old.status === record.status && old.predicted === record.predicted)) continue;
    if (old.correct && !record.correct) (record.status === "decided" ? result.regressions : result.lostCoverage).push(record.id);
    else if (!old.correct && record.correct) result.fixes.push(record.id);
    else if (old.status !== "decided" && record.status === "decided") result.newErrors.push(record.id);
    else result.otherChanges.push(record.id);
  }
  return result;
}

/** A descriptor that groups bookings of one shop without amounts, dates or references. */
export function bookingDescriptor(row: Pick<Transaction, "description" | "rawDescription">): string {
  return normalizeMerchantText(row.rawDescription?.trim() ? row.rawDescription : row.description) || row.description;
}
