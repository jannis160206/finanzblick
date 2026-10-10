import { createHash } from "node:crypto";
import { z } from "zod";
import { privateMerchantLogoSchema } from "./merchant-logo-metadata";
import {
  dewikiLogoSourceUrlSchema,
  reviewedWikimediaEvidenceSchema,
} from "./merchant-logo-wikimedia";

const text = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
export const logoAccountIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
export const logoMerchantIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const logoRightsReferenceSchema = text;
export const publicLogoRightsSchema = z
  .object({
    license: privateMerchantLogoSchema.shape.license.nullable(),
    licenseName: text.nullable(),
    licenseUrl: text.nullable(),
    usageTerms: text.nullable(),
    restrictions: text.nullable(),
    artist: text.nullable(),
    credit: text.nullable(),
    copyrighted: text.nullable().optional(),
    attributionRequired: text.nullable().optional(),
  })
  .strict();
export type PublicLogoRights = z.infer<typeof publicLogoRightsSchema>;
export const authorizedMerchantLogoSchema = z
  .object({
    file: privateMerchantLogoSchema.shape.file,
    permission: z.literal("operator-declared-private-usage-rights"),
    rightsReference: logoRightsReferenceSchema,
    attribution: text,
    provenance: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("commons"),
          sourceUrl: privateMerchantLogoSchema.shape.sourceUrl,
          wikidataId: z.string().regex(/^Q[1-9]\d{0,11}$/),
          associationEvidence: text.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("dewiki"),
          sourceUrl: dewikiLogoSourceUrlSchema,
          wikidataId: z.string().regex(/^Q[1-9]\d{0,11}$/),
          associationEvidence: reviewedWikimediaEvidenceSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("local-file"),
          sourceLabel: text,
        })
        .strict(),
    ]),
    publicRights: publicLogoRightsSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.provenance.kind !== "local-file") !==
      (value.publicRights !== null)
    )
      context.addIssue({
        code: "custom",
        message: "Wikimedia sources require separate public rights metadata",
      });
  });
export type AuthorizedMerchantLogo = z.infer<
  typeof authorizedMerchantLogoSchema
>;

export function authorizedLogoVersion(
  userId: string,
  identity: { merchantId: string; canonicalName: string },
  logo: AuthorizedMerchantLogo,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        format: "authorized-merchant-logo/2",
        account: logoAccountIdSchema.parse(userId),
        merchantId: logoMerchantIdSchema.parse(identity.merchantId),
        canonicalName: z.string().min(2).max(100).parse(identity.canonicalName),
        logo: authorizedMerchantLogoSchema.parse(logo),
      }),
    )
    .digest("hex");
}

/** Read compatibility only: existing cached URLs must retain their original credits. */
export function legacyAuthorizedLogoVersion(
  userId: string,
  logo: AuthorizedMerchantLogo,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        account: logoAccountIdSchema.parse(userId),
        logo: authorizedMerchantLogoSchema.parse(logo),
      }),
    )
    .digest("hex");
}

export type AuthorizedLogoGrant = {
  merchantId: string;
  canonicalName: string;
  version: string;
  logo: AuthorizedMerchantLogo;
};
