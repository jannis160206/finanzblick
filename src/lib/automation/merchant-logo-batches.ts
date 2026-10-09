import { z } from "zod";
import { MAX_IMPORTED_MERCHANTS } from "./merchant-import";
import { refreshMerchantLogos } from "./merchant-logo-refresh";
import { AutomationStore } from "./store";

export const MAX_LOGO_BATCH_ENTITIES = 200;
export async function refreshMerchantLogoBatches(
  store: AutomationStore,
  options: {
    batchSize?: number;
    after?: string;
    refresh?: boolean;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    onBatch?: (progress: {
      processed: number;
      cursor: string;
      remaining: number;
    }) => void;
  } = {},
) {
  const size = z
    .number()
    .int()
    .min(1)
    .max(20)
    .parse(options.batchSize ?? 20);
  const after = z
    .string()
    .regex(/^Q[1-9]\d{0,11}$/)
    .optional()
    .parse(options.after);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(600_000)])
    : AbortSignal.timeout(600_000);
  signal.throwIfAborted();
  const merchants = store.loadMerchants();
  if (merchants.length > MAX_IMPORTED_MERCHANTS)
    throw new RangeError(
      "Merchant index limit reached; no network import started",
    );
  const ids = [
    ...new Set(
      merchants.flatMap((merchant) =>
        merchant.wikidataId ? [merchant.wikidataId] : [],
      ),
    ),
  ]
    .sort()
    .filter((id) => !after || id > after);
  const selected = ids.slice(0, MAX_LOGO_BATCH_ENTITIES);
  const result = {
    downloaded: 0,
    cached: 0,
    skipped: 0,
    updated: 0,
    processed: 0,
    remaining: ids.length - selected.length,
    nextAfter: null as string | null,
    entities: [] as Awaited<
      ReturnType<typeof refreshMerchantLogos>
    >["entities"],
  };
  for (let start = 0; start < selected.length; start += size) {
    signal.throwIfAborted();
    const entities = selected.slice(start, start + size);
    const report = await refreshMerchantLogos(store, {
      entities,
      limit: size,
      refresh: options.refresh,
      signal,
      fetch: options.fetch,
    });
    result.downloaded += report.downloaded;
    result.cached += report.cached;
    result.skipped += report.skipped;
    result.updated += report.updated;
    result.processed += entities.length;
    result.entities.push(...report.entities);
    const cursor = entities[entities.length - 1];
    result.nextAfter = result.remaining ? cursor : null;
    options.onBatch?.({
      processed: result.processed,
      cursor,
      remaining: ids.length - result.processed,
    });
  }
  return result;
}
