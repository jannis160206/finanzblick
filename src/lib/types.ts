import { z } from "zod";
import { normalizeAccount } from "@/lib/accounts";
import { isAmexScreenshot, normalizeStatementKey } from "@/lib/import/identity";
import { seasonalModes, seasonalThemes } from "@/lib/seasonal-theme";
import { payslipKey, payslipSchema, payrollEmployerKey, payrollForecastSchema } from "@/lib/payslip-schema";
import { allCategories, categories, canonicalCategory, type Category } from "@/lib/categories";
import { sharedSettlementFields } from "@/lib/shared-refund-schema";
import { importResultSchema, MAX_IMPORT_RESULTS } from "@/lib/import/result-schema";
export { categories, type Category } from "@/lib/categories";

z.config(z.locales.de());

export const pocketNames = [
  "Notgroschen",
  "Urlaub",
  "Sparkonto",
  "Motorrad",
] as const;
export type Pocket = (typeof pocketNames)[number];
export const categorySchema = z.enum(allCategories).transform(canonicalCategory);
export const durableCategories: readonly Category[] = [
  "Leasing",
  "Vollkasko",
  "Haftpflicht",
  "Handyvertrag",
  "Apple Care",
  "Versicherungen",
  "Telefon & Internet",
];
export const fixedCategories: readonly Category[] = [
  "Gehalt",
  "Rufbereitschaft",
  "Leasing",
  "Vollkasko",
  "Haftpflicht",
  "Handyvertrag",
  "Apple Care",
  "Barber",
  "PayPal Abo",
  "Einkommen",
  "AMEX Monatsgebühr",
  "Spotify",
  "Abonnements",
  "Versicherungen",
  "Telefon & Internet",
  "Bankgebühren",
  "Körperpflege",
  "Miete",
  "Energie & Nebenkosten",
];
export const variableCategories = categories.filter(
  (category) =>
    !fixedCategories.includes(category) &&
    category !== "Transfer" &&
    category !== "Transfer intern" &&
    category !== "Prüfen",
);
export const moneySchema = z
  .number()
  .finite()
  .min(-1_000_000_000)
  .max(1_000_000_000);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum erforderlich")
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  }, "Ungültiges Datum");
export const pocketAmountsSchema = z.object({
  Notgroschen: moneySchema,
  Urlaub: moneySchema,
  Sparkonto: moneySchema,
  Motorrad: moneySchema,
});
export type PocketAmounts = z.infer<typeof pocketAmountsSchema>;
export const holidayRangeSchema = z.object({ from: dateSchema, to: dateSchema }).refine(
  ({ from, to }) => to >= from && (Date.parse(to) - Date.parse(from)) / 86_400_000 < 25,
  "Urlaub: Von–bis mit höchstens 25 Tagen erforderlich.",
);
export type HolidayRange = z.infer<typeof holidayRangeSchema>;
export const plannedOneOffSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1, "Name erforderlich").max(100),
  date: dateSchema,
  amount: moneySchema.positive("Betrag muss größer als null sein").multipleOf(0.01),
  pocket: z.enum(["Giro", "Sparkonto"]).default("Giro"),
  installments: z.number().int().min(1).max(120).default(1),
  total: moneySchema.positive().multipleOf(0.01).optional(),
  sharedWithRaphael: z.boolean().optional(),
  paidOccurrences: z.array(dateSchema).max(120).optional(),
}).refine((item) => item.total === undefined || item.total > item.amount * (item.installments - 1),
  "Gesamtbetrag muss nach den regulären Raten einen positiven Rest ergeben.");
export type PlannedOneOff = z.infer<typeof plannedOneOffSchema>;
const transactionFieldsSchema = z.object({
  id: z.string().min(1).refine((id) => id.trim().length > 0, "Umsatz-ID darf nicht leer sein."),
  date: dateSchema,
  time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/).optional(),
  bank: z.string().trim().min(1, "Bank erforderlich").max(100),
  pocket: z.string().trim().min(1).max(100).nullable(),
  description: z.string().trim().min(1, "Beschreibung erforderlich").max(1000),
  rawDescription: z.string().max(1000).optional(),
  rawDetails: z.array(z.string().max(1000)).max(20).optional(),
  amexSource: z.enum(["screenshot", "pdf"]).optional(),
  amexStatus: z.enum(["pending", "posted"]).optional(),
  amexCapturedAt: dateSchema.optional(),
  amexPeriodStart: dateSchema.optional(),
  amexScreenshotKeys: z.array(z.string().min(1).max(2000)).max(20).optional(),
  merchantAlias: z.string().trim().min(1).max(200).optional(),
  merchantId: z.string().max(100).optional(),
  merchantLogo: z.boolean().optional(),
  merchantMatch: z.enum(["alias", "rule"]).optional(),
  merchantNameConfirmed: z.boolean().optional(),
  is_locked: z.boolean().optional(),
  requires_manual_review: z.boolean().optional(),
  automaticCategoryEvidence: z.object({
    method: z.enum(["merchant", "purpose", "mcc", "history", "source"]),
    category: categorySchema,
    mcc: z.string().regex(/^\d{4}$/).optional(),
    budgetExcluded: z.boolean().optional(),
  }).strict().optional(),
  category: categorySchema.catch("Prüfen"),
  amount: moneySchema.refine(
    (value) => value !== 0,
    "Betrag darf nicht 0 sein",
  ),
  includeInPlan: z.boolean(),
  afterBaseline: z.boolean().optional(),
  categoryOverride: z.boolean().optional(),
  manualCategory: z.boolean().optional(),
  // Settled by the local NPU model instead of a person; kept for transparency.
  aiAssigned: z.boolean().optional(),
  // Explicit acknowledgement of this booking, never inherited from a merchant rule.
  reviewed: z.boolean().optional(),
  // Only this booking: omission keeps legacy category-based accounting.
  fixedCost: z.boolean().optional(),
  sourceCategory: z.string().max(200).optional(),
  bankReference: z.string().max(500).optional(),
  occurrence: z.number().int().positive().optional(),
  sharedWithRaphael: z.boolean().optional(),
  sharedPaidManually: z.boolean().optional(),
  // Excluded from every statistic, budget, insight and agent answer; balances and import dedup still see it.
  ignored: z.boolean().optional(),
  // Free labels across categories, e.g. a trip ("Malaga 2026").
  tags: z.array(z.string().trim().min(1).max(40)).max(10)
    .transform((tags) => [...new Set(tags)]).optional(),
  // Receipt split (Kassenbon): category parts that must sum to `amount`; see lib/splits.ts.
  splits: z.array(z.object({
    category: categorySchema,
    amount: moneySchema.refine((value) => value !== 0, "Betrag darf nicht 0 sein"),
    note: z.string().trim().max(120).optional(),
  }).strict()).min(2).max(20).optional(),
  ...sharedSettlementFields,
});
export const transactionSchema =  transactionFieldsSchema.overwrite(normalizeAccount);
export type Transaction = z.infer<typeof transactionSchema>;
export const statementRepairDraftSchema = transactionFieldsSchema.extend({
  amount: moneySchema.nullable(),
  date: dateSchema.or(z.literal("")),
  description: z.string().trim().max(1000),
}).overwrite(normalizeAccount);
export const pocketSnapshotSchema = z.object({
  pocket: z.enum(pocketNames),
  bank: z.literal("Revolut"),
  date: dateSchema,
  balance: moneySchema,
});
export type PocketSnapshot = z.infer<typeof pocketSnapshotSchema>;
export const merchantRuleSchema = z.object({
  key: z.string().min(1).max(1200),
  category: categorySchema,
  fixedCost: z.boolean().optional(),
  merchantAlias: transactionFieldsSchema.shape.merchantAlias,
  identityOnly: z.boolean().optional(),
}).refine(rule => !rule.identityOnly ||
  (!!rule.merchantAlias && rule.category === "Prüfen" && rule.fixedCost === undefined),
  "Eine reine Namensregel darf keine Kategorie oder Fixkosten setzen.");
