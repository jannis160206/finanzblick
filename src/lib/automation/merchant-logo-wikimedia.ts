import { z } from "zod";

export const reviewedWikimediaWikiSchema = z.enum(["commons", "de"]);
export type ReviewedWikimediaWiki = z.infer<typeof reviewedWikimediaWikiSchema>;

export const commonsLogoFilenameSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/\.(?:png|jpe?g|webp|svg)$/i)
  .refine((filename) => !/[/\\\x00-\x1f|#]/.test(filename));

export const reviewedWikimediaFilenameSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/\.(?:png|jpe?g|webp|svg|tiff)$/i)
  .refine(
    (filename) =>
      filename === filename.trim() &&
      !/[/\\\x00-\x1f|#:\x7f]/.test(filename) &&
      !filename.startsWith("."),
  );

export const reviewedWikimediaEvidenceSchema = z
  .string()
  .trim()
  .min(40)
  .max(800)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value));

export function wikimediaSourceUrl(
  wiki: ReviewedWikimediaWiki,
  filename: string,
): string {
  return wiki === "de"
    ? `https://de.wikipedia.org/wiki/Datei:${encodeURIComponent(filename)}`
    : `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename)}`;
}

export const dewikiLogoSourceUrlSchema = z
  .url()
  .max(1000)
  .refine((value) => {
    try {
      const prefix = "https://de.wikipedia.org/wiki/Datei:";
      if (!value.startsWith(prefix)) return false;
      const filename = decodeURIComponent(value.slice(prefix.length));
      return (
        reviewedWikimediaFilenameSchema.safeParse(filename).success &&
        value === wikimediaSourceUrl("de", filename)
      );
    } catch {
      return false;
    }
  });
