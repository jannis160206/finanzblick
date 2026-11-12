"use client";

import { startTransition, useEffect, useState } from "react";
import { useFinance } from "@/components/finance-provider";
import { computeDashboardExtras, type DashboardExtras } from "@/lib/dashboard-extras";
import { runFinanceTask } from "@/lib/finance-worker";
import type { AppState } from "@/lib/types";
import { figuresOf } from "@/lib/assistant-state";

const results = new WeakMap<AppState, DashboardExtras>();
const requests = new WeakMap<AppState, Promise<DashboardExtras>>();

// All cards share one computation per set of figures; a chat message or a learned phrase needs none.
function requestExtras(state: AppState): Promise<DashboardExtras> | null {
  const figures = figuresOf(state);
  const existing = requests.get(figures);
  if (existing) return existing;
  const task = runFinanceTask<DashboardExtras>({ kind: "extras", state });
  if (!task) return null;
  const promise = task.then((extras) => {
    results.set(figures, extras);
    return extras;
  });
  requests.set(figures, promise);
  return promise;
}

/** Ledger-wide figures for the dashboard cards; the previous result stays visible while a newer state is computed. */
export function useDashboardExtras(): DashboardExtras | null {
  const { state, dashboard, ready } = useFinance();
  const [current, setCurrent] = useState<{ state: AppState; extras: DashboardExtras } | null>(() => {
    const cached = results.get(figuresOf(state));
    return cached ? { state, extras: cached } : null;
  });
  useEffect(() => {
    if (!ready || current && figuresOf(current.state) === figuresOf(state)) return;
    let active = true;
    // The cards below the fold may render in slices instead of one long task.
    const publish = (extras: DashboardExtras) => { if (active) startTransition(() => setCurrent({ state, extras })); };
    const compute = () => {
      const extras = results.get(figuresOf(state)) ?? computeDashboardExtras(state, dashboard);
      results.set(figuresOf(state), extras);
      publish(extras);
    };
    const pending = results.has(figuresOf(state)) ? null : requestExtras(state);
    if (pending) pending.then(publish, compute);
    else compute();
    return () => { active = false; };
  }, [ready, state, dashboard, current]);
  return current?.extras ?? null;
}
