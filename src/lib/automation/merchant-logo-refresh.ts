import { z } from "zod";
import { MAX_IMPORTED_MERCHANTS } from "./merchant-import";
import { readPrivateMerchantLogo, retrieveMerchantLogo } from "./merchant-logo";
import { AutomationStore } from "./store";

export async function refreshMerchantLogos(
  store: AutomationStore,
  options: {
    limit?: number;
    refresh?: boolean;
    fetch?: typeof fetch;
    signal?: AbortSignal;
    entities?: string[];
  } = {},
) {
  const limit = z
    .number()
    .int()
    .min(1)
    .max(20)
    .parse(options.limit ?? 20);
  const selected = options.entities
    ? new Set(
        z
          .array(z.string().regex(/^Q[1-9]\d{0,11}$/))
          .min(1)
          .max(20)
          .parse(options.entities),
      )
    : null;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(180_000)])
    : AbortSignal.timeout(180_000);
  const merchants = store.loadMerchants();
  if (merchants.length > MAX_IMPORTED_MERCHANTS)
    throw new RangeError(
      "Merchant index limit reached; no network import started",
    );
  const groups = new Map<string, typeof merchants>();
  for (const merchant of merchants) {
    if (!merchant.wikidataId) continue;
    const group = groups.get(merchant.wikidataId) ?? [];
    group.push(merchant);
    groups.set(merchant.wikidataId, group);
  }
  if (selected && [...selected].some((id) => !groups.has(id)))
    throw new Error("Selected logo entity is not in the merchant table.");
  const report = {
    downloaded: 0,
    cached: 0,
    skipped: 0,
    updated: 0,
    remaining: 0,
    entities: [] as { wikidataId: string; status: string; reason?: string }[],
  };
  let requests = 0;
  for (const [wikidataId, references] of groups) {
    if (selected && !selected.has(wikidataId)) continue;
    signal.throwIfAborted();
    let cached = null;
    if (!options.refresh)
      for (const reference of references) {
        if (
          reference.logo &&
          (await readPrivateMerchantLogo(store.accounts.path, reference.logo))
        ) {
          cached = reference.logo;
          break;
        }
      }
    if (!cached && requests >= limit) {
      report.remaining++;
      continue;
    }
    const result = cached
      ? { status: "downloaded" as const, logo: cached }
      : await retrieveMerchantLogo(wikidataId, store.accounts.path, {
          fetch: options.fetch,
          signal,
          retries: 2,
        });
    if (!cached) requests++;
    if (result.status === "skipped") {
      report.skipped++;
      report.entities.push({
        wikidataId,
        status: "skipped",
        reason: result.reason,
      });
    } else {
      if (cached) report.cached++;
      else report.downloaded++;
      report.entities.push({
        wikidataId,
        status: cached ? "cached" : "downloaded",
      });
    }
    for (const reference of references) {
      if (result.status === "skipped" && !options.refresh) continue;
      const logo = result.status === "downloaded" ? result.logo : null;
      if (JSON.stringify(reference.logo) === JSON.stringify(logo)) continue;
      if (!store.updateMerchantLogo(reference, logo))
        throw new Error(
          "Merchant changed during logo refresh; rerun the bounded import.",
        );
      report.updated++;
    }
  }
  return report;
}
