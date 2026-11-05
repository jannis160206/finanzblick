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
  ...sharedSettlementFields,
});
export const transactionSchema = transactionFieldsSchema.overwrite(normalizeAccount);
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
  bank: z.literal("Revolut"),
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
  z.string().regex(/^202[67]-(0[1-9]|1[0-2])$/),
  moneySchema.nonnegative().nullable(),
);
export const financeRowSchema = z.object({
  id: z.string().min(1).refine((id) => id.trim().length > 0, "Finanzzeilen-ID darf nicht leer sein."),
  label: z.string().trim().min(1).max(100),
  kind: z.enum(["income", "fixed", "variable"]),
  planCategory: categorySchema.optional(),
  overrides: z
    .record(
      z.string().regex(/^202[67]-(0[1-9]|1[0-2])$/),
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
  })
  .refine((value) => value.asOf >= value.baselineDate, {
    message: "Stichtag darf nicht vor dem Ist-Datum liegen",
    path: ["asOf"],
  });
export type Settings = z.infer<typeof settingsSchema>;
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
    extras: z.record(z.string().regex(/^202[67]-(0[1-9]|1[0-2])$/), moneySchema.nonnegative()),
    // Months without the regular rate (extras still count), e.g. set via the finance assistant.
    paused: z.array(z.string().regex(/^202[67]-(0[1-9]|1[0-2])$/)).max(24).optional(),
  }).optional(),
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
  }).strict(),
  z.object({
    op: z.literal("categorize"), ids: z.array(z.string().min(1).max(500)).min(1).max(2000),
    category: categorySchema, learn: z.boolean(),
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
]);
export type AssistantOperation = z.infer<typeof assistantOperationSchema>;
const assistantLineSchema = z.object({
  label: z.string().max(200),
  value: z.number().finite().optional(),
  detail: z.string().max(300).optional(),
  tone: z.enum(["good", "warn", "bad", "info"]).optional(),
  transactionIds: z.array(z.string().max(500)).max(50).optional(),
}).strict();
// Calculated result cards (answers, briefing, coach, depot, tax); every number comes from code.
export const assistantCardSchema = z.object({
  kind: z.enum(["answer", "briefing", "check", "coach", "depot", "tax", "homeoffice", "homeoffice_result", "rule", "memory", "changes", "loan", "review"]),
  title: z.string().max(200),
  total: z.number().finite().optional(),
  lines: z.array(assistantLineSchema).max(40),
  transactionIds: z.array(z.string().max(500)).max(50).optional(),
  month: monthKeySchema.optional(),
  year: z.number().int().min(2000).max(2100).optional(),
  note: z.string().max(400).optional(),
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
// Phrasings only the model understood; next time the rules answer them directly.
export const assistantPhraseSchema = z.object({
  pattern: z.string().trim().min(1).max(200),
  tool: z.string().trim().min(1).max(40),
  at: z.number().nonnegative(),
  hits: z.number().int().nonnegative().optional(),
}).strict();
export type AssistantPhrase = z.infer<typeof assistantPhraseSchema>;
export const MAX_ASSISTANT_PHRASES = 200;
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
  months: z.array(z.object({ month: z.string().regex(/^202[67]-(0[1-9]|1[0-2])$/), before: monthInputSchema.nullable() }).strict()).max(24).optional(),
  transactions: z.array(undoTransactionSchema).max(2000).optional(),
  merchantRules: z.array(z.object({ key: z.string().min(1).max(1200), before: merchantRuleSchema.nullable() }).strict()).max(2000).optional(),
  fixedReceipts: z.array(z.object({ key: z.string().max(2000), before: fixedReceiptSchema }).strict()).max(2000).optional(),
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
  pocketOpeningBalances: z.array(pocketOpeningBalanceSchema).max(10_000).optional(),
  bikeOnlyGoalApplied: z.boolean().optional(),
  planningRepairs: z
    .array(z.literal("september-2026-sonstiges-focus-override"))
    .max(1)
    .optional(),
  settings: settingsSchema,
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
  // Finance assistant chat, stored only in the local account database.
  assistantChat: z.array(assistantMessageSchema).max(MAX_ASSISTANT_MESSAGES).optional(),
  // Facts the user asked the assistant to remember; visible and deletable in the chat.
  assistantMemory: z.array(assistantMemorySchema).max(MAX_ASSISTANT_MEMORY).optional(),
  // What the assistant learned by itself: looked-up knowledge and phrasings it now understands without the model.
  assistantKnowledge: z.array(assistantKnowledgeSchema).max(MAX_ASSISTANT_KNOWLEDGE).optional(),
  assistantPhrases: z.array(assistantPhraseSchema).max(MAX_ASSISTANT_PHRASES).optional(),
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
    z.string().regex(/^202[67]-(0[1-9]|1[0-2])$/),
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
