import { z } from "zod";
import { appStateSchema } from "@/lib/types";

export const accountUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  role: z.enum(["admin", "user"]),
});

export type AccountUser = z.infer<typeof accountUserSchema>;

export const financeSnapshotSchema = z.object({
  state: appStateSchema.nullable(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type FinanceSnapshot = z.infer<typeof financeSnapshotSchema>;

export const accountCredentialsSchema = z
  .object({
    username: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]{3,32}$/)
      .transform((value) => value.toLowerCase()),
    password: z.string().min(12).max(128),
  })
  .strict();

export const accountLoginCredentialsSchema = accountCredentialsSchema.extend({
  password: z.string().min(1).max(128),
});

export const financeUpdateSchema = z
  .object({
    state: appStateSchema,
    revision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
  })
  .strict();
