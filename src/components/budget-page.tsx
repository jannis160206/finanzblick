"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { Lightbulb, MessageSquareText } from "lucide-react";
import { Months } from "@/components/months";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { Button } from "@/components/ui/button";
import { budgetSuggestions } from "@/lib/budget-suggestions";
import { askAssistant } from "@/lib/assistant-bus";

export function BudgetSuggestionsPanel() {
  const { state } = useFinance();
  const suggestions = useMemo(() => budgetSuggestions(state, state.settings.asOf), [state]);
  if (!suggestions.length) return null;
  return (
    <section className="panel min-w-0 p-4 sm:p-5" aria-labelledby="budget-suggestions-title">
      <h2 id="budget-suggestions-title" className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Lightbulb aria-hidden="true" className="size-4 text-primary" />Budget-Vorschläge
      </h2>
      <FinancialData as="ul" className="space-y-2">
        {suggestions.map((suggestion) => (
          <li key={suggestion.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-background/50 p-3">
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-medium">{suggestion.title}</span>
              <span className="mt-0.5 block break-words text-2xs text-muted-foreground">{suggestion.detail}</span>
            </span>
            <Button type="button" variant="outline" size="sm" className="min-h-9"
              onClick={() => askAssistant(suggestion.title)}>
              <MessageSquareText aria-hidden="true" className="size-3.5" />Anpassen
            </Button>
          </li>
        ))}
      </FinancialData>
    </section>
  );
}

// Budget = former "Monate" (year/month plan) and "Budgetdetails" (Alltagsbudget) in one place.
export function BudgetPage() {
  const year = useSearchParams().get("ansicht") === "jahr";
  return (
    <Months
      key={year ? "jahr" : "monat"}
      title="Budget"
      initialView={year ? "year" : "month"}
      monthExtras={<BudgetSuggestionsPanel />}
    />
  );
}