export const merchantNameRuleSchema = z.object({
  key: z.string().min(1).max(1200),
  merchantAlias: transactionFieldsSchema.shape.merchantAlias.unwrap(),
});
export const fixedReceiptSchema = z.object({
  key: z.string().max(2000).overwrite(normalizeStatementKey),
  merchantKey: z.string().max(1200).optional(),
  date: dateSchema,
  category: categorySchema,
  rowId: z.string().optional(),
  amount: moneySchema,
  booking: transactionSchema.optional(),
});
export type FixedReceipt = z.infer<typeof fixedReceiptSchema>;
export const accountSnapshotSchema = z.object({
  bank: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  date: dateSchema,
  balance: moneySchema,
});
export const amexBalanceSnapshotSchema = z.object({
  periodStart: dateSchema,
  date: dateSchema,
  balance: moneySchema,
  pendingBalance: moneySchema.optional(),
}).refine((snapshot) => snapshot.periodStart <= snapshot.date, "Amex-Zeitraum beginnt nach dem Saldo-Datum");
export const trBalanceSchema = z.object({
  date: dateSchema,
  balance: moneySchema.nonnegative(),
});
export const fixedChangeSchema = z.object({
  id: z.string(),
  category: categorySchema,
  month: z.string(),
  previous: moneySchema,
  amount: moneySchema,
  rowId: z.string().optional(),
  bookings: z.array(transactionSchema),
});
export const reviewItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("booking"),
    id: z.string(),
    draft: statementRepairDraftSchema,
    message: z.string(),
    importIssues: z.array(z.string()).optional(),
    sourceRepair: z.boolean().optional(),
    importUploadId: z.string().uuid().optional(),
  }).refine(
    (item) => item.sourceRepair === true || isAmexScreenshot(item.draft) || (!!item.draft.date && !!item.draft.description),
    "Datum und Beschreibung erforderlich.",
  ),
  z.object({
    kind: z.literal("fixed"),
    id: z.string(),
    change: fixedChangeSchema,
    importUploadId: z.string().uuid().optional(),
    importUploadIds: z.record(z.string().min(1), z.string().uuid()).refine(
      (sources) => Object.keys(sources).length <= 100_000,
      "Zu viele Herkunftszuordnungen in der Fixkostenprüfung.",
    ).optional(),
  }).refine((item) => {
    const bookingIds = new Set(item.change.bookings.map((row) => row.id));
    return Object.keys(item.importUploadIds ?? {}).every((id) => bookingIds.has(id));
  }, "Die Herkunftszuordnung muss zu einer Buchung dieser Fixkostenprüfung gehören."),
]);
export type ReviewItem = z.infer<typeof reviewItemSchema>;
export type FixedChange = z.infer<typeof fixedChangeSchema>;
const financeValuesSchema = z.record(
  z.string().regex(/^202[6-8]-(0[1-9]|1[0-2])$/),
  moneySchema.nonnegative().nullable(),
);
// Variable budget lines (see variable-budgets.ts); the user's own adjustment is added to each line's default from now on.
export const budgetLineIds = ["food", "lunch", "fuel", "leisure", "going-out", "gifts", "buffer"] as const;
export const budgetLineIdSchema = z.enum(budgetLineIds);
export const budgetAdjustmentsSchema = z.partialRecord(budgetLineIdSchema, z.number().min(-100_000).max(100_000));
export type BudgetAdjustments = z.infer<typeof budgetAdjustmentsSchema>;
export const financeRowSchema = z.object({
  id: z.string().min(1).refine((id) => id.trim().length > 0, "Finanzzeilen-ID darf nicht leer sein."),
  label: z.string().trim().min(1).max(100),
  kind: z.enum(["income", "fixed", "variable"]),
  planCategory: categorySchema.optional(),
  overrides: z
    .record(
      z.string().regex(/^202[6-8]-(0[1-9]|1[0-2])$/),
      moneySchema.nonnegative().nullable(),
    )
    .optional(),
  values: financeValuesSchema,
  fixedSource: z.object({
    key: z.string(),
    bookingIds: z.array(z.string()),
    merchantKeys: z.array(z.string()),
    pocket: z.string().nullable(),
    appliedLabel: z.string().max(100).optional(),
    labelOverride: z.string().max(100).optional(),
    applied: financeValuesSchema,
    overrides: financeValuesSchema.optional(),
    originalValues: financeValuesSchema.optional(),
  }).optional(),
});
export type FinanceRow = z.infer<typeof financeRowSchema>;
export const monthInputSchema = z.object({
  openingBalances: pocketAmountsSchema.optional(),
  variableOverride: moneySchema.nonnegative().nullable(),
  bikeOverride: moneySchema.nonnegative().nullable(),
  pocketIn: pocketAmountsSchema.refine((values) =>
    Object.values(values).every((value) => value >= 0),
  ),
  pocketOut: pocketAmountsSchema.refine((values) =>
    Object.values(values).every((value) => value >= 0),
  ),
});
export type MonthInput = z.infer<typeof monthInputSchema>;
export const settingsSchema = z
  .object({
    asOf: dateSchema.refine(
      (value) => value >= "2026-01-01" && value <= "2027-12-31",
      "Stichtag muss in 2026 oder 2027 liegen",
    ),
    baselineDate: dateSchema.refine(
      (value) => value >= "2026-01-01" && value <= "2027-12-31",
      "Ist-Datum muss in 2026 oder 2027 liegen",
    ),
    balances: pocketAmountsSchema.refine(
      (values) => Object.values(values).every((n) => n >= 0),
      "Startstände müssen positiv sein",
    ),
    unknownBalances: z.array(z.enum(pocketNames)).max(pocketNames.length).refine(
      (pockets) => new Set(pockets).size === pockets.length,
      "Unbekannte Startstände müssen eindeutig sein.",
    ).optional(),
    emergencyTarget: moneySchema.nonnegative(),
    vacationTarget: moneySchema.nonnegative(),
    savingsTarget: moneySchema.nonnegative(),
    bikeTarget: moneySchema.nonnegative(),
    bikePurchaseDate: dateSchema,
    allocationStart: dateSchema,
    bikeShare: z.number().min(0).max(1),
    afterBikeSavingsShare: z.number().min(0).max(1),
    oldRate: z.number().min(0).max(1),
    newRate: z.number().min(0).max(1),
    rateChangeDate: dateSchema,
    taxRate: z.number().min(0).max(1),
    interestStart: dateSchema,
    interestRates: z
      .array(z.object({ date: dateSchema, rate: z.number().min(0).max(1) }))
      .optional(),
    // Savings goal "as fast as possible": share of each month's free surplus that stays on the Girokonto (default 15 %).
    asapReserve: z.number().min(0).max(0.5).optional(),
    // Share of the positive monthly surplus that always goes to the Sparkonto, at least the savings floor (default 10 %).
    savingsRate: z.number().min(0).max(0.5).optional(),
    // Amount kept on an account (pocket name, never the Girokonto); only the rest may fund a savings goal once.
    accountKeep: z.record(z.string().trim().min(1).max(100), moneySchema.nonnegative())
      .refine((keeps) => Object.keys(keeps).length <= 20, "Höchstens 20 Behalten-Beträge.")
      .refine((keeps) => Object.keys(keeps).every((key) => !/^giro(?:konto)?$/i.test(key.trim())),
        "Für das Girokonto gibt es keinen Behalten-Betrag.")
      .optional(),
    // Payslip import: look up unclear terms (only the term itself) on Wikipedia when the local glossary is not enough. Off by default.
    payslipTermLookup: z.boolean().optional(),
    // Successbonus with the December payslip (paid out in January) in percent of the Grundgehalt; 0 turns it off. Default 138,5 %.
    successBonusPercent: z.number().min(0).max(500).optional(),
  })
  .refine((value) => value.asOf >= value.baselineDate, {
    message: "Stichtag darf nicht vor dem Ist-Datum liegen",
    path: ["asOf"],
  });
