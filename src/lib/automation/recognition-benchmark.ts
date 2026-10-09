import { classify } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { mergeConfirmedMerchantChoices } from "@/lib/import/merchant-choice";
import {
  isSpecificMerchantKey,
  merchantAliasSourceKey,
  merchantRuleKey,
} from "@/lib/import/merchant-rules";
import { hasCategoryChoice } from "@/lib/manual-category";
import { isMerchantTransfer } from "@/lib/merchant-transfer";
import {
  transactionSchema,
  type AppState,
  type Transaction,
} from "@/lib/types";
import { createAccountMerchantResolver } from "./aliases";
import { MerchantIndex, normalizeMerchantText } from "./merchants";
import { enrichTransaction } from "./pipeline";

export const RECOGNITION_BENCHMARK_VERSION = 2 as const;

export interface BenchmarkRate {
  successes: number;
  samples: number;
  rate: number | null;
  /** Two-sided 95% Wilson interval; no samples means no estimate. */
  lower95: number | null;
  upper95: number | null;
}

export interface RecognitionMetrics {
  eligible: number;
  sourceDescriptorGroups: number;
  automatic: number;
  abstained: number;
  merchantRecognized: number;
  merchantUnresolved: number;
  merchantUnresolvedReasons: { missingAlias: number; untrustedAlias: number };
  reviewRequested: number;
  unlabeledAutomatic: number;
  labels: { merchant: number; category: number; joint: number };
  automaticCoverage: BenchmarkRate;
  /** High-confidence names / eligible rows, regardless of category review. */
  merchantRecognitionCoverage: BenchmarkRate;
  merchantPrecision: BenchmarkRate;
  categoryPrecision: BenchmarkRate;
  jointPrecision: BenchmarkRate;
  /** Correct automatic decisions / all jointly labeled rows, including abstentions. */
  jointCorrectness: BenchmarkRate;
  labeledAutomaticCoverage: BenchmarkRate;
  /** A group succeeds only if every jointly labeled row is automatically correct. */
  descriptorGroupCorrectness: BenchmarkRate;
  target99:
    "insufficient-evidence" | "below-target" | "supported-on-labeled-holdout";
}

export interface RecognitionBenchmarkResult {
  version: typeof RECOGNITION_BENCHMARK_VERSION;
  methodology: "source-only-human-labels-date-and-descriptor-holdout";
  trainingPolicy: {
    learnIdentityOnly: boolean | "mixed" | "not-evaluated";
  };
  inventory: {
    copies: number;
    logicalTransactions: number;
    duplicateCopies: number;
    conflictingLabels: number;
    conflictingSources: number;
    excludedTransfers: number;
    excludedIncomeOrCredits: number;
    eligible: number;
    merchantLabels: number;
    categoryLabels: number;
    jointLabels: number;
    unlabeled: number;
    unconfirmedAutomaticIdentities: number;
  };
  split: {
    training: number;
    trainingLabeled: number;
    learnedRules: number;
    conflictingTrainingRules: number;
    holdout: number;
    temporalAvailable: boolean;
    descriptorGroupTraining: number;
    descriptorGroupHoldout: number;
  };
  temporal: RecognitionMetrics;
  /** Natural future descriptors not present anywhere in chronological training. */
  temporalUnseenDescriptors: RecognitionMetrics;
  /** Every occurrence of a selected descriptor is held out, including earlier ones. */
  descriptorGroupHoldout: RecognitionMetrics;
}

export interface RecognitionBenchmarkOptions {
  holdoutFraction?: number;
  /** False reproduces a product that cannot learn from name-only human labels. */
  learnIdentityOnly?: boolean;
  /** Injectable for comparing an unchanged labeled snapshot against another pipeline. */
  enrich?: typeof enrichTransaction;
}

interface Sample {
  source: Transaction;
  descriptor: string;
  ruleKey: string;
  merchant?: string;
  category?: Transaction["category"];
}

const identityKey = (value: string) =>
  value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("de-AT")
    .replace(/\s+/g, " ");

