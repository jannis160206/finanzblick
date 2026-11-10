"use client";

import { startTransition, useEffect, useState } from "react";
import { useFinance } from "@/components/finance-provider";
import { computeDashboardExtras, type DashboardExtras } from "@/lib/dashboard-extras";
import { runFinanceTask } from "@/lib/finance-worker";
import type { AppState } from "@/lib/types";

const results = new WeakMap<AppState, DashboardExtras>();
const requests = new WeakMap<AppState, Promise<DashboardExtras>>();

// All cards share one computation per state object.
function requestExtras(state: AppState): Promise<DashboardExtras> | null {
  const existing = requests.get(state);
  if (existing) return existing;
  const task = runFinanceTask<DashboardExtras>({ kind: "extras", state });
  if (!task) return null;
  const promise = task.then((extras) => {
    results.set(state, extras);
    return extras;
  });
  requests.set(state, promise);
  return promise;
}

/** Ledger-wide figures for the dashboard cards; the previous result stays visible while a newer state is computed. */
export function useDashboardExtras(): DashboardExtras | null {
  const { state, dashboard, ready } = useFinance();
  const [current, setCurrent] = useState<{ state: AppState; extras: DashboardExtras } | null>(() => {
    const cached = results.get(state);
    return cached ? { state, extras: cached } : null;
  });
  useEffect(() => {
    if (!ready || current?.state === state) return;
    let active = true;
    // The cards below the fold may render in slices instead of one long task.
    const publish = (extras: DashboardExtras) => { if (active) startTransition(() => setCurrent({ state, extras })); };
    const compute = () => {
      const extras = results.get(state) ?? computeDashboardExtras(state, dashboard);
      results.set(state, extras);
      publish(extras);
    };
    const pending = results.has(state) ? null : requestExtras(state);
    if (pending) pending.then(publish, compute);
    else compute();
    return () => { active = false; };
  }, [ready, state, dashboard, current]);
  return current?.extras ?? null;
}
