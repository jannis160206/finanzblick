import { z } from "zod";

export const MAX_MERCHANT_MARKS = 100;
const merchantId = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const merchantMarksRequestSchema = z
  .object({
    merchantIds: z.array(merchantId).max(MAX_MERCHANT_MARKS),
  })
  .strict();
export const merchantMarkSchema = z
  .object({
    merchantId,
    logo: z
      .object({
        merchantId,
        version: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .nullable(),
  })
  .strict();
export const merchantMarksResponseSchema = z
  .object({
    marks: z.array(merchantMarkSchema).max(MAX_MERCHANT_MARKS),
  })
  .strict();
export type MerchantPresentation = z.infer<typeof merchantMarkSchema>;