export function benchmarkRate(
  successes: number,
  samples: number,
): BenchmarkRate {
  if (
    !Number.isSafeInteger(samples) ||
    !Number.isSafeInteger(successes) ||
    successes < 0 ||
    samples < successes
  )
    throw new Error("Invalid benchmark counts.");
  if (!samples)
    return { successes, samples, rate: null, lower95: null, upper95: null };
  const z = 1.959963984540054;
  const rate = successes / samples;
  const denominator = 1 + (z * z) / samples;
  const center = (rate + (z * z) / (2 * samples)) / denominator;
  const margin =
    (z *
      Math.sqrt(
        (rate * (1 - rate)) / samples + (z * z) / (4 * samples * samples),
      )) /
    denominator;
  return {
    successes,
    samples,
    rate,
    lower95: successes === 0 ? 0 : Math.max(0, center - margin),
    upper95: successes === samples ? 1 : Math.min(1, center + margin),
  };
}

/** A whitelist prevents present or future assignment fields from leaking labels. */
export function recognitionBenchmarkSource(row: Transaction): Transaction {
  return transactionSchema.parse({
    id: row.id,
    date: row.date,
    time: row.time,
    bank: row.bank,
    pocket: row.pocket,
    description: row.rawDescription?.trim()
      ? row.rawDescription
      : row.description,
    rawDescription: row.rawDescription,
    rawDetails: row.rawDetails ? [...row.rawDetails] : undefined,
    bankReference: row.bankReference,
    sourceCategory: row.sourceCategory,
    amexSource: row.amexSource,
    amexStatus: row.amexStatus,
    amount: row.amount,
    category: "Prüfen",
    includeInPlan: true,
  });
}

function labels(row: Transaction) {
  // A reviewed category does not establish that an inherited automatic identity
  // was manually chosen. Explicit name confirmation and bare legacy aliases do.
  const merchant =
    row.merchantAlias &&
    (row.merchantNameConfirmed === true ||
      (row.merchantNameConfirmed === undefined &&
        !row.merchantId &&
        !row.merchantMatch)) &&
    isSpecificMerchantKey(`source|${row.merchantAlias}`)
      ? identityKey(row.merchantAlias)
      : undefined;
  const category =
    hasCategoryChoice(row) && row.category !== "Prüfen"
      ? row.category
      : undefined;
  return { merchant, category };
}

function ruleKey(source: Transaction): string {
  return merchantAliasSourceKey(source) ?? merchantRuleKey(source);
}

function descriptorKey(source: Transaction): string {
  // Branch/reference/date variants are not independent evidence. Rule learning
  // still uses the more specific source key, rather than this broader grouping.
  const normalized = normalizeMerchantText(source.description);
  return normalized
    ? `${identityKey(source.bank)}|${normalized}`
    : ruleKey(source);
}

function sourceSignature(row: Transaction): string {
  const source = recognitionBenchmarkSource(row);
  return JSON.stringify([
    source.date,
    source.time,
    source.bank,
    source.pocket,
    source.amount,
    source.description,
    source.rawDescription,
    source.rawDetails,
    source.sourceCategory,
  ]);
}

