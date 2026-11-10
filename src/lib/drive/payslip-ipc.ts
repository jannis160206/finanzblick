import { z } from "zod";

export const MAX_PAYSLIP_RESULT_BYTES = 2 * 1024 * 1024;
const MAX_PAYSLIP_BYTES = 20 * 1024 * 1024;

export const payslipChildRequestSchema = z.object({
  type: z.literal("payslip"),
  id: z.string().uuid(),
  path: z.string().min(1).max(4096),
  bytes: z.number().int().min(1).max(MAX_PAYSLIP_BYTES),
  /** Tried in order after reading without a password. Sent over IPC only, never via argv or env. */
  passwords: z.array(z.string().min(1).max(200)).max(2),
  deadline: z.number().int().positive(),
}).strict();
export type PayslipChildRequest = z.infer<typeof payslipChildRequestSchema>;

const payslipImportSchema = z.object({ drafts: z.array(z.unknown()).max(240), issues: z.array(z.string().max(500)).max(500) });

export const payslipChildReplySchema = z.union([
  z.object({ type: z.literal("result"), id: z.string().uuid(), status: z.literal("ok"), result: payslipImportSchema }).strict(),
  z.object({ type: z.literal("result"), id: z.string().uuid(), status: z.literal("locked") }).strict(),
  z.object({ type: z.literal("error"), id: z.string().uuid(), message: z.string().max(300) }).strict(),
]);
export type PayslipChildReply = z.infer<typeof payslipChildReplySchema>;
