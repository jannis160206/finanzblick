import { z } from "zod";

export const MAX_MERCHANT_MARKS = 100;
export const MAX_MERCHANT_MARKS_BYTES = 16 * 1024;
export const merchantBookingIdSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine((id) => !/[\x00-\x1f\x7f]/.test(id));
const merchantId = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const merchantLogoNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(100)
  .refine((name) => !/[\x00-\x1f\x7f]/.test(name));
export const merchantMarksRequestSchema = z
  .object({
    merchantIds: z.array(merchantId).max(MAX_MERCHANT_MARKS),
    merchantNames: z
      .array(merchantLogoNameSchema)
      .max(MAX_MERCHANT_MARKS)
      .optional(),
    bookingIds: z
      .array(merchantBookingIdSchema)
      .max(MAX_MERCHANT_MARKS)
      .optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.merchantIds.length +
        (input.merchantNames?.length ?? 0) +
        (input.bookingIds?.length ?? 0) <=
      MAX_MERCHANT_MARKS,
  );
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
export const merchantNameMarkSchema = z
  .object({
    merchantName: merchantLogoNameSchema,
    logo: merchantMarkSchema.shape.logo,
  })
  .strict();
export const merchantMarksResponseSchema = z
  .object({
    marks: z.array(merchantMarkSchema).max(MAX_MERCHANT_MARKS),
    nameMarks: z
      .array(merchantNameMarkSchema)
      .max(MAX_MERCHANT_MARKS)
      .optional(),
    bookingMarks: z
      .array(
        z
          .object({
            bookingId: merchantBookingIdSchema,
            logo: merchantMarkSchema.shape.logo,
          })
          .strict(),
      )
      .max(MAX_MERCHANT_MARKS)
      .optional(),
  })
  .strict()
  .refine(
    (response) =>
      response.marks.length +
        (response.nameMarks?.length ?? 0) +
        (response.bookingMarks?.length ?? 0) <=
      MAX_MERCHANT_MARKS,
  );
export type MerchantPresentation = z.infer<typeof merchantMarkSchema>;