function collect(state: AppState) {
  const rows = [
    ...state.transactions,
    ...(state.fixedReceipts ?? []).flatMap((receipt) =>
      receipt.booking ? [receipt.booking] : [],
    ),
  ];
  const byId = new Map<string, Transaction[]>();
  for (const row of rows) {
    const group = byId.get(row.id) ?? [];
    group.push(row);
    byId.set(row.id, group);
  }
  const inventory: RecognitionBenchmarkResult["inventory"] = {
    copies: rows.length,
    logicalTransactions: byId.size,
    duplicateCopies: rows.length - byId.size,
    conflictingLabels: 0,
    conflictingSources: 0,
    excludedTransfers: 0,
    excludedIncomeOrCredits: 0,
    eligible: 0,
    merchantLabels: 0,
    categoryLabels: 0,
    jointLabels: 0,
    unlabeled: 0,
    unconfirmedAutomaticIdentities: 0,
  };
  const samples: Sample[] = [];
  for (const copies of byId.values()) {
    const confirmed = copies.map(labels);
    const merchants = new Set(
      confirmed.flatMap((label) => (label.merchant ? [label.merchant] : [])),
    );
    const categories = new Set(
      confirmed.flatMap((label) => (label.category ? [label.category] : [])),
    );
    const conflictingLabels = merchants.size > 1 || categories.size > 1;
    const conflictingSources = new Set(copies.map(sourceSignature)).size > 1;
    if (conflictingLabels) inventory.conflictingLabels++;
    if (conflictingSources) inventory.conflictingSources++;
    if (conflictingLabels || conflictingSources) continue;
    const source = recognitionBenchmarkSource(copies[0]);
    const category = categories.values().next().value;
    const merchant = merchants.values().next().value;
    if (
      isMerchantTransfer(source) ||
      category === "Transfer" ||
      category === "Transfer intern"
    ) {
      inventory.excludedTransfers++;
      continue;
    }
    const refund =
      category === "Rückerstattungen" ||
      /\b(?:r[üu]ckerstattung|erstattung|refund|retoure|gutschrift)\b/i.test(
        [
          source.description,
          source.rawDescription,
          ...(source.rawDetails ?? []),
        ].join(" "),
      );
    if (
      (category && isIncomeCategory(category)) ||
      (isIncomeCategory(classify(source).category) &&
        category !== "Rückerstattungen") ||
      (source.amount > 0 && !refund)
    ) {
      inventory.excludedIncomeOrCredits++;
      continue;
    }
    if (merchant) inventory.merchantLabels++;
    if (category) inventory.categoryLabels++;
    if (merchant && category) inventory.jointLabels++;
    if (!merchant && !category) inventory.unlabeled++;
    if (
      !merchant &&
      copies.some((row) => !!(row.merchantId || row.merchantMatch))
    )
      inventory.unconfirmedAutomaticIdentities++;
    samples.push({
      source,
      descriptor: descriptorKey(source),
      ruleKey: ruleKey(source),
      merchant,
      category,
    });
  }
  inventory.eligible = samples.length;
  samples.sort(
    (a, b) =>
      a.source.date.localeCompare(b.source.date) ||
      (a.source.time ?? "").localeCompare(b.source.time ?? "") ||
      a.source.id.localeCompare(b.source.id),
  );
  return { inventory, samples };
}

function trainingResolver(
  state: AppState,
  samples: Sample[],
  learnIdentityOnly: boolean,
) {
  type Rule = NonNullable<AppState["merchantRules"]>[number];
  const rules = new Map<string, Rule | null>();
  for (const sample of samples) {
    // A confirmed name alone teaches only identity. Refund labels must not teach
    // a refund category for the next ordinary outgoing purchase.
    if (
      (!sample.category && (!learnIdentityOnly || !sample.merchant)) ||
      sample.source.amount > 0
    )
      continue;
    const key = sample.ruleKey;
    if (!isSpecificMerchantKey(key)) continue;
    const rule: Rule = {
      key,
      category: sample.category ?? "Prüfen",
      ...(sample.merchant ? { merchantAlias: sample.merchant } : {}),
      ...(!sample.category ? { identityOnly: true } : {}),
    };
    const previous = rules.get(key);
    if (previous === null) continue;
    rules.set(key, mergeConfirmedMerchantChoices(previous, rule));
  }
  const learned = [...rules.values()].filter(
    (rule): rule is Rule => rule !== null,
  );
  const conflictingKeys = new Set(
    [...rules].filter(([, rule]) => !rule).map(([key]) => key),
  );
  // No original rules/history/receipts are passed to the resolver.
  const resolver = createAccountMerchantResolver({
    ...state,
    transactions: [],
    fixedReceipts: [],
    reviewQueue: [],
    merchantRules: [
      ...learned,
      ...[...conflictingKeys].map((key) => ({
        key,
        category: "Prüfen" as const,
      })),
    ],
  });
  return {
    learnedRules: learned.length,
    conflictingTrainingRules: conflictingKeys.size,
    resolve: (
      source: Transaction,
    ): ReturnType<ReturnType<typeof createAccountMerchantResolver>> =>
      conflictingKeys.has(ruleKey(source))
        ? { kind: "conflict" }
        : resolver(source),
  };
}

