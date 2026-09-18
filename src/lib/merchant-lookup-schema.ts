import { z } from "zod";

export const merchantLookupTtl = 30 * 24 * 60 * 60 * 1000;
export const normalizeLookupQuery = (query: string) =>
  query.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("de-AT");
export const merchantLookupQuerySchema = z.string().trim().min(2).max(180)
  .refine((query) => /\p{L}{2}/u.test(query), "Ein Händlername ist erforderlich.");
export const merchantLookupResultSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(1000),
});
export const merchantLookupResultsSchema = z.array(merchantLookupResultSchema).max(3)
  .refine((results) => new Set(results.map((result) => result.id)).size === results.length, "Suchergebnisse müssen eindeutig sein.");
export type MerchantLookupResult = z.infer<typeof merchantLookupResultSchema>;
