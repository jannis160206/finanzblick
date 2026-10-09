"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAccountWorkspace } from "@/components/account-context";
import {
  MAX_MERCHANT_MARKS,
  merchantMarksRequestSchema,
  merchantMarksResponseSchema,
  merchantLogoNameSchema,
  type MerchantPresentation,
} from "@/lib/automation/merchant-presentation-schema";
import { merchantNameMarkKey } from "@/lib/automation/merchant-mark-name";

type MerchantLogo = NonNullable<MerchantPresentation["logo"]>;
type MerchantMarks = ReadonlyMap<string, MerchantLogo | null>;
const MerchantMarksContext = createContext<MerchantMarks | null>(null);

const CACHE_LIMIT = 500;
const RESPONSE_LIMIT = 64 * 1024;
const ERROR_MESSAGE =
  "Händlerlogos konnten nicht geladen werden. Stattdessen werden Initialen angezeigt.";

export function useMerchantMarks() {
  return useContext(MerchantMarksContext);
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
    return merchantMarksResponseSchema.parse(JSON.parse(body));
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
  children,
}: {
  merchantIds: string[];
  merchantNames?: string[];
  children: ReactNode;
}) {
  const workspace = useAccountWorkspace();
  // A new account must never see metadata or image failures from the old one.
  return (
    <AccountMerchantMarks
      key={workspace ? `account:${workspace.user.id}` : "local"}
      enabled={!!workspace}
      merchantIds={merchantIds}
      merchantNames={merchantNames}
    >
      {children}
    </AccountMerchantMarks>
  );
}

function AccountMerchantMarks({
  enabled,
  merchantIds,
  merchantNames,
  children,
}: {
  enabled: boolean;
  merchantIds: string[];
  merchantNames: string[];
  children: ReactNode;
}) {
  const cache = useRef(new Map<string, MerchantLogo | null>());
  const [marks, setMarks] = useState<MerchantMarks>(new Map());
  const [error, setError] = useState(false);
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
      ]),
    ]
      .slice(0, CACHE_LIMIT)
      .sort(),
  );

  useEffect(() => {
    if (!enabled) return;
    const visibleIds = new Set(JSON.parse(idsKey) as string[]);
    const ids = [...visibleIds].filter((id) => !cache.current.has(id));
    if (!ids.length) return;
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => controller.abort(), 15_000);

    function remember(entries: [string, MerchantLogo | null][]) {
      if (!active) return;
      for (const [id, logo] of entries) cache.current.set(id, logo);
      for (const id of cache.current.keys()) {
        if (cache.current.size <= CACHE_LIMIT) break;
        if (!visibleIds.has(id)) cache.current.delete(id);
      }
      setMarks(new Map(cache.current));
    }

    async function load() {
      // Deferring prevents Strict Mode's discarded effect from sending a batch.
      await Promise.resolve();
      if (!active) return;
      try {
        for (let start = 0; start < ids.length; start += MAX_MERCHANT_MARKS) {
          const batch = ids.slice(start, start + MAX_MERCHANT_MARKS);
          const merchantIds = batch.filter((key) => !key.startsWith("name:"));
          const merchantNames = batch
            .filter((key) => key.startsWith("name:"))
            .map((key) => key.slice(5));
          const response = await fetch("/api/merchants/marks", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              merchantIds,
              ...(merchantNames.length ? { merchantNames } : {}),
            }),
            signal: controller.signal,
          });
          if (!active) return;
          const result = await readMarksResponse(response);
          if (!active) return;
          const available = new Map<string, MerchantLogo | null>();
          for (const mark of result.marks) {
            if (
              !merchantIds.includes(mark.merchantId) ||
              available.has(mark.merchantId)
            )
              throw new Error("Unexpected merchant marks response");
            available.set(mark.merchantId, mark.logo);
          }
          if (merchantNames.length && !result.nameMarks)
            throw new Error("Missing named merchant marks response");
          for (const mark of result.nameMarks ?? []) {
            const key = merchantNameMarkKey(mark.merchantName);
            if (
              !merchantNames.includes(mark.merchantName) ||
              available.has(key)
            )
              throw new Error("Unexpected named merchant marks response");
            available.set(key, mark.logo);
          }
          remember(batch.map((id) => [id, available.get(id) ?? null]));
        }
      } catch {
        if (active) {
          remember(ids.map((id) => [id, cache.current.get(id) ?? null]));
          setError(true);
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    void load();
    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [enabled, idsKey]);

  return (
    <MerchantMarksContext.Provider value={marks}>
      {error && (
        <p
          role="status"
          className="px-4 py-2 text-xs text-muted-foreground sm:px-5"
        >
          {ERROR_MESSAGE}
        </p>
      )}
      {children}
    </MerchantMarksContext.Provider>
  );
}
