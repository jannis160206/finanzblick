"use client";

import Link from "next/link";
import { useMemo, type ComponentType } from "react";
import { ArrowRight, CircleCheck, CopyCheck, CreditCard, Landmark, ListChecks, PiggyBank, Target, TrendingDown } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { detectDuplicateCharges } from "@/lib/insights";
import { accountForecast } from "@/lib/assistant/forecast";
import { budgetSuggestions } from "@/lib/budget-suggestions";
import { cleanMerchantName } from "@/lib/merchant-display";
import { currency, dateLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { askAssistant } from "@/lib/assistant-bus";

export type OverviewTodo = {
  id: string;
  title: string;
  detail?: string;
  href: string;
  /** Opens the assistant panel with this question instead of navigating. */
  ask?: string;
  action: string;
  tone: "warn" | "info";
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
};

const daysBefore = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
};

/** One list for everything that needs a decision: reviews, double charges, Amex, transfers, goals, Giro, budget. */
export function useOverviewTodos(): OverviewTodo[] {
  const { state, dashboard: d, openReviewCount } = useFinance();
  return useMemo(() => computeOverviewTodos(state, d, openReviewCount), [state, d, openReviewCount]);
}

function computeOverviewTodos(
  state: ReturnType<typeof useFinance>["state"],
  d: ReturnType<typeof useFinance>["dashboard"],
  openReviewCount: number,
): OverviewTodo[] {
  {
    const todos: OverviewTodo[] = [];
    const asOf = state.settings.asOf;
    if (openReviewCount > 0) todos.push({
      id: "reviews", icon: ListChecks, tone: "warn", href: "/umsaetze?pruefen=1", action: "Prüfen",
      title: `${openReviewCount} ${openReviewCount === 1 ? "Buchung" : "Buchungen"} prüfen`,
      detail: "Kategorie oder Händler unsicher – ähnliche Buchungen lassen sich gesammelt korrigieren.",
    });
    for (const duplicate of detectDuplicateCharges(state, daysBefore(asOf, 45)).slice(0, 3)) todos.push({
      id: `duplicate-${duplicate.ids.join("-")}`, icon: CopyCheck, tone: "warn", href: "/umsaetze", action: "Ansehen",
      title: `Doppelt abgebucht? ${cleanMerchantName(duplicate.merchant)} · ${currency(duplicate.amount)}`,
      detail: `${dateLabel(duplicate.dates[0])} und ${dateLabel(duplicate.dates[1])}`,
    });
    if (d.current.amexOpen > 0.005) todos.push({
      id: "amex", icon: CreditCard, tone: "info", href: "/budget", action: "Details",
      title: `${currency(d.current.amexOpen)} auf Amex Rückzahlung überweisen`,
      detail: `Kartensaldo ${currency(d.amex.outstanding)} · bereits zurückgelegt ${currency(d.amex.reserved)}`,
    });
    for (const item of d.monthlyFunding.filter((entry) => !entry.done && entry.amount > 0.005)) todos.push({
      id: `funding-${item.id}`, icon: PiggyBank, tone: "info", href: "/sparen", action: "Sparen",
      title: `${currency(item.amount - (item.transferred ?? 0))} auf ${item.name} überweisen`,
      detail: "Sparrate diesen Monat noch nicht erkannt.",
    });
    if (d.goals.length && !d.countdown.onTrack && !d.countdown.funded) todos.push({
      id: "goal", icon: Target, tone: "warn", href: "/sparen#sparziele", action: "Anpassen",
      title: d.countdown.overdue ? "Sparziel-Termin überschritten" : "Sparziel braucht eine höhere Rate",
      detail: `Benötigt ${currency(d.countdown.required)} pro Monat, geplant ${currency(d.nextTransfer)}.`,
    });
    try {
      const low = accountForecast(state, d, asOf).giro.lows[0];
      if (low) todos.push({
        id: "giro", icon: Landmark, tone: "warn", href: "", ask: "Wann wird mein Girokonto knapp?", action: "Prognose",
        title: `Girokonto wird am ${dateLabel(low.date)} knapp`,
        detail: `${currency(low.balance)}${low.cause?.label ? ` · ${low.cause.label}` : ""}`,
      });
    } catch {
      // The forecast is a hint only; missing data must not break the overview.
    }
    for (const suggestion of budgetSuggestions(state, asOf).slice(0, 2)) todos.push({
      id: `budget-${suggestion.id}`, icon: TrendingDown, tone: "info", href: "/budget", action: "Budget",
      title: suggestion.title, detail: suggestion.detail,
    });
    return todos;
  }
}

export function OverviewTodos() {
  const todos = useOverviewTodos();
  return (
    <section className="panel mb-5 min-w-0 p-4 sm:p-5" aria-labelledby="overview-todos-title">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="overview-todos-title" className="flex items-center gap-2 text-sm font-semibold">
          <ListChecks aria-hidden="true" className="size-4 text-muted-foreground" />Zu erledigen
        </h2>
        {todos.length > 0 && <span className="status-pill border text-muted-foreground">{todos.length}</span>}
      </div>
      {todos.length ? (
        <FinancialData as="ul" className="divide-y divide-border/60">
          {todos.map((todo) => (
            <li key={todo.id} data-todo={todo.id} className="flex min-w-0 items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg",
                todo.tone === "warn" ? "bg-orange-500/10 text-orange-700 dark:text-orange-300" : "bg-primary/10 text-primary")}>
                <todo.icon aria-hidden={true} className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block break-words text-sm font-medium">{todo.title}</span>
                {todo.detail && <span className="mt-0.5 block break-words text-2xs text-muted-foreground">{todo.detail}</span>}
              </span>
              {todo.ask ? (
                <button type="button" onClick={() => askAssistant(todo.ask!)} aria-label={`${todo.action}: ${todo.title}`}
                  className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-9">
                  {todo.action}<ArrowRight aria-hidden="true" className="size-3" />
                </button>
              ) : <Link href={todo.href} aria-label={`${todo.action}: ${todo.title}`}
                className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring sm:min-h-9">
                {todo.action}<ArrowRight aria-hidden="true" className="size-3" />
              </Link>}
            </li>
          ))}
        </FinancialData>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleCheck aria-hidden="true" className="size-4 text-emerald-600 dark:text-emerald-400" />Alles erledigt – nichts offen.
        </p>
      )}
    </section>
  );
}
