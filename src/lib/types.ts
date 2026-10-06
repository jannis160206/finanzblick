import { z } from "zod";
import { normalizeAccount } from "@/lib/accounts";
import { isAmexScreenshot, normalizeStatementKey } from "@/lib/import/identity";
import { seasonalModes, seasonalThemes } from "@/lib/seasonal-theme";
import { payslipKey, payslipSchema, payrollEmployerKey, payrollForecastSchema } from "@/lib/payslip-schema";
import { allCategories, categories, canonicalCategory, type Category } from "@/lib/categories";
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
  id: z.string().min(1),
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
  category: categorySchema.catch("Prüfen"),
  amount: moneySchema.refine(
    (value) => value !== 0,
    "Betrag darf nicht 0 sein",
  ),
  includeInPlan: z.boolean(),
  afterBaseline: z.boolean().optional(),
  categoryOverride: z.boolean().optional(),
  manualCategory: z.boolean().optional(),
  // Explicit acknowledgement of this booking, never inherited from a merchant rule.
  reviewed: z.boolean().optional(),
  // Only this booking: omission keeps legacy category-based accounting.
  fixedCost: z.boolean().optional(),
  sourceCategory: z.string().max(200).optional(),
  bankReference: z.string().max(500).optional(),
  occurrence: z.number().int().positive().optional(),
  sharedWithRaphael: z.boolean().optional(),
  sharedPaidManually: z.boolean().optional(),
});
export const transactionSchema = transactionFieldsSchema.overwrite(normalizeAccount);
export type Transaction = z.infer<typeof transactionSchema>;
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
    draft: transactionFieldsSchema.extend({
      amount: moneySchema.nullable(),
      date: dateSchema.or(z.literal("")),
      description: z.string().trim().max(1000),
    }).overwrite(normalizeAccount).refine(
      (draft) => isAmexScreenshot(draft) || (!!draft.date && !!draft.description),
      "Datum und Beschreibung erforderlich.",
    ),
    message: z.string(),
    importIssues: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("fixed"),
    id: z.string(),
    change: fixedChangeSchema,
  }),
]);
export type ReviewItem = z.infer<typeof reviewItemSchema>;
export type FixedChange = z.infer<typeof fixedChangeSchema>;
const financeValuesSchema = z.record(
  z.string().regex(/^202[67]-(0[1-9]|1[0-2])$/),
  moneySchema.nonnegative().nullable(),
);
export const financeRowSchema = z.object({
  id: z.string().min(1),
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
    emergencyTarget: moneySchema.positive(),
    vacationTarget: moneySchema.positive(),
    savingsTarget: moneySchema.positive(),
    bikeTarget: moneySchema.positive(),
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
  }).optional(),
});
export type SavingsGoal = z.infer<typeof savingsGoalSchema>;
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
  bikeOnlyGoalApplied: z.boolean().optional(),
  planningRepairs: z
    .array(z.literal("september-2026-sonstiges-focus-override"))
    .max(1)
    .optional(),
  settings: settingsSchema,
  transactions: z.array(transactionSchema).max(100_000),
  ignoredStatementKeys: z.array(z.string().max(2000).overwrite(normalizeStatementKey)).max(100_000).optional(),
  pocketSnapshots: z.array(pocketSnapshotSchema).max(10_000).optional(),
  merchantRules: z.array(merchantRuleSchema).max(100_000).optional(),
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
  importStatus: z
    .object({ imported: z.number().nonnegative(), issues: z.array(z.string()) })
    .optional(),
  financeRows: z.array(financeRowSchema).max(200),
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