function target99(
  metrics: Omit<RecognitionMetrics, "target99">,
): RecognitionMetrics["target99"] {
  const evidence = [
    metrics.automaticCoverage,
    metrics.merchantPrecision,
    metrics.categoryPrecision,
    metrics.jointPrecision,
    metrics.jointCorrectness,
    metrics.descriptorGroupCorrectness,
  ];
  // Even perfect independent outcomes need 381 samples for a 99% Wilson lower
  // bound. Do not turn a tiny, biased labeled subset into a target verdict.
  if (evidence.some((rate) => rate.samples < 381))
    return "insufficient-evidence";
  if (evidence.some((rate) => rate.rate !== null && rate.rate < 0.99))
    return "below-target";
  return evidence.every((rate) => rate.lower95 !== null && rate.lower95 >= 0.99)
    ? "supported-on-labeled-holdout"
    : "insufficient-evidence";
}

function evaluate(
  samples: Sample[],
  index: MerchantIndex,
  resolve: ReturnType<typeof createAccountMerchantResolver>,
  enrich: typeof enrichTransaction,
): RecognitionMetrics {
  let automatic = 0,
    merchantRecognized = 0,
    reviewRequested = 0,
    unlabeledAutomatic = 0;
  const merchantUnresolvedReasons = { missingAlias: 0, untrustedAlias: 0 };
  let merchantLabels = 0,
    categoryLabels = 0,
    jointLabels = 0;
  let merchantAttempts = 0,
    categoryAttempts = 0,
    jointAttempts = 0;
  let merchantCorrect = 0,
    categoryCorrect = 0,
    jointCorrect = 0;
  const descriptors = new Set<string>();
  const labeledGroups = new Map<string, boolean>();
  for (const sample of samples) {
    descriptors.add(sample.descriptor);
    const result = enrich(
      recognitionBenchmarkSource(sample.source),
      index,
      resolve,
    );
    const safe = result.requires_manual_review === false;
    const complete =
      safe && !!result.merchantAlias && result.category !== "Prüfen";
    const merchantAssigned =
      !!result.merchantAlias &&
      (result.merchantMatch === "alias" ||
        result.merchantMatch === "rule" ||
        complete);
    const categoryAssigned = complete;
    if (merchantAssigned) merchantRecognized++;
    else if (!result.merchantAlias) merchantUnresolvedReasons.missingAlias++;
    else merchantUnresolvedReasons.untrustedAlias++;
    if (complete) automatic++;
    if (result.requires_manual_review === true) reviewRequested++;
    if (complete && !(sample.merchant && sample.category)) unlabeledAutomatic++;
    const merchantRight =
      merchantAssigned &&
      identityKey(result.merchantAlias!) === sample.merchant;
    const categoryRight =
      categoryAssigned && result.category === sample.category;
    if (sample.merchant) {
      merchantLabels++;
      if (merchantAssigned) merchantAttempts++;
      if (merchantRight) merchantCorrect++;
    }
    if (sample.category) {
      categoryLabels++;
      if (categoryAssigned) categoryAttempts++;
      if (categoryRight) categoryCorrect++;
    }
    if (sample.merchant && sample.category) {
      jointLabels++;
      if (complete) jointAttempts++;
      const right = !!(complete && merchantRight && categoryRight);
      if (right) jointCorrect++;
      labeledGroups.set(
        sample.descriptor,
        (labeledGroups.get(sample.descriptor) ?? true) && right,
      );
    }
  }
  const metrics: Omit<RecognitionMetrics, "target99"> = {
    eligible: samples.length,
    sourceDescriptorGroups: descriptors.size,
    automatic,
    abstained: samples.length - automatic,
    merchantRecognized,
    merchantUnresolved: samples.length - merchantRecognized,
    merchantUnresolvedReasons,
    reviewRequested,
    unlabeledAutomatic,
    labels: {
      merchant: merchantLabels,
      category: categoryLabels,
      joint: jointLabels,
    },
    automaticCoverage: benchmarkRate(automatic, samples.length),
    merchantRecognitionCoverage: benchmarkRate(
      merchantRecognized,
      samples.length,
    ),
    merchantPrecision: benchmarkRate(merchantCorrect, merchantAttempts),
    categoryPrecision: benchmarkRate(categoryCorrect, categoryAttempts),
    jointPrecision: benchmarkRate(jointCorrect, jointAttempts),
    jointCorrectness: benchmarkRate(jointCorrect, jointLabels),
    labeledAutomaticCoverage: benchmarkRate(jointAttempts, jointLabels),
    descriptorGroupCorrectness: benchmarkRate(
      [...labeledGroups.values()].filter(Boolean).length,
      labeledGroups.size,
    ),
  };
  return { ...metrics, target99: target99(metrics) };
}

