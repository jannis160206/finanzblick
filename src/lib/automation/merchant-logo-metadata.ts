import { z } from "zod";

export const privateMerchantLogoSchema = z.object({
  file: z.string().regex(/^[a-f0-9]{64}\.png$/),
  license: z.enum(["CC0-1.0", "Public-domain", "CC-BY-4.0", "CC-BY-SA-4.0"]),
  attribution: z.string().trim().min(1).max(2000),
  sourceUrl: z.url().max(1000).refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "commons.wikimedia.org" &&
      !url.port && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.startsWith("/wiki/File:");
  }),
});
export type PrivateMerchantLogo = z.infer<typeof privateMerchantLogoSchema>;
