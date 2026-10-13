import { z } from "zod";
import { importResultSchema } from "@/lib/import/result-schema";
import { automationErrorCodeSchema } from "./errors";

export const jobStatusSchema = z.enum([
  "UPLOADING",
  "QUEUED",
  "PROCESSING",
  "RETRYING",
  "COMPLETED",
  "FAILED",
]);
export const automationJobSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["statement", "backfill"]),
  name: z.string(),
  status: jobStatusSchema,
  progress: z.number().int().min(0).max(100),
  attempts: z.number().int().nonnegative(),
  cursor: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  error: z.string().nullable(),
  updatedAt: z.number(),
  result: importResultSchema.nullable().default(null),
  errorCode: automationErrorCodeSchema.nullable().default(null),
});
// Legacy jobs may omit result metadata; validated payloads normalize it to null.
export type AutomationJob = z.input<typeof automationJobSchema>;
export const statementUploadResponseSchema = z.object({ id: z.string().uuid() });
export const merchantCatalogueStatusSchema = z.object({
  status: z.enum(["current", "refreshing", "unavailable"]),
  checkedAt: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative().max(20),
  warning: z.string().max(300).nullable(),
});
export type MerchantCatalogueStatus = z.infer<typeof merchantCatalogueStatusSchema>;
export const automationEventSchema = z.object({
  revision: z.number().int().nonnegative(),
  jobs: z.array(automationJobSchema).max(20),
  catalogue: merchantCatalogueStatusSchema.optional(),
}).refine((event) => event.jobs.every((job) => !job.result || job.result.uploadId === job.id), {
  message: "Importergebnis gehört nicht zu diesem Upload.",
  path: ["jobs"],
});
export type AutomationEvent = z.infer<typeof automationEventSchema>;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_QUEUE_BYTES = 128 * 1024 * 1024;
export const BACKFILL_BATCH = 200;
export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 60_000;
export const MERCHANT_BACKFILL_VERSION = "source-purpose-v7-2026-10-13";
