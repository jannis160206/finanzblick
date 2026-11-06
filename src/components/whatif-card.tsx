"use client";

import { useId, useState } from "react";
import { PiggyBank } from "lucide-react";
import { Button } from "@/components/ui/button";
import { previewChange, type AgentResult } from "@/lib/assistant/agent";
import { computeWhatIf } from "@/lib/assistant/whatif";
import { currency, monthLabel } from "@/lib/format";
import type { AppState, AssistantWhatIf } from "@/lib/types";
import { cn } from "@/lib/utils";

// Live what-if: sliders and toggles recompute in the browser; nothing is saved unless the new rate is confirmed.
export function WhatIfCard({ data, state, onResult }: { data: AssistantWhatIf; state: AppState; onResult?: (result: AgentResult) => void }) {
  const id = useId();
  const [extra, setExtra] = useState(data.extra);
  const [cancel, setCancel] = useState(() => data.subscriptions.map((item) => item.cancel));
  const outcome = computeWhatIf(data, extra, cancel);
  const max = Math.max(1000, Math.ceil(data.extra / 100) * 200);
  const goal = data.goal;
  const adopt = () => {
    if (!goal || goal.monthly === undefined || !onResult) return;
    const monthly = Math.round((goal.monthly + outcome.freed) * 100) / 100;
    onResult(previewChange(state, [{ op: "goal_update", goalId: goal.id, monthly }], `Sparrate für „${goal.name}“ auf ${currency(monthly)} erhöhen`, state.settings.asOf));
  };
  return <div className="mt-3 space-y-3 rounded-xl border border-border/60 bg-background/60 p-3">
    <div className="space-y-1">
      <div className="flex justify-between gap-3 text-xs"><label htmlFor={`${id}-extra`} className="text-muted-foreground">Mehr sparen pro Monat</label>
        <span className="font-medium tabular-nums">{currency(extra)}</span></div>
      <input id={`${id}-extra`} type="range" min={0} max={max} step={10} value={Math.min(max, extra)} aria-valuetext={currency(extra)}
        onChange={(event) => setExtra(Number(event.target.value))} className="h-6 w-full cursor-pointer accent-primary" />
    </div>
    {data.subscriptions.length > 0 && <fieldset>
      <legend className="text-xs text-muted-foreground">Kündigen</legend>
      <ul className="mt-1 grid gap-1 sm:grid-cols-2">
        {data.subscriptions.map((item, index) => <li key={`${item.name}-${index}`}>
          <label className="flex min-h-9 cursor-pointer items-center justify-between gap-2 rounded-lg px-2 text-sm hover:bg-muted">
            <span className="flex min-w-0 items-center gap-2">
              <input type="checkbox" className="size-4 accent-primary" checked={cancel[index] ?? false}
                onChange={(event) => setCancel((current) => current.map((value, position) => position === index ? event.target.checked : value))} />
              <span className="truncate">{item.name}</span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{currency(item.monthly)}</span>
          </label>
        </li>)}
      </ul>
    </fieldset>}
    <dl className="grid grid-cols-2 gap-2 text-sm" aria-live="polite">
      <div><dt className="text-2xs uppercase tracking-wide text-muted-foreground">Mehr pro Monat</dt><dd className="font-semibold tabular-nums text-primary">{currency(outcome.freed)}</dd></div>
      <div><dt className="text-2xs uppercase tracking-wide text-muted-foreground">Pro Jahr</dt><dd className="font-semibold tabular-nums">{currency(outcome.yearly)}</dd></div>
      {goal && <div className="col-span-2">
        <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{goal.name} ({currency(goal.target)}) erreicht</dt>
        <dd className={cn("font-semibold", outcome.after && outcome.onTime === false && "text-amber-700 dark:text-amber-400")}>
          {outcome.after ? monthLabel(outcome.after) : "nicht absehbar"}
          {outcome.before && outcome.after && outcome.before !== outcome.after && <span className="font-normal text-muted-foreground"> statt {monthLabel(outcome.before)}{outcome.earlier ? ` · ${outcome.earlier} ${outcome.earlier === 1 ? "Monat" : "Monate"} früher` : ""}</span>}
          {!outcome.before && outcome.after && <span className="font-normal text-muted-foreground"> · bisher nicht absehbar</span>}
        </dd>
      </div>}
    </dl>
    {goal?.monthly !== undefined && onResult && outcome.freed > 0 && <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={adopt}>
      <PiggyBank aria-hidden="true" className="size-4" />Als Sparrate übernehmen
    </Button>}
  </div>;
}