export function evaluateRecognitionBenchmark(
  state: AppState,
  index: MerchantIndex,
  options: RecognitionBenchmarkOptions = {},
): RecognitionBenchmarkResult {
  const fraction = options.holdoutFraction ?? 0.3;
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1)
    throw new Error("Holdout fraction must be between zero and one.");
  const enrich = options.enrich ?? enrichTransaction;
  const learnIdentityOnly = options.learnIdentityOnly ?? true;
  const { inventory, samples } = collect(state);
  // Keep an entire date together: future labels never train an earlier/same-day row.
  const days = [...new Set(samples.map((sample) => sample.source.date))];
  const trainingDays = Math.min(
    days.length - 1,
    Math.floor(days.length * (1 - fraction)),
  );
  const cutoff = days[Math.max(0, trainingDays)];
  const training =
    trainingDays > 0
      ? samples.filter((sample) => sample.source.date < cutoff)
      : [];
  const holdout = samples.filter(
    (sample) => !trainingDays || sample.source.date >= cutoff,
  );
  const trained = trainingResolver(state, training, learnIdentityOnly);
  const trainingDescriptors = new Set(
    training.map((sample) => sample.descriptor),
  );
  const unseen = holdout.filter(
    (sample) => !trainingDescriptors.has(sample.descriptor),
  );
  // Select groups by first observation, not labels, while retaining all copies of
  // that source descriptor in exactly one partition.
  const groups = [...new Set(samples.map((sample) => sample.descriptor))];
  const groupTrainingCount = Math.max(
    0,
    Math.min(groups.length - 1, Math.floor(groups.length * (1 - fraction))),
  );
  const heldOutGroups = new Set(groups.slice(groupTrainingCount));
  const groupTraining = samples.filter(
    (sample) => !heldOutGroups.has(sample.descriptor),
  );
  const groupHoldout = samples.filter((sample) =>
    heldOutGroups.has(sample.descriptor),
  );
  return {
    version: RECOGNITION_BENCHMARK_VERSION,
    methodology: "source-only-human-labels-date-and-descriptor-holdout",
    trainingPolicy: { learnIdentityOnly },
    inventory,
    split: {
      training: training.length,
      trainingLabeled: training.filter(
        (sample) => sample.merchant || sample.category,
      ).length,
      learnedRules: trained.learnedRules,
      conflictingTrainingRules: trained.conflictingTrainingRules,
      holdout: holdout.length,
      temporalAvailable: training.length > 0 && holdout.length > 0,
      descriptorGroupTraining: groupTraining.length,
      descriptorGroupHoldout: groupHoldout.length,
    },
    temporal: evaluate(holdout, index, trained.resolve, enrich),
    temporalUnseenDescriptors: evaluate(unseen, index, trained.resolve, enrich),
    descriptorGroupHoldout: evaluate(
      groupHoldout,
      index,
      trainingResolver(state, groupTraining, learnIdentityOnly).resolve,
      enrich,
    ),
  };
}

