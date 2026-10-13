import { z } from "zod";
import { automationErrorCodeSchema } from "@/lib/automation/errors";

const count = z.number().int().nonnegative();
export const importIssueActionSchema = z.enum(["correct", "reupload"]);
export const importIssueReasonSchema = z.enum(["foreign-currency", "invalid-repair-draft"]);
export const IMPORT_RESULT_WARNING_JSON_BUDGET = 64 * 1024;
export const MAX_IMPORT_RESULT_JSON_LENGTH = 262_144;
export const IMPORT_WARNING_DETAILS_OMITTED = "Hinweisdetails gekürzt – vollständigen Originalbeleg prüfen. ";
const importResultFieldsSchema = z.object({
  uploadId: z.string().uuid(),
  name: z.string().max(255),
  completedAt: z.number().nonnegative(),
  status: z.enum(["imported", "with-warnings", "unsupported", "failed"]),
  errorCode: automationErrorCodeSchema.optional(),
  inserted: count,
  updated: count,
  duplicates: count,
  review: count,
  skipped: count,
  issues: z.array(z.object({
    id: z.string().max(120),
    line: z.number().int().positive().optional(),
    message: z.string().max(2000),
    action: importIssueActionSchema,
    reason: importIssueReasonSchema.optional(),
    evidence: z.string().max(2000).optional(),
    reviewId: z.string().max(2000).optional(),
  })).max(100),
  warningDetailsOmitted: z.literal(true).optional(),
});
export type ImportResult = z.infer<typeof importResultFieldsSchema>;

function prefix(text: string, length: number) {
  const value = text.slice(0, length);
  const last = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? value.slice(0, -1) : value;
}

function boundWarningDetails(result: ImportResult): ImportResult {
  if (result.warningDetailsOmitted && result.issues.length &&
    !result.issues[0].message.startsWith(IMPORT_WARNING_DETAILS_OMITTED)) {
    result = { ...result, issues: result.issues.map((issue, index) => index === 0 ? { ...issue,
      message: IMPORT_WARNING_DETAILS_OMITTED + prefix(issue.message, 2000 - IMPORT_WARNING_DETAILS_OMITTED.length),
    } : issue) };
  }
  if (JSON.stringify(result).length <= IMPORT_RESULT_WARNING_JSON_BUDGET) return result;
  const compact = (length: number): ImportResult => ({ ...result, warningDetailsOmitted: true,
    issues: result.issues.map((issue, index) => {
      const { evidence, ...facts } = issue;
      const message = index === 0 && issue.message.startsWith(IMPORT_WARNING_DETAILS_OMITTED)
        ? issue.message.slice(IMPORT_WARNING_DETAILS_OMITTED.length) : issue.message;
      const excerpt = evidence ? prefix(evidence, length) : "";
      return { ...facts,
        message: (index === 0 ? IMPORT_WARNING_DETAILS_OMITTED : "") + prefix(message, length),
        ...(excerpt ? { evidence: excerpt } : {}),
      };
    }),
  });
  // Reserve all identifiers, links, typed actions and counts before budgeting text.
  let bounded = compact(0);
  if (JSON.stringify(bounded).length > IMPORT_RESULT_WARNING_JSON_BUDGET) return bounded;
  let low = 0, high = 2000 - IMPORT_WARNING_DETAILS_OMITTED.length;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const candidate = compact(length);
    if (JSON.stringify(candidate).length <= IMPORT_RESULT_WARNING_JSON_BUDGET) {
      bounded = candidate;
      low = length + 1;
    } else high = length - 1;
  }
  return bounded;
}

export const importResultSchema = importResultFieldsSchema.overwrite(boundWarningDetails).refine(
  (result) => JSON.stringify(result).length <= MAX_IMPORT_RESULT_JSON_LENGTH,
  "Importergebnis-Herkunftsangaben überschreiten die Speichergrenze.",
);
export const IMPORT_RESULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_IMPORT_RESULTS = 20;
