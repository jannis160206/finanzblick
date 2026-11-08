"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  useAccountWorkspace,
  type AccountWorkspace,
} from "@/components/account-context";
import {
  MAX_MERCHANT_MARKS,
  MAX_MERCHANT_MARKS_BYTES,
  merchantMarksRequestSchema,
  merchantMarksResponseSchema,
  merchantLogoNameSchema,
  type MerchantPresentation,
} from "@/lib/automation/merchant-presentation-schema";
import {
  merchantNameMarkKey,
  merchantBookingMarkKey,
} from "@/lib/automation/merchant-mark-name";
import { Button } from "@/components/ui/button";
import { z } from "zod";

type MerchantLogo = NonNullable<MerchantPresentation["logo"]> & {
  refreshVersion?: number;
};
type MerchantMarks = ReadonlyMap<string, MerchantLogo | null>;
const MerchantMarksContext = createContext<MerchantMarks | null>(null);
const MerchantLogoFailureContext = createContext<(() => void) | null>(null);

const CACHE_LIMIT = 500;
const RESPONSE_LIMIT = 64 * 1024;
const FOCUS_REFRESH_INTERVAL = 30_000;
/** Dispatched on window after new logo files were stored, so visible marks reload at once. */
export const MERCHANT_LOGOS_CHANGED = "finanzblick:merchant-logos-changed";
const MAX_CONCURRENT_BATCHES = 3;
type WorkspaceMarksCache = {
  accountId: string;
  marks: Map<string, MerchantLogo | null>;
  fetchedAt: Map<string, number>;
  loadedRevision: Map<string, number>;
  invalidated: Set<string>;
};
const workspaceCaches = new WeakMap<AccountWorkspace, WorkspaceMarksCache>();
let nextRequestRevision = 0;

function workspaceCache(workspace: AccountWorkspace | null) {
  const previous = workspace && workspaceCaches.get(workspace);
  if (previous && previous.accountId === workspace?.user.id) return previous;
  const cache: WorkspaceMarksCache = {
    accountId: workspace?.user.id ?? "",
    marks: new Map(),
    fetchedAt: new Map(),
    loadedRevision: new Map(),
    invalidated: new Set(),
  };
  if (workspace) workspaceCaches.set(workspace, cache);
  return cache;
}

const responseEnvelopeSchema = z
  .object({
    marks: merchantMarksResponseSchema.shape.marks,
    nameMarks: z.unknown().optional(),
    bookingMarks: z.unknown().optional(),
  })
  .strict();
const ERROR_MESSAGE = "Einige Logos fehlen.";