export type Settings = z.infer<typeof settingsSchema>;
const goalMonthSchema = z.string().regex(/^202[6-8]-(0[1-9]|1[0-2])$/);
export const goalPlanRowSchema = z.object({
  month: goalMonthSchema,
  account: z.string().trim().min(1).max(100),
  amount: moneySchema.nonnegative(),
  locked: z.boolean().optional(),
}).strict();
export type GoalPlanRow = z.infer<typeof goalPlanRowSchema>;
export const savingsGoalSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1, "Name erforderlich").max(80),
  pocket: z.string().trim().min(1).max(100),
  target: moneySchema.positive("Betrag muss größer als null sein"),
  date: dateSchema,
  completedAt: dateSchema.optional(),
  openingBalance: z.object({
    date: dateSchema,
    amount: moneySchema.nonnegative(),
    includedTransactionIds: z.array(z.string()).max(100_000).optional(),
  }).optional(),
  funding: z.object({
    monthly: moneySchema.nonnegative(),
    extras: z.record(goalMonthSchema, moneySchema.nonnegative()),
    // Months without the regular rate (extras still count), e.g. set via the finance assistant.
    paused: z.array(goalMonthSchema).max(24).optional(),
    // Distribution from the goal dialog: "Giro" rows come from the monthly surplus, other rows are transfers from a pocket.
    plan: z.array(goalPlanRowSchema).max(240).optional(),
    // Months the plan decides; outside of it the monthly rate applies.
    window: z.object({ from: goalMonthSchema, to: goalMonthSchema }).strict().optional(),
    excluded: z.object({
      months: z.array(goalMonthSchema).max(36).optional(),
      accounts: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    }).strict().optional(),
    auto: z.boolean().optional(),
    // Accounts used for this goal despite their account rule (e.g. the Trade Republic Notgroschen), with the minimum kept there.
    exceptions: z.array(z.object({ account: z.string().trim().min(1).max(100), keep: moneySchema.nonnegative().optional() }).strict()).max(5).optional(),
  }).optional(),
  // "As soon as possible": the date is the month the plan reaches the target.
  asap: z.boolean().optional(),
  // Start capital moved over from another account when the goal was set up.
  start: z.object({ amount: moneySchema.positive(), account: z.string().trim().min(1).max(100), date: dateSchema }).strict().optional(),
});
export type SavingsGoal = z.infer<typeof savingsGoalSchema>;
export const pocketOpeningBalanceSchema = savingsGoalSchema.shape.openingBalance.unwrap().extend({
  pocket: z.string().trim().min(1).max(100),
  ignoreEmptySnapshot: z.boolean().optional(),
});
export type PocketOpeningBalance = z.infer<typeof pocketOpeningBalanceSchema>;
export const seasonalPreferenceSchema = z.object({
  // Legacy choices remain readable, but no longer control the calendar.
  mode: z.enum(seasonalModes).optional(),
  theme: z.enum(seasonalThemes).optional(),
  reduceMotion: z.boolean().optional(),
  accentColor: z
    .string()
    .regex(/^#[\da-f]{6}$/i, "Gültige Akzentfarbe erforderlich")
    .optional(),
});
const annualSixthMoney = moneySchema.nonnegative().multipleOf(0.01);
export const annualSixthSchema = z.object({
  year: z.union([z.literal(2026), z.literal(2027)]),
  month: z.number().int().min(1).max(12),
  employer: z.string().trim().max(120),
  regularGross: annualSixthMoney,
  specialGross: annualSixthMoney,
  plannedSpecialGross: annualSixthMoney,
  reportedSixth: annualSixthMoney.optional(),
  monthlyPayroll: z.boolean(),
}).refine((value) => value.monthlyPayroll || value.reportedSixth !== undefined, {
  message: "Ohne bestätigte monatliche Standardabrechnung bitte das Jahressechstel laut Lohnabrechnung angeben.",
  path: ["reportedSixth"],
}).refine((value) => value.regularGross > 0 ||
  (value.specialGross === 0 && value.plannedSpecialGross === 0) || value.reportedSixth !== undefined, {
  message: "Bei Sonderzahlungen vor dem ersten laufenden Bezug ist das Jahressechstel aus der Lohnverrechnung erforderlich.",
  path: ["reportedSixth"],
});
export type AnnualSixth = z.infer<typeof annualSixthSchema>;
// Finance assistant: the model only extracts these fields; every amount shown is calculated in code.
export const assistantDraftSchema = z.object({
  action: z.enum(["savings_goal", "expense", "affordability"]),
  name: z.string().trim().min(1).max(80).optional(),
  amount: moneySchema.positive().max(10_000_000).optional(),
  date: dateSchema.optional(),
  monthly: moneySchema.positive().max(1_000_000).optional(),
  startCapital: moneySchema.nonnegative().max(10_000_000).optional(),
  fromAccount: z.string().trim().min(1).max(60).optional(),
  installments: z.number().int().min(1).max(120).optional(),
  shared: z.boolean().optional(),
  whatIf: z.boolean().optional(),
  // "Die ersten 2 Monate je 60 € vom Sparkonto": extra start payments on top of the monthly rate.
  extra: z.object({
    amount: moneySchema.positive().max(1_000_000),
    months: z.number().int().min(1).max(24),
    from: z.enum([...pocketNames, "Giro"]).optional(),
  }).strict().optional(),
}).strict();
export type AssistantDraft = z.infer<typeof assistantDraftSchema>;
const monthKeySchema = z.string().regex(/^20\d\d-(0[1-9]|1[0-2])$/);
const agentIdSchema = z.string().min(1).max(100);
export const extraSourceSchema = z.enum([...pocketNames, "Giro"]);
export type ExtraSource = z.infer<typeof extraSourceSchema>;
// Allowlisted agent operations: the assistant can only propose these, the user applies them with a click.
export const assistantOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("goal_update"), goalId: agentIdSchema,
    name: z.string().trim().min(1).max(80).optional(),
    target: moneySchema.positive().max(10_000_000).optional(),
    date: dateSchema.optional(),
    monthly: moneySchema.nonnegative().max(1_000_000).optional(),
  }).strict(),
  z.object({ op: z.literal("goal_pause"), goalId: agentIdSchema, month: monthKeySchema, resume: z.boolean().optional() }).strict(),
  // Extra payments for N months; a pocket source is booked as withdrawal from that pocket. Amount 0 removes them.
  z.object({
    op: z.literal("goal_extras"), goalId: agentIdSchema, start: monthKeySchema,
    months: z.number().int().min(1).max(24), amount: moneySchema.nonnegative().max(1_000_000),
    from: extraSourceSchema.optional(),
  }).strict(),
  z.object({ op: z.literal("goal_complete"), goalId: agentIdSchema }).strict(),
  z.object({ op: z.literal("goal_delete"), goalId: agentIdSchema }).strict(),
  z.object({
    op: z.literal("planned_update"), plannedId: agentIdSchema,
    name: z.string().trim().min(1).max(100).optional(),
    date: dateSchema.optional(),
    total: moneySchema.positive().max(10_000_000).optional(),
    installments: z.number().int().min(1).max(120).optional(),
    pocket: z.enum(["Giro", "Sparkonto"]).optional(),
    shared: z.boolean().optional(),
  }).strict(),
  z.object({ op: z.literal("planned_delete"), plannedId: agentIdSchema }).strict(),
  // Edits on existing bookings: display name, plan inclusion, fixed-cost flag, reviewed mark.
  z.object({
    op: z.literal("transaction_update"), ids: z.array(z.string().min(1).max(500)).min(1).max(2000),
    alias: z.string().trim().min(1).max(200).optional(),
    includeInPlan: z.boolean().optional(),
    fixedCost: z.boolean().optional(),
    reviewed: z.boolean().optional(),
    ignored: z.boolean().optional(),
  }).strict(),
  z.object({
    op: z.literal("categorize"), ids: z.array(z.string().min(1).max(500)).min(1).max(2000),
    category: categorySchema, learn: z.boolean(),
  }).strict(),
  // Open entries of the review list, settled like a click in the review dialog.
  z.object({
    op: z.literal("review_resolve"),
    decisions: z.array(z.object({ reviewId: z.string().min(1).max(500), category: categorySchema, merchantAlias: z.string().trim().min(1).max(100).optional() }).strict()).min(1).max(500),
  }).strict(),
  z.object({
    op: z.literal("setting"), key: z.enum(["emergencyTarget", "vacationTarget", "savingsTarget"]),
    value: moneySchema.nonnegative().max(10_000_000),
  }).strict(),
  z.object({
    op: z.literal("memory_add"), text: z.string().trim().min(1).max(200),
    key: z.enum(["buffer", "salaryDay", "note", "reminder"]), value: z.number().min(0).max(10_000_000).optional(),
    due: dateSchema.optional(),
  }).strict(),
  z.object({ op: z.literal("memory_delete"), memoryId: agentIdSchema }).strict(),
  // New monthly adjustment of a variable budget line (added to its default, 0 = back to default).
  z.object({ op: z.literal("budget_plan"), line: budgetLineIdSchema, adjustment: z.number().min(-100_000).max(100_000) }).strict(),
]);
export type AssistantOperation = z.infer<typeof assistantOperationSchema>;
const assistantLineSchema = z.object({
  label: z.string().max(200),
  value: z.number().finite().optional(),
  detail: z.string().max(300).optional(),
  tone: z.enum(["good", "warn", "bad", "info"]).optional(),
  transactionIds: z.array(z.string().max(500)).max(50).optional(),
}).strict();
// Small chart inside a chat answer; bounded so persisted chats stay small.
export const assistantChartSchema = z.object({
  type: z.enum(["bar", "line"]),
  series: z.array(z.object({
    name: z.string().max(60),
    points: z.array(z.object({ label: z.string().max(20), value: z.number().finite() }).strict()).min(1).max(24),
  }).strict()).min(1).max(3),
  threshold: z.object({ label: z.string().max(60), value: z.number().finite() }).strict().optional(),
}).strict();
export type AssistantChart = z.infer<typeof assistantChartSchema>;
// Inputs for the live what-if card; the browser recomputes the result from these numbers only.
export const assistantWhatIfSchema = z.object({
  goal: z.object({
    id: agentIdSchema, name: z.string().max(80),
    target: z.number().finite().positive().max(10_000_000), saved: z.number().finite().min(0).max(10_000_000),
    date: dateSchema, monthly: z.number().finite().min(0).max(1_000_000).optional(),
  }).strict().optional(),
  start: monthKeySchema,
  rates: z.array(z.number().finite().min(0).max(1_000_000)).max(36),
  tail: z.number().finite().min(0).max(1_000_000),
  extra: z.number().finite().min(0).max(100_000),
  subscriptions: z.array(z.object({ name: z.string().max(80), monthly: z.number().finite().min(0).max(100_000), cancel: z.boolean() }).strict()).max(8),
}).strict();
export type AssistantWhatIf = z.infer<typeof assistantWhatIfSchema>;
// Calculated result cards (answers, briefing, coach, depot, tax); every number comes from code.
export const assistantCardSchema = z.object({
  kind: z.enum(["answer", "briefing", "check", "coach", "depot", "tax", "homeoffice", "homeoffice_result", "rule", "memory", "changes", "loan", "review", "forecast", "whatif", "cancel", "why", "contracts", "insights", "context"]),
  title: z.string().max(200),
  total: z.number().finite().optional(),
  lines: z.array(assistantLineSchema).max(40),
  transactionIds: z.array(z.string().max(500)).max(50).optional(),
  month: monthKeySchema.optional(),
  year: z.number().int().min(2000).max(2100).optional(),
  note: z.string().max(400).optional(),
  chart: assistantChartSchema.optional(),
  whatif: assistantWhatIfSchema.optional(),
  // Kündigungshilfe: ready letter text with placeholders and public comparison/cancellation links.
  letter: z.string().max(3000).optional(),
  links: z.array(z.object({ label: z.string().max(80), url: z.string().url().max(300).regex(/^https:\/\//) }).strict()).max(4).optional(),
  // The page inside the app where the answer can be checked or changed.
  page: z.object({ label: z.string().max(60), href: z.string().max(200).regex(/^\/(?!\/)[\w\-/?=&%.]*$/) }).strict().optional(),
}).strict();
export type AssistantCard = z.infer<typeof assistantCardSchema>;
export const assistantChangeSchema = z.object({
  title: z.string().max(200),
  operations: z.array(assistantOperationSchema).min(1).max(20),
  diffs: z.array(z.object({ label: z.string().max(200), before: z.string().max(200), after: z.string().max(200) }).strict()).max(80),
  logId: agentIdSchema.optional(),
}).strict();
export type AssistantChange = z.infer<typeof assistantChangeSchema>;
export const assistantMessageSchema = z.object({
  id: z.string().min(1).max(100),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(2000),
  at: z.number().nonnegative(),
  draft: assistantDraftSchema.optional(),
  card: assistantCardSchema.optional(),
  change: assistantChangeSchema.optional(),
  // "Mach das rückgängig": the change the user still has to confirm.
  undoId: agentIdSchema.optional(),
  status: z.enum(["question", "preview", "created", "dismissed", "applied", "undone"]).optional(),
  source: z.enum(["KI", "Regel"]).optional(),
  // Quick replies shown under the latest assistant message.
  suggestions: z.array(z.string().trim().min(1).max(120)).max(4).optional(),
  // The agent the orchestrator chose for this answer (same names as `agentIds` in assistant/orchestrator).
  agent: z.enum(["transactions", "contracts", "budget", "payroll", "general"]).optional(),
  // How the orchestrator decided (`RouteVia`) and roughly how long the answer took, for the read-only admin view.
  via: z.enum(["rule", "signal", "model", "fallback"]).optional(),
  ms: z.number().int().nonnegative().max(3_600_000).optional(),
  // Self-learning: which tool answered which question, the user's 👍/👎, and open questions waiting for a correction or a name.
  tool: z.string().max(40).optional(),
  asked: z.string().max(1000).optional(),
  feedback: z.enum(["up", "down"]).optional(),
  correcting: z.string().max(1000).optional(),
  clarify: z.string().max(1000).optional(),
}).strict();
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export const MAX_ASSISTANT_MESSAGES = 100;
export const assistantMemorySchema = z.object({
  id: agentIdSchema,
  text: z.string().trim().min(1).max(200),
  key: z.enum(["buffer", "salaryDay", "note", "reminder"]),
  value: z.number().min(0).max(10_000_000).optional(),
  due: dateSchema.optional(),
  at: z.number().nonnegative(),
}).strict();
export type AssistantMemory = z.infer<typeof assistantMemorySchema>;
export const MAX_ASSISTANT_MEMORY = 50;
// Which account may pay for what: "Sparkonto für alles", "Trade Republic nur für Autowerkstatt", "Notgroschen nie".
export const accountRuleSchema = z.object({
  id: agentIdSchema,
  account: z.string().trim().min(1).max(80),
  use: z.enum(["any", "only", "never"]),
  purposes: z.array(z.string().trim().min(1).max(60)).max(20),
  at: z.number().nonnegative(),
}).strict();
export type AccountRule = z.infer<typeof accountRuleSchema>;
export const MAX_ACCOUNT_RULES = 30;
// General knowledge the assistant looked up on the internet (public encyclopedia text, never personal data).
export const assistantKnowledgeSchema = z.object({
  id: agentIdSchema,
  topic: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(1500),
  url: z.string().url().max(500),
  source: z.string().trim().min(1).max(100),
  at: z.number().nonnegative(),
  uses: z.number().int().nonnegative().optional(),
}).strict();
export type AssistantKnowledge = z.infer<typeof assistantKnowledgeSchema>;
export const MAX_ASSISTANT_KNOWLEDGE = 100;
// What the internet says a shop is (OpenStreetMap shop type, Wikidata, the shop's website); public facts only.
// No category means nothing usable was found; such entries are asked again after a while.
export const webCategorySchema = z.object({
  key: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(100),
  place: z.string().trim().max(60).optional(),
  category: categorySchema.optional(),
  source: z.enum(["OpenStreetMap", "Wikidata", "Webseite"]).optional(),
  kind: z.string().trim().max(80).optional(),
  strong: z.boolean().optional(),
  label: z.string().max(200).optional(),
  at: z.number().nonnegative(),
}).strict();
export type WebCategory = z.infer<typeof webCategorySchema>;
export const MAX_WEB_CATEGORIES = 3000;
// Phrasings only the model understood; next time the rules answer them directly.
export const assistantPhraseSchema = z.object({
  pattern: z.string().trim().min(1).max(200),
  tool: z.string().trim().min(1).max(40),
  at: z.number().nonnegative(),
  hits: z.number().int().nonnegative().optional(),
}).strict();
export type AssistantPhrase = z.infer<typeof assistantPhraseSchema>;
export const MAX_ASSISTANT_PHRASES = 200;
// Own words for own things: "Mit Japan meine ich Motorrad".
export const assistantAliasSchema = z.object({
  from: z.string().trim().min(2).max(60),
  to: z.string().trim().min(1).max(100),
  at: z.number().nonnegative(),
  hits: z.number().int().nonnegative().optional(),
}).strict();
export type AssistantAlias = z.infer<typeof assistantAliasSchema>;
export const MAX_ASSISTANT_ALIASES = 100;
// Requests the assistant could not handle yet; resolved once it learns them.
export const assistantGapSchema = z.object({
  text: z.string().trim().min(1).max(300),
  at: z.number().nonnegative(),
  count: z.number().int().min(1).max(10_000),
  resolved: z.string().max(40).optional(),
}).strict();
export type AssistantGap = z.infer<typeof assistantGapSchema>;
export const MAX_ASSISTANT_GAPS = 50;
const undoTransactionSchema = z.object({
  id: z.string().min(1).max(500),
  category: categorySchema,
  categoryOverride: z.boolean().optional(),
  manualCategory: z.boolean().optional(),
  reviewed: z.boolean().optional(),
  includeInPlan: z.boolean(),
  aiAssigned: z.boolean().optional(),
  fixedCost: z.boolean().optional(),
  // "" means the booking had no alias; undefined (older entries) leaves the alias untouched.
  merchantAlias: z.string().max(200).optional(),
  merchantNameConfirmed: z.boolean().optional(),
  ignored: z.boolean().optional(),
}).strict();
// Snapshot of exactly the entities an agent change touched, so it can be reverted.
export const assistantUndoSchema = z.object({
  goalsUnset: z.boolean().optional(),
  goals: z.array(z.object({ id: agentIdSchema, before: savingsGoalSchema.nullable() }).strict()).max(50).optional(),
  planned: z.array(z.object({ id: agentIdSchema, before: plannedOneOffSchema.nullable() }).strict()).max(500).optional(),
  settings: z.array(z.object({
    key: z.enum(["emergencyTarget", "vacationTarget", "savingsTarget", "bikeTarget", "bikePurchaseDate"]),
    before: z.union([moneySchema, dateSchema]),
  }).strict()).max(5).optional(),
  memory: z.array(z.object({ id: agentIdSchema, before: assistantMemorySchema.nullable() }).strict()).max(50).optional(),
  months: z.array(z.object({ month: z.string().regex(/^202[6-8]-(0[1-9]|1[0-2])$/), before: monthInputSchema.nullable() }).strict()).max(24).optional(),
  transactions: z.array(undoTransactionSchema).max(2000).optional(),
  merchantRules: z.array(z.object({ key: z.string().min(1).max(1200), before: merchantRuleSchema.nullable() }).strict()).max(2000).optional(),
  fixedReceipts: z.array(z.object({ key: z.string().max(2000), before: fixedReceiptSchema }).strict()).max(2000).optional(),
  budget: z.array(z.object({ line: budgetLineIdSchema, before: z.number().min(-100_000).max(100_000).nullable() }).strict()).max(20).optional(),
  // Settled review entries: put back into the list, the bookings they became are removed again.
  reviews: z.array(z.object({ item: reviewItemSchema, transactionIds: z.array(z.string().min(1).max(500)).max(20) }).strict()).max(500).optional(),
}).strict();
export type AssistantUndo = z.infer<typeof assistantUndoSchema>;
export const assistantChangeLogSchema = z.object({
  id: agentIdSchema,
  at: z.number().nonnegative(),
  title: z.string().max(200),
  summary: z.array(z.string().max(300)).max(80),
  undo: assistantUndoSchema,
  undoneAt: z.number().nonnegative().optional(),
}).strict();
export type AssistantChangeLog = z.infer<typeof assistantChangeLogSchema>;
export const MAX_ASSISTANT_CHANGES = 200;
export const contractIntervals = ["weekly", "biweekly", "monthly", "quarterly", "halfyearly", "yearly"] as const;
export const contractIntervalSchema = z.enum(contractIntervals);
export type ContractInterval = z.infer<typeof contractIntervalSchema>;
export const contractNoticeSchema = z.object({
  value: z.number().int().min(1).max(730),
  unit: z.enum(["days", "weeks", "months"]),
}).strict();
export type ContractNotice = z.infer<typeof contractNoticeSchema>;
// Which bookings belong to a contract: text in the booking, amount range and account; every set criterion must match.
export const contractMatchSchema = z.object({
  text: z.string().trim().min(1).max(80).optional(),
  amountMin: z.number().finite().nonnegative().max(1_000_000).optional(),
  amountMax: z.number().finite().nonnegative().max(1_000_000).optional(),
  account: z.string().trim().min(1).max(100).optional(),
}).strict().refine((match) => match.amountMin === undefined || match.amountMax === undefined || match.amountMin <= match.amountMax,
  "Der Mindestbetrag darf nicht über dem Höchstbetrag liegen.");
export type ContractMatch = z.infer<typeof contractMatchSchema>;
// The user's decisions about a detected or manually added contract; detection itself is recomputed from bookings.
export const contractOverrideSchema = z.object({
  id: z.string().trim().min(1).max(300),
  status: z.enum(["confirmed", "ignored", "cancelled"]).optional(),
  manual: z.boolean().optional(),
  name: z.string().trim().min(1).max(100).optional(),
  category: categorySchema.optional(),
  amount: z.number().finite().positive().max(1_000_000).optional(),
  interval: contractIntervalSchema.optional(),
  nextDate: dateSchema.optional(),
  notice: contractNoticeSchema.optional(),
  termEnd: dateSchema.optional(),
  autoRenew: z.boolean().optional(),
  renewalMonths: z.number().int().min(1).max(60).optional(),
  cancelledAt: dateSchema.optional(),
  note: z.string().trim().max(500).optional(),
  // Bookings picked by hand, bookings taken out, and rules for future bookings.
  bookingIds: z.array(z.string().min(1).max(500)).max(500).optional(),
  excludedBookingIds: z.array(z.string().min(1).max(500)).max(500).optional(),
  match: contractMatchSchema.optional(),
  // The detected series at the time of the decision, so the decision still finds it after its id changed.
  snapshot: z.object({
    brand: z.string().trim().min(1).max(300),
    amount: z.number().finite().nonnegative().max(1_000_000_000),
    interval: contractIntervalSchema,
  }).strict().optional(),
  updatedAt: z.number().int().nonnegative(),
}).strict().refine(
  (entry) => !entry.manual || (!!entry.name && entry.amount !== undefined && !!entry.interval && !!entry.nextDate),
  "Ein manueller Vertrag braucht Name, Betrag, Intervall und nächsten Termin.",
);
export type ContractOverride = z.infer<typeof contractOverrideSchema>;
export const MAX_CONTRACTS = 500;
// Proactive hints the user dismissed; synced so they stay away on every device.
export const dismissedInsightSchema = z.object({
  id: z.string().trim().min(1).max(300),
  at: z.number().int().nonnegative(),
}).strict();
export type DismissedInsight = z.infer<typeof dismissedInsightSchema>;
export const MAX_DISMISSED_INSIGHTS = 300;
const payrollBudgetMonthSchema = z.string().regex(/^202[6-8]-(0[1-9]|1[0-2])$/);
/**
 * Automatic budget from payslips: when it last ran, the target values it set per income row and month (a different
 * value later means the user changed it by hand), corrections the user chose to keep as they are, and payslips the
 * user confirmed despite a contradiction (key + fingerprint of exactly those values).
 */
export const payrollBudgetSchema = z.object({
  at: z.number().int().nonnegative().optional(),
  targets: z.record(z.string().min(1).max(200), z.record(payrollBudgetMonthSchema, z.number().finite())).optional(),
  kept: z.array(z.string().min(1).max(220)).max(500).optional(),
  confirmed: z.array(z.string().min(1).max(300)).max(240).optional(),
}).strict();
export type PayrollBudgetState = z.infer<typeof payrollBudgetSchema>;

export const appStateSchema = z.object({
  version: z.literal(1),
  payslips: z.array(payslipSchema).max(240).refine(
    (entries) => new Set(entries.map(payslipKey)).size === entries.length,
    "Je Arbeitgeber und Monat darf nur eine Lohnabrechnung gespeichert sein.",
  ).optional(),
  payrollForecasts: z.array(payrollForecastSchema).max(20).refine(
    (entries) => new Set(entries.map((entry) => `${entry.year}|${payrollEmployerKey(entry.employer)}`)).size === entries.length,
    "Je Arbeitgeber und Jahr darf nur eine Gehaltsprognose gespeichert sein.",
  ).optional(),
  annualSixth: z.array(annualSixthSchema).max(2).refine(
    (entries) => new Set(entries.map((entry) => entry.year)).size === entries.length,
    "Für jedes Jahr darf nur eine Jahressechstel-Abrechnung gespeichert sein.",
  ).optional(),
  budgetAdjustments: budgetAdjustmentsSchema.optional(),
  holidayRanges: z.array(holidayRangeSchema).max(100).refine(
    (ranges) => {
      const sorted = [...ranges].sort((a, b) => a.from.localeCompare(b.from));
      return sorted.every((range, index) => !index || range.from > sorted[index - 1].to);
    },
    "Urlaubszeiträume dürfen sich nicht überschneiden.",
  ).optional(),
  plannedOneOffs: z.array(plannedOneOffSchema).max(500).refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    "Einmalige Ausgaben müssen eindeutige IDs haben.",
  ).optional(),
  plannedOneOffsSeeded: z.boolean().optional(),
  seasonalTheme: seasonalPreferenceSchema.optional(),
  savingsGoals: z.array(savingsGoalSchema).max(50).refine(
    (goals) => new Set(goals.map((goal) => goal.id)).size === goals.length,
    "Sparziele müssen eindeutige IDs haben",
  ).optional(),
  dismissedInsights: z.array(dismissedInsightSchema).max(MAX_DISMISSED_INSIGHTS).optional(),
  contracts: z.array(contractOverrideSchema).max(MAX_CONTRACTS).refine(
    (entries) => new Set(entries.map((entry) => entry.id)).size === entries.length,
    "Verträge müssen eindeutige IDs haben.",
  ).optional(),
  pocketOpeningBalances: z.array(pocketOpeningBalanceSchema).max(10_000).optional(),
  bikeOnlyGoalApplied: z.boolean().optional(),
  planningRepairs: z
    .array(z.literal("september-2026-sonstiges-focus-override"))
    .max(1)
    .optional(),
  settings: settingsSchema,
  payrollBudget: payrollBudgetSchema.optional(),
  transactions: z.array(transactionSchema).max(100_000).superRefine((rows, context) => {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      if (seen.has(row.id)) context.addIssue({
        code: "custom", path: [index, "id"],
        message: `Doppelte Umsatz-ID „${row.id}“. Buchungen werden nicht zusammengeführt.`,
      });
      seen.add(row.id);
    });
  }),
  ignoredStatementKeys: z.array(z.string().max(2000).overwrite(normalizeStatementKey)).max(100_000).optional(),
  pocketSnapshots: z.array(pocketSnapshotSchema).max(10_000).optional(),
  merchantRules: z.array(merchantRuleSchema).max(100_000).optional(),
  merchantNameRules: z.array(merchantNameRuleSchema).max(100_000).optional(),
  fixedReceipts: z.array(fixedReceiptSchema).max(100_000).optional(),
  fixedAmountDecisions: z
    .array(
      z.object({
        merchantKey: z.string(),
        category: categorySchema,
        amount: moneySchema,
        month: z.string(),
        accept: z.boolean(),
      }),
    )
    .max(100_000)
    .optional(),
  accountSnapshots: z.array(accountSnapshotSchema).max(100_000).optional(),
  amexBalanceSnapshots: z.array(amexBalanceSnapshotSchema).max(10_000).optional(),
  amexScreenshotValidation: z.object({ version: z.literal(1), date: dateSchema }).optional(),
  trBalances: z.array(trBalanceSchema).max(10_000).optional(),
  reviewQueue: z.array(reviewItemSchema).max(100_000).optional(),
  // Unconfirmed local-AI proposals, keyed by review id; only pre-fill the review dialog.
  aiSuggestions: z.array(z.object({
    id: z.string().min(1).max(500),
    category: categorySchema,
    merchantAlias: z.string().trim().min(1).max(100).optional(),
    reason: z.string().max(200),
    source: z.enum(["KI", "Regel", "Historie", "Branche", "Abo"]),
  })).max(100_000).optional(),
  // Per import: how many new bookings needed no manual review (learning curve of the auto-assignment).
  aiLearning: z.array(z.object({
    id: z.string().min(1).max(100),
    name: z.string().max(255),
    at: z.number().nonnegative(),
    rows: z.number().int().nonnegative(),
    automatic: z.number().int().nonnegative(),
    ai: z.number().int().nonnegative(),
    later: z.number().int().nonnegative().optional(),
  })).max(200).optional(),
  // Shops looked up on the internet, reused for every later booking at the same shop.
  webCategories: z.array(webCategorySchema).max(MAX_WEB_CATEGORIES).optional(),
  assistantChat: z.array(assistantMessageSchema).max(MAX_ASSISTANT_MESSAGES).optional(),
  // Facts the user asked the assistant to remember; visible and deletable in the chat.
  assistantMemory: z.array(assistantMemorySchema).max(MAX_ASSISTANT_MEMORY).optional(),
  accountRules: z.array(accountRuleSchema).max(MAX_ACCOUNT_RULES).optional(),
  // What the assistant learned by itself: looked-up knowledge and phrasings it now understands without the model.
  assistantKnowledge: z.array(assistantKnowledgeSchema).max(MAX_ASSISTANT_KNOWLEDGE).optional(),
  assistantPhrases: z.array(assistantPhraseSchema).max(MAX_ASSISTANT_PHRASES).optional(),
  assistantAliases: z.array(assistantAliasSchema).max(MAX_ASSISTANT_ALIASES).optional(),
  assistantGaps: z.array(assistantGapSchema).max(MAX_ASSISTANT_GAPS).optional(),
  // Every change the assistant applied, with the data needed to undo it.
  assistantChanges: z.array(assistantChangeLogSchema).max(MAX_ASSISTANT_CHANGES).optional(),
  importStatus: z
    .object({ imported: z.number().nonnegative(), issues: z.array(z.string()) })
    .optional(),
  importResults: z.array(importResultSchema).max(MAX_IMPORT_RESULTS).refine(
    (results) => new Set(results.map((result) => result.uploadId)).size === results.length,
    "Importergebnisse müssen eindeutige Upload-IDs haben.",
  ).optional(),
  financeRows: z.array(financeRowSchema).max(200).superRefine((rows, context) => {
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      if (seen.has(row.id)) context.addIssue({
        code: "custom", path: [index, "id"],
        message: `Doppelte Finanzzeilen-ID „${row.id}“. Zeilen werden nicht zusammengeführt.`,
      });
      seen.add(row.id);
    });
  }),
  months: z.record(
    z.string().regex(/^202[6-8]-(0[1-9]|1[0-2])$/),
    monthInputSchema,
  ),
});
export type AppState = z.infer<typeof appStateSchema>;
export const emptyPockets = (): PocketAmounts => ({
  Notgroschen: 0,
  Urlaub: 0,
  Sparkonto: 0,
  Motorrad: 0,
});
export const emptyMonth = (): MonthInput => ({
  variableOverride: null,
  bikeOverride: null,
  pocketIn: emptyPockets(),
  pocketOut: emptyPockets(),
});