function mergeMetrics(items: RecognitionMetrics[]): RecognitionMetrics {
  const sum = (value: (item: RecognitionMetrics) => number) =>
    items.reduce((total, item) => total + value(item), 0);
  const rate = (
    field: keyof Pick<
      RecognitionMetrics,
      | "automaticCoverage"
      | "merchantRecognitionCoverage"
      | "merchantPrecision"
      | "categoryPrecision"
      | "jointPrecision"
      | "jointCorrectness"
      | "labeledAutomaticCoverage"
      | "descriptorGroupCorrectness"
    >,
  ) =>
    benchmarkRate(
      sum((item) => item[field].successes),
      sum((item) => item[field].samples),
    );
  const result: Omit<RecognitionMetrics, "target99"> = {
    eligible: sum((item) => item.eligible),
    sourceDescriptorGroups: sum((item) => item.sourceDescriptorGroups),
    automatic: sum((item) => item.automatic),
    abstained: sum((item) => item.abstained),
    merchantRecognized: sum((item) => item.merchantRecognized),
    merchantUnresolved: sum((item) => item.merchantUnresolved),
    merchantUnresolvedReasons: {
      missingAlias: sum((item) => item.merchantUnresolvedReasons.missingAlias),
      untrustedAlias: sum((item) => item.merchantUnresolvedReasons.untrustedAlias),
    },
    reviewRequested: sum((item) => item.reviewRequested),
    unlabeledAutomatic: sum((item) => item.unlabeledAutomatic),
    labels: {
      merchant: sum((item) => item.labels.merchant),
      category: sum((item) => item.labels.category),
      joint: sum((item) => item.labels.joint),
    },
    automaticCoverage: rate("automaticCoverage"),
    merchantRecognitionCoverage: rate("merchantRecognitionCoverage"),
    merchantPrecision: rate("merchantPrecision"),
    categoryPrecision: rate("categoryPrecision"),
    jointPrecision: rate("jointPrecision"),
    jointCorrectness: rate("jointCorrectness"),
    labeledAutomaticCoverage: rate("labeledAutomaticCoverage"),
    descriptorGroupCorrectness: rate("descriptorGroupCorrectness"),
  };
  return {
    ...result,
    // Aggregate counts are useful diagnostics, but account-local groups may
    // repeat across tenants and cannot establish independent pooled evidence.
    target99:
      items.filter((item) => item.eligible > 0).length > 1
        ? "insufficient-evidence"
        : target99(result),
  };
}

/** Aggregates counts, never averages percentages; groups remain account-local. */
export function aggregateRecognitionBenchmarks(
  results: RecognitionBenchmarkResult[],
): RecognitionBenchmarkResult {
  const inventory = {} as RecognitionBenchmarkResult["inventory"];
  const inventoryKeys: (keyof typeof inventory)[] = [
    "copies",
    "logicalTransactions",
    "duplicateCopies",
    "conflictingLabels",
    "conflictingSources",
    "excludedTransfers",
    "excludedIncomeOrCredits",
    "eligible",
    "merchantLabels",
    "categoryLabels",
    "jointLabels",
    "unlabeled",
    "unconfirmedAutomaticIdentities",
  ];
  for (const key of inventoryKeys)
    inventory[key] = results.reduce(
      (total, result) => total + result.inventory[key],
      0,
    );
  const split = {
    training: 0,
    trainingLabeled: 0,
    learnedRules: 0,
    conflictingTrainingRules: 0,
    holdout: 0,
    temporalAvailable: false,
    descriptorGroupTraining: 0,
    descriptorGroupHoldout: 0,
  };
  for (const result of results) {
    split.temporalAvailable ||= result.split.temporalAvailable;
    for (const key of [
      "training",
      "trainingLabeled",
      "learnedRules",
      "conflictingTrainingRules",
      "holdout",
      "descriptorGroupTraining",
      "descriptorGroupHoldout",
    ] as const)
      split[key] += result.split[key];
  }
  return {
    version: RECOGNITION_BENCHMARK_VERSION,
    methodology: "source-only-human-labels-date-and-descriptor-holdout",
    trainingPolicy: {
      learnIdentityOnly: !results.length
        ? "not-evaluated"
        : results.every(
              (result) =>
                result.trainingPolicy.learnIdentityOnly ===
                results[0].trainingPolicy.learnIdentityOnly,
            )
          ? results[0].trainingPolicy.learnIdentityOnly
          : "mixed",
    },
    inventory,
    split,
    temporal: mergeMetrics(results.map((result) => result.temporal)),
    temporalUnseenDescriptors: mergeMetrics(
      results.map((result) => result.temporalUnseenDescriptors),
    ),
    descriptorGroupHoldout: mergeMetrics(
      results.map((result) => result.descriptorGroupHoldout),
    ),
  };
}
