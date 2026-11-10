"use client";

import { useEffect } from "react";

/** What the user is looking at right now; it stays in the browser and is never sent to the model. */
export type AssistantPageContext = {
  route: string;
  title: string;
  month?: string;
  /** Human-readable active filters, e.g. "Kategorie: Restaurants". */
  filters?: string[];
  /** Bookings currently shown (after filters), newest first; capped. */
  visibleIds?: string[];
  visibleCount?: number;
  /** Bookings the user selected. */
  selectedIds?: string[];
  /** The contract opened in the contract folder. */
  contractId?: string;
};

const MAX_IDS = 2_000;
let current: AssistantPageContext | null = null;

export function publishAssistantContext(context: AssistantPageContext | null) {
  current = context && {
    ...context,
    ...(context.visibleIds ? { visibleIds: context.visibleIds.slice(0, MAX_IDS), visibleCount: context.visibleCount ?? context.visibleIds.length } : {}),
    ...(context.selectedIds ? { selectedIds: context.selectedIds.slice(0, MAX_IDS) } : {}),
  };
}

export const currentAssistantContext = () => current;

/** Pages report their state; the context is cleared again when the page goes away. */
export function useAssistantPageContext(context: AssistantPageContext | null) {
  useEffect(() => {
    publishAssistantContext(context);
    return () => publishAssistantContext(null);
  }, [context]);
}
