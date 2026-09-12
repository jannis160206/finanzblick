import { z } from "zod";
import { seasonalModes, seasonalThemes } from "@/lib/seasonal-theme";

z.config(z.locales.de());

export const pocketNames = [
  "Notgroschen",
  "Urlaub",
  "Sparkonto",
  "Motorrad",
] as const;
export type Pocket = (typeof pocketNames)[number];
export const categories = [
  "Mittagessen",
  "Lebensmittel",
  "Ausgehen",
  "Barber",
  "Mobilität",
  "Shopping",
  "Gesundheit",
  "Freizeit",
  "Sonstiges",
  "Einkommen",
  "Transfer",
  "Transfer intern",
  "Prüfen",
  "Gehalt",
  "Rufbereitschaft",
  "Leasing",
  "Haftpflicht",
  "Vollkasko",
  "Handyvertrag",
  "Apple Care",
  "PayPal Abo",
  "AMEX Monatsgebühr",
  "Spotify",
] as const;
export type Category = (typeof categories)[number];
export const durableCategories: readonly Category[] = [
  "Gehalt",
  "Leasing",
  "Vollkasko",
  "Haftpflicht",
  "Handyvertrag",
  "Apple Care",
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
export const transactionSchema = z.object({
  id: z.string().min(1),
  date: dateSchema,
  bank: z.string().trim().min(1, "Bank erforderlich").max(100),
  pocket: z.string().trim().min(1).max(100).nullable(),
  description: z.string().trim().min(1, "Beschreibung erforderlich").max(1000),
  category: z.enum(categories),
  amount: moneySchema.refine(
    (value) => value !== 0,
    "Betrag darf nicht 0 sein",
  ),
  includeInPlan: z.boolean(),
  afterBaseline: z.boolean().optional(),
  categoryOverride: z.boolean().optional(),
  sourceCategory: z.string().max(200).optional(),
  bankReference: z.string().max(500).optional(),
  occurrence: z.number().int().positive().optional(),
});
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
  category: z.enum(categories),
});
export const fixedReceiptSchema = z.object({
  key: z.string().max(2000),
  merchantKey: z.string().max(1200).optional(),
  date: dateSchema,
  category: z.enum(categories),
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
export const trBalanceSchema = z.object({
  date: dateSchema,
  balance: moneySchema.nonnegative(),
});
export const fixedChangeSchema = z.object({
  id: z.string(),
  category: z.enum(categories),
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
    draft: transactionSchema.extend({ amount: moneySchema.nullable() }),
    message: z.string(),
  }),
  z.object({
    kind: z.literal("fixed"),
    id: z.string(),
    change: fixedChangeSchema,
  }),
]);
export type ReviewItem = z.infer<typeof reviewItemSchema>;
export type FixedChange = z.infer<typeof fixedChangeSchema>;
export const financeRowSchema = z.object({
  id: z.string().min(1),
  label: z.string().trim().min(1).max(100),
  kind: z.enum(["income", "fixed", "variable"]),
  planCategory: z.enum(categories).optional(),
  overrides: z
    .record(
      z.string().regex(/^202[67]-(0[1-9]|1[0-2])$/),
      moneySchema.nonnegative().nullable(),
    )
    .optional(),
  values: z.record(
    z.string().regex(/^202[67]-(0[1-9]|1[0-2])$/),
    moneySchema.nonnegative().nullable(),
  ),
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
export const seasonalPreferenceSchema = z.object({
  mode: z.enum(seasonalModes),
  theme: z.enum(seasonalThemes),
});
export const appStateSchema = z.object({
  version: z.literal(1),
  seasonalTheme: seasonalPreferenceSchema.optional(),
  planningRepairs: z
    .array(z.literal("september-2026-sonstiges-focus-override"))
    .max(1)
    .optional(),
  settings: settingsSchema,
  transactions: z.array(transactionSchema).max(100_000),
  ignoredStatementKeys: z.array(z.string().max(2000)).max(100_000).optional(),
  pocketSnapshots: z.array(pocketSnapshotSchema).max(10_000).optional(),
  merchantRules: z.array(merchantRuleSchema).max(100_000).optional(),
  fixedReceipts: z.array(fixedReceiptSchema).max(100_000).optional(),
  fixedAmountDecisions: z
    .array(
      z.object({
        merchantKey: z.string(),
        category: z.enum(categories),
        amount: moneySchema,
        month: z.string(),
        accept: z.boolean(),
      }),
    )
    .max(100_000)
    .optional(),
  accountSnapshots: z.array(accountSnapshotSchema).max(100_000).optional(),
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
