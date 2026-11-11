import { z } from "zod";
import type { PayslipImport } from "@/lib/payslip-schema";
import { isReferencePayslip, payslipSchema } from "@/lib/payslip-schema";
import type { PayslipValidation } from "@/lib/payslip-validation";

/**
 * Where an entry comes from: the page button, the central import, Drive in the browser or in the background,
 * "Erneut prüfen", or the automatic budget update from payslips.
 */
export const payslipLogSources = ["upload", "import", "drive", "drive-background", "recheck", "budget"] as const;
export type PayslipLogSource = (typeof payslipLogSources)[number];

const text = (max: number) => z.string().max(max);
const fileSchema = z.object({ name: text(300), outcome: z.enum(["imported", "skipped", "failed", "waiting"]), note: text(300).optional() });
const draftSchema = z.object({
  period: text(20),
  employer: text(200).optional(),
  complete: z.boolean(),
  reference: z.boolean().optional(),
  /** Some values were estimated (not safely readable). */
  estimated: z.boolean().optional(),
  fields: z.record(text(40), z.number().finite()).optional(),
});

const checkSchema = z.object({ id: text(40), level: z.enum(["error", "warning", "info"]), message: text(400) });
const validationSchema = z.object({
  period: text(20),
  employer: text(200).optional(),
  consistent: z.boolean(),
  /** Kept out of the budget until the user confirms it. */
  held: z.boolean().optional(),
  checks: z.array(checkSchema).max(30),
  passed: z.array(text(40)).max(30).optional(),
});
const lookupSchema = z.object({
  term: text(80),
  source: z.enum(["glossar", "wikipedia", "ohne-treffer", "nicht-nachgeschlagen", "fehler"]),
  title: text(200).optional(),
  text: text(1600).optional(),
  url: text(300).optional(),
});
const budgetSchema = z.object({
  /** Budget values written automatically. */
  applied: z.number().int().nonnegative(),
  /** Values offered for review instead (changed by hand, possible duplicates). */
  review: z.number().int().nonnegative().optional(),
  /** Abrechnungsmonate kept out of the budget because of contradictions. */
  held: z.array(text(10)).max(60).optional(),
  changes: z.array(z.object({ row: text(100), month: text(10), from: z.number().finite(), to: z.number().finite(), reason: text(300) })).max(120).optional(),
});

export const payslipLogEntrySchema = z.object({
  at: z.number().int().nonnegative(),
  source: z.enum(payslipLogSources),
  message: text(1000),
  files: z.array(fileSchema).max(60).optional(),
  issues: z.array(text(500)).max(100).optional(),
  drafts: z.array(draftSchema).max(60).optional(),
  /** Payslips newly stored or changed. */
  stored: z.number().int().nonnegative().optional(),
  /** Abrechnungsmonate of reference payslips (2025): kept for forecasts, never written to the budget. */
  reference: z.array(text(10)).max(60).optional(),
  /** Local plausibility checks of every complete payslip. */
  validation: z.array(validationSchema).max(60).optional(),
  /** Unclear terms explained by the glossary or – only when allowed – looked up on Wikipedia. */
  lookups: z.array(lookupSchema).max(10).optional(),
  budget: budgetSchema.optional(),
});
export type PayslipLogLookup = z.infer<typeof lookupSchema>;
export type PayslipLogBudget = z.infer<typeof budgetSchema>;
export type PayslipLogEntry = z.infer<typeof payslipLogEntrySchema>;
export type PayslipLogFile = z.infer<typeof fileSchema>;

export const PAYSLIP_LOG_LIMIT = 200;

const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const period = (year: number | undefined, month: number | undefined) =>
  year && month ? `${year}-${String(month).padStart(2, "0")}` : "unbekannt";

/** One structured log entry from what an import read; long texts and lists are clipped, nothing is invented. */
export function payslipLogEntry(input: {
  source: PayslipLogSource;
  message: string;
  at?: number;
  files?: PayslipLogFile[];
  report?: PayslipImport | null;
  stored?: number;
  validation?: readonly PayslipValidation[];
  /** Abrechnungsmonate kept out of the budget. */
  held?: readonly string[];
  lookups?: readonly PayslipLogLookup[];
  budget?: PayslipLogBudget;
}): PayslipLogEntry {
  const drafts = (input.report?.drafts ?? []).slice(0, 60).map((draft) => {
    const parsed = payslipSchema.safeParse(draft);
    const fields = Object.fromEntries(Object.entries(draft)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[0] !== "year" && entry[0] !== "month")
      .slice(0, 40)
      .map(([key, value]) => [key.slice(0, 40), value]));
    return {
      period: period(draft.year, draft.month),
      ...(draft.employer ? { employer: clip(draft.employer, 200) } : {}),
      complete: parsed.success,
      ...(parsed.success && isReferencePayslip(parsed.data) ? { reference: true } : {}),
      ...(draft.estimated ? { estimated: true } : {}),
      ...(Object.keys(fields).length ? { fields } : {}),
    };
  });
  const reference = drafts.filter((draft) => draft.reference).map((draft) => draft.period);
  const issues = [...new Set(input.report?.issues ?? [])].slice(0, 100).map((issue) => clip(issue, 500));
  return payslipLogEntrySchema.parse({
    at: input.at ?? Date.now(),
    source: input.source,
    message: clip(input.message || "Ohne Meldung.", 1000),
    ...(input.files?.length ? { files: input.files.slice(0, 60).map((file) => ({ ...file, name: clip(file.name, 300), ...(file.note ? { note: clip(file.note, 300) } : {}) })) } : {}),
    ...(issues.length ? { issues } : {}),
    ...(drafts.length ? { drafts } : {}),
    ...(input.stored !== undefined ? { stored: input.stored } : {}),
    ...(reference.length ? { reference } : {}),
    ...(input.validation?.length ? {
      validation: input.validation.slice(0, 60).map((item) => ({
        period: item.period,
        employer: clip(item.employer, 200),
        consistent: item.consistent,
        ...(input.held?.includes(item.period) ? { held: true } : {}),
        checks: item.checks.slice(0, 30).map((check) => ({ id: check.id.slice(0, 40), level: check.level, message: clip(check.message, 400) })),
        passed: item.passed.slice(0, 30),
      })),
    } : {}),
    ...(input.lookups?.length ? {
      lookups: input.lookups.slice(0, 10).map((item) => ({
        ...item, term: clip(item.term, 80),
        ...(item.title ? { title: clip(item.title, 200) } : {}),
        ...(item.text ? { text: clip(item.text, 1600) } : {}),
        ...(item.url ? { url: item.url.slice(0, 300) } : {}),
      })),
    } : {}),
    ...(input.budget ? {
      budget: {
        ...input.budget,
        ...(input.budget.held ? { held: input.budget.held.slice(0, 60) } : {}),
        ...(input.budget.changes ? { changes: input.budget.changes.slice(0, 120).map((change) => ({ ...change, row: clip(change.row, 100), reason: clip(change.reason, 300) })) } : {}),
      },
    } : {}),
  });
}

export function appendPayslipLog(log: readonly PayslipLogEntry[], entry: PayslipLogEntry, limit = PAYSLIP_LOG_LIMIT): PayslipLogEntry[] {
  return [...log, entry].slice(-limit);
}

/** Parses a stored log and drops entries that no longer match the schema. */
export function readPayslipLog(value: unknown): PayslipLogEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = payslipLogEntrySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}
