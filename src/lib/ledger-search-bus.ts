import type { Category } from "@/lib/types";

export type LedgerSearchRequest = {
  query?: string;
  category?: Category;
};

export const LEDGER_SEARCH_EVENT = "finanzblick:ledger-search";

let pending: LedgerSearchRequest | null = null;

// Hands a search from the global search to the ledger in memory: search texts never enter the URL.
export function requestLedgerSearch(request: LedgerSearchRequest) {
  pending = request;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LEDGER_SEARCH_EVENT));
}

export function takeLedgerSearch(): LedgerSearchRequest | null {
  const request = pending;
  pending = null;
  return request;
}
