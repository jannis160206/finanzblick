import { z } from "zod";

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
});
export type AutomationJob = z.infer<typeof automationJobSchema>;
export const automationEventSchema = z.object({
  revision: z.number().int().nonnegative(),
  jobs: z.array(automationJobSchema).max(20),
});
export type AutomationEvent = z.infer<typeof automationEventSchema>;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_QUEUE_BYTES = 128 * 1024 * 1024;
export const BACKFILL_BATCH = 200;
export const MAX_ATTEMPTS = 5;
export const LEASE_MS = 60_000;