function markBatches(keys: string[]) {
  const encoder = new TextEncoder();
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 64;
  for (const key of keys) {
    const value = key.startsWith("name:")
      ? key.slice(5)
      : key.startsWith("booking:")
        ? key.slice(8)
        : key;
    const size = encoder.encode(JSON.stringify(value)).byteLength + 1;
    if (
      batch.length === MAX_MERCHANT_MARKS ||
      bytes + size > MAX_MERCHANT_MARKS_BYTES
    ) {
      batches.push(batch);
      batch = [];
      bytes = 64;
    }
    batch.push(key);
    bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function useMerchantMarks() {
  return useContext(MerchantMarksContext);
}

export function useMerchantLogoFailure() {
  return useContext(MerchantLogoFailureContext);
}

async function readMarksResponse(response: Response) {
  if (!response.ok) throw new Error("Merchant marks request failed");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Merchant marks response is empty");
  const decoder = new TextDecoder();
  let length = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT)
        throw new Error("Merchant marks response exceeds its limit");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return responseEnvelopeSchema.parse(JSON.parse(body));
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}

export function MerchantMarksProvider({
  merchantIds,
  merchantNames = [],
  bookingIds = [],
  children,
}: {
  merchantIds: string[];
  merchantNames?: string[];
  bookingIds?: string[];
  children: ReactNode;
}) {
  const workspace = useAccountWorkspace();
  // A new account must never see metadata or image failures from the old one.
  return (
    <AccountMerchantMarks
      key={workspace ? `account:${workspace.user.id}` : "local"}
      workspace={workspace}
      merchantIds={merchantIds}
      merchantNames={merchantNames}
      bookingIds={bookingIds}
    >
      {children}
    </AccountMerchantMarks>
  );
}

function AccountMerchantMarks({
  workspace,
  merchantIds,
  merchantNames,
  bookingIds,
  children,
}: {
  workspace: AccountWorkspace | null;
  merchantIds: string[];
  merchantNames: string[];
  bookingIds: string[];
  children: ReactNode;
}) {
  const enabled = !!workspace;
  const [cache] = useState(() => workspaceCache(workspace));
  const lastFocusRefresh = useRef(-Infinity);
  const imageFailed = useRef(false);
  const [marks, setMarks] = useState<MerchantMarks>(() => new Map(cache.marks));
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const idsKey = JSON.stringify(
    [
      ...new Set([
        ...merchantIds.filter(
          (id) =>
            id === id.trim() &&
            merchantMarksRequestSchema.shape.merchantIds.element.safeParse(id)
              .success,
        ),
        ...merchantNames
          .filter(
            (name) =>
              name === name.trim() &&
              merchantLogoNameSchema.safeParse(name).success,
          )
          .map(merchantNameMarkKey),
        ...bookingIds
          .filter(
            (id) =>
              merchantMarksRequestSchema.shape.bookingIds
                .unwrap()
                .element.safeParse(id).success,
          )
          .map(merchantBookingMarkKey),
      ]),
    ]
      .slice(0, CACHE_LIMIT)
      .sort(),
  );

  const refreshMarks = useCallback(() => {
    imageFailed.current = false;
    for (const key of JSON.parse(idsKey) as string[])
      cache.invalidated.add(key);
    setRefreshVersion((version) => version + 1);
  }, [cache, idsKey]);
  const reportImageFailure = useCallback(() => {
    imageFailed.current = true;
    setError(true);
  }, []);

  useEffect(() => {
    // Context values may be recreated while this same account stays mounted.
    if (workspace) workspaceCaches.set(workspace, cache);
  }, [workspace, cache]);

  useEffect(() => {
    if (!enabled) return;
    function onReturn() {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFocusRefresh.current < FOCUS_REFRESH_INTERVAL) return;
      lastFocusRefresh.current = now;
      refreshMarks();
    }
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener(MERCHANT_LOGOS_CHANGED, refreshMarks);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener(MERCHANT_LOGOS_CHANGED, refreshMarks);
    };
  }, [enabled, refreshMarks]);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const visibleIds = new Set(JSON.parse(idsKey) as string[]);
    for (const key of cache.invalidated)
      if (!visibleIds.has(key)) cache.invalidated.delete(key);
    const ids = [...visibleIds].filter(
      (id) =>
        !cache.marks.has(id) ||
        cache.invalidated.has(id) ||
        Date.now() - (cache.fetchedAt.get(id) ?? -Infinity) >=
          FOCUS_REFRESH_INTERVAL,
    );
    if (!ids.length) {
      void Promise.resolve().then(() => {
        if (active) setLoading(false);
      });
      return () => {
        active = false;
      };
    }
    const controller = new AbortController();
    const requestRevision = ++nextRequestRevision;
    const timeout = setTimeout(() => controller.abort(), 15_000);

    function remember(entries: [string, MerchantLogo | null][]) {
      if (!active || controller.signal.aborted) return;
      for (const [id, logo] of entries) {
        // Another mounted view may have already received a newer response.
        if ((cache.loadedRevision.get(id) ?? 0) > requestRevision) continue;
        cache.marks.set(id, logo ? { ...logo, refreshVersion } : null);
        cache.fetchedAt.set(id, Date.now());
        cache.loadedRevision.set(id, requestRevision);
        cache.invalidated.delete(id);
      }
      for (const id of cache.marks.keys()) {
        if (cache.marks.size <= CACHE_LIMIT) break;
        if (!visibleIds.has(id)) {
          cache.marks.delete(id);
          cache.fetchedAt.delete(id);
          cache.loadedRevision.delete(id);
          cache.invalidated.delete(id);
        }
      }
      setMarks(new Map(cache.marks));
    }

    function rememberReferences(
      requested: string[],
      entries: { key: string; logo: MerchantLogo | null }[] | undefined,
      keyFor: (key: string) => string,
      requireComplete = false,
    ) {
      if (requested.length && !entries) return false;
      const available = new Map<string, MerchantLogo | null>();
      for (const mark of entries ?? []) {
        if (!requested.includes(mark.key) || available.has(mark.key))
          return false;
        available.set(mark.key, mark.logo);
      }
      if (requireComplete && requested.some((key) => !available.has(key)))
        return false;
      remember(
        requested.map((key) => [keyFor(key), available.get(key) ?? null]),
      );
      return true;
    }

    async function load() {
      // Deferring prevents Strict Mode's discarded effect from sending a batch.
      await Promise.resolve();
      if (!active) return;
      setLoading(true);
      try {
        const batches = markBatches(ids);
        let nextBatch = 0;
        let failed = false;
        async function loadBatch(batch: string[]) {
          const merchantIds = batch.filter(
            (key) => !key.startsWith("name:") && !key.startsWith("booking:"),
          );
          const merchantNames = batch
            .filter((key) => key.startsWith("name:"))
            .map((key) => key.slice(5));
          const bookingIds = batch
            .filter((key) => key.startsWith("booking:"))
            .map((key) => key.slice(8));
          const response = await fetch("/api/merchants/marks", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              merchantIds,
              ...(merchantNames.length ? { merchantNames } : {}),
              ...(bookingIds.length ? { bookingIds } : {}),
            }),
            signal: controller.signal,
          });
          if (!active || controller.signal.aborted) return;
          const result = await readMarksResponse(response);
          if (!active || controller.signal.aborted) return;
          const available = new Map<string, MerchantLogo | null>();
          for (const mark of result.marks) {
            if (
              !merchantIds.includes(mark.merchantId) ||
              available.has(mark.merchantId)
            )
              throw new Error("Unexpected merchant marks response");
            available.set(mark.merchantId, mark.logo);
          }
          // An incomplete named response must not erase independently valid ID marks.
          remember(merchantIds.map((id) => [id, available.get(id) ?? null]));
          const nameMarks =
            merchantMarksResponseSchema.shape.nameMarks.safeParse(
              result.nameMarks,
            );
          const namesValid =
            nameMarks.success &&
            rememberReferences(
              merchantNames,
              nameMarks.data?.map((mark) => ({
                key: mark.merchantName,
                logo: mark.logo,
              })),
              merchantNameMarkKey,
            );
          const bookingMarks =
            merchantMarksResponseSchema.shape.bookingMarks.safeParse(
              result.bookingMarks,
            );
          const bookingsValid =
            bookingMarks.success &&
            rememberReferences(
              bookingIds,
              bookingMarks.data?.map((mark) => ({
                key: mark.bookingId,
                logo: mark.logo,
              })),
              merchantBookingMarkKey,
              true,
            );
          if (!namesValid || !bookingsValid)
            throw new Error("Incomplete merchant reference marks response");
        }
        async function worker() {
          while (
            active &&
            !controller.signal.aborted &&
            nextBatch < batches.length
          ) {
            const batch = batches[nextBatch++];
            try {
              await loadBatch(batch);
            } catch {
              failed = true;
              if (active) setError(true);
            }
          }
        }
        await Promise.all(
          Array.from(
            { length: Math.min(MAX_CONCURRENT_BATCHES, batches.length) },
            worker,
          ),
        );
        if (active)
          setError(failed || controller.signal.aborted || imageFailed.current);
      } catch {
        if (active) setError(true);
      } finally {
        clearTimeout(timeout);
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [enabled, cache, idsKey, refreshVersion]);

  return (
    <MerchantLogoFailureContext.Provider value={reportImageFailure}>
      <MerchantMarksContext.Provider value={marks}>
        {error && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-muted-foreground sm:px-5"
          >
            <p>{ERROR_MESSAGE}</p>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={loading}
              onClick={refreshMarks}
            >
              Logos erneut laden
            </Button>
          </div>
        )}
        {children}
      </MerchantMarksContext.Provider>
    </MerchantLogoFailureContext.Provider>
  );
}
