import { z } from "zod";
import {
  accountSnapshotSchema,
  amexBalanceSnapshotSchema,
  dateSchema,
  pocketSnapshotSchema,
  statementRepairDraftSchema,
  transactionSchema,
  trBalanceSchema,
} from "@/lib/types";
import { MAX_IMPORT_BYTES, MAX_STATEMENT_ROWS } from "@/lib/import/limits";
import { automationErrorCodeSchema } from "./errors";
import { importIssueActionSchema, importIssueReasonSchema } from "@/lib/import/result-schema";

export const MAX_PARSER_RESULT_BYTES = 20 * 1024 * 1024;
export const parserRequestSchema = z.object({
  type: z.literal("parse"),
  id: z.string().uuid(),
  path: z.string().min(1).max(4096),
  name: z.string().min(1).max(200),
  bytes: z.number().int().min(1).max(MAX_IMPORT_BYTES),
  workspace: z.string().min(1).max(4096),
  deadline: z.number().int().positive(),
}).strict();
export type ParserRequest = z.infer<typeof parserRequestSchema>;

export const parserResultSchema = z.object({
  source: z.enum(["Raiffeisen", "Revolut", "Amex", "Trade Republic", "PDF", "Bank"]).nullable(),
  file: z.string().max(200),
  rows: z.array(transactionSchema).max(MAX_STATEMENT_ROWS),
  skipped: z.number().int().nonnegative(),
  issues: z.array(z.object({
    file: z.string().max(200),
    line: z.number().int().nonnegative().optional(),
    message: z.string().max(2000),
    action: importIssueActionSchema.optional(),
    reason: importIssueReasonSchema.optional(),
    evidence: z.string().max(2000).optional(),
    // Incomplete issue facts are repair drafts, never validated transaction rows.
    draft: statementRepairDraftSchema.optional(),
  }).refine((issue) => !(issue.action === "reupload" || issue.reason !== undefined) || !issue.draft,
    "Nicht reparierbare Quellwerte dürfen keinen editierbaren Entwurf enthalten.")).max(MAX_STATEMENT_ROWS),
  pocketSnapshots: z.array(pocketSnapshotSchema).max(10_000).optional(),
  accountSnapshots: z.array(accountSnapshotSchema).max(100_000).optional(),
  amexBalanceSnapshots: z.array(amexBalanceSnapshotSchema).max(10_000).optional(),
  trBalances: z.array(trBalanceSchema).max(10_000).optional(),
  amexScreenshot: z.object({
    layout: z.enum(["grouped", "list"]),
    capturedAt: dateSchema,
    periodStart: dateSchema.optional(),
    balance: z.number().finite().optional(),
    balanceIncludesPending: z.boolean(),
    card: z.string().max(200).optional(),
    bookingOrder: z.array(z.string().max(2000)).max(MAX_STATEMENT_ROWS).optional(),
  }).optional(),
}).strict();

export const parserReplySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("result"),
    id: z.string().uuid(),
    result: parserResultSchema,
  }).strict(),
  z.object({
    type: z.literal("error"),
    id: z.string().uuid(),
    code: automationErrorCodeSchema,
  }).strict(),
]);
