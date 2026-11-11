import { z } from "zod";
import type { PayslipImport } from "@/lib/payslip-schema";
import { isReferencePayslip, payslipSchema } from "@/lib/payslip-schema";

/** Where a payslip import started: the page button, the central import, Drive in the browser or in the background, "Erneut prüfen". */
export const payslipLogSources = ["upload", "import", "drive", "drive-background", "recheck"] as const;
export type PayslipLogSource = (typeof payslipLogSources)[number];

const text = (max: number) => z.string().max(max);
const fileSchema = z.object({ name: text(300), outcome: z.enum(["imported", "skipped", "failed", "waiting"]), note: text(300).optional() });
const draftSchema = z.object({
  period: text(20),
  employer: text(200).optional(),
  complete: z.boolean(),
  reference: z.boolean().optional(),
  fields: z.record(text(40), z.number().finite()).optional(),
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
});
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
