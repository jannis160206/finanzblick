import {
  importAuthorizedCommonsLogos,
  MAX_AUTHORIZED_LOGO_ENTITIES,
  authorizedLogoChoicesSchema,
} from "./merchant-logo-authorized-import";
import { MerchantIndex, seedMerchants } from "./merchants";
import type { AutomationStore } from "./store";
import type { z } from "zod";
import { logoRightsReferenceSchema } from "./merchant-logo-grant-metadata";
import { requireLogoAccount } from "./merchant-logo-grants";

export function merchantCatalogueReferences(store: AutomationStore) {
  const references = new Map(
    store.loadMerchants().map((merchant) => [merchant.id, merchant]),
  );
  for (const seed of seedMerchants) {
    const previous = references.get(seed.id);
    if (!previous || previous.updatedAt <= seed.updatedAt)
      references.set(seed.id, seed);
  }
  return references;
}

export async function completeMerchantCatalogue(
  store: AutomationStore,
  options: {
    userId: string;
    rightsReference: string;
    logoChoices?: z.infer<typeof authorizedLogoChoicesSchema>;
    after?: string;
    signal?: AbortSignal;
    onBatch?: Parameters<typeof importAuthorizedCommonsLogos>[1]["onBatch"];
  },
) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(600_000)])
    : AbortSignal.timeout(600_000);
  signal.throwIfAborted();
  const userId = requireLogoAccount(store.accounts, options.userId);
  const rightsReference = logoRightsReferenceSchema.parse(
    options.rightsReference,
  );
  const logoChoices = authorizedLogoChoicesSchema.parse(
    options.logoChoices ?? [],
  );
  if (options.after && !/^Q[1-9]\d{0,11}$/.test(options.after))
    throw new Error("Invalid public logo continuation cursor");
  const references = merchantCatalogueReferences(store);
  const entities = new Set(
    [...references.values()].map((merchant) => merchant.wikidataId),
  );
  const choices = new Set<string>();
  for (const choice of logoChoices) {
    if (!entities.has(choice.wikidataId) || choices.has(choice.wikidataId))
      throw new Error(
        "Logo choices require unique known public merchant identities",
      );
    choices.add(choice.wikidataId);
  }
  new MerchantIndex([...references.values()]);
  store.upsertMerchants(seedMerchants);
  const maxPasses =
    Math.ceil(references.size / MAX_AUTHORIZED_LOGO_ENTITIES) + 1;
  const reports: Awaited<ReturnType<typeof importAuthorizedCommonsLogos>>[] =
    [];
  let after = options.after;
  for (let pass = 0; pass < maxPasses; pass++) {
    signal.throwIfAborted();
    const report = await importAuthorizedCommonsLogos(store, {
      ...options,
      userId,
      rightsReference,
      logoChoices,
      signal,
      after,
    });
    reports.push(report);
    if (!report.remaining)
      return {
        references: store.loadMerchants().length,
        processed: reports.reduce((sum, item) => sum + item.processed, 0),
        imported: reports.reduce((sum, item) => sum + item.imported, 0),
        cached: reports.reduce((sum, item) => sum + item.cached, 0),
        publicCached: reports.reduce((sum, item) => sum + item.publicCached, 0),
        skipped: reports.reduce((sum, item) => sum + item.skipped, 0),
        entities: reports.flatMap((item) => item.entities),
      };
    if (!report.nextAfter || (after && report.nextAfter <= after))
      throw new Error("Logo completion cursor did not advance");
    after = report.nextAfter;
  }
  throw new Error(
    "Catalogue changed beyond the bounded completion window; resume from the last reported cursor",
  );
}
