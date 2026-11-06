"use client";

import { useMemo, useState } from "react";
import { CopyCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { applyBulkReview, bulkReviewGroups, type BulkReviewGroup } from "@/lib/import/bulk-review";
import { categoryGroups } from "@/lib/categories";
import { currency } from "@/lib/format";
import type { Category } from "@/lib/types";

function BulkReviewRow({ group, disabled }: { group: BulkReviewGroup; disabled: boolean }) {
  const { state, update } = useFinance();
  const [category, setCategory] = useState<Category | "">(group.category === "Prüfen" ? "" : group.category);
  const id = `bulk-${group.key}`;
  function apply() {
    if (!category) return;
    const result = applyBulkReview(state, group.ids, category);
    if (!result.applied.length) {
      toast.error("Diese Buchungen konnten nicht gesammelt übernommen werden – bitte einzeln prüfen.");
      return;
    }
    update((current) => applyBulkReview(current, group.ids, category).state);
    toast.success(`${result.applied.length} ${result.applied.length === 1 ? "Buchung" : "Buchungen"} als ${category} übernommen` +
      (result.skipped.length ? ` · ${result.skipped.length} bitte einzeln prüfen` : ""));
  }
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-background/50 p-3">
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm font-medium">{group.count} × {group.label}</span>
        <FinancialData as="span" className="block text-2xs text-muted-foreground">zusammen {currency(group.total)}</FinancialData>
      </span>
      <label htmlFor={id} className="sr-only">Kategorie für {group.label}</label>
      <select id={id} value={category} disabled={disabled} onChange={(event) => setCategory(event.target.value as Category)}
        className="min-h-9 max-w-52 rounded-md border border-input bg-background px-2 text-sm">
        <option value="">Kategorie wählen …</option>
        {categoryGroups.map((entry) => <optgroup key={entry.label} label={entry.label}>
          {entry.categories.filter((name) => name !== "Prüfen").map((name) => <option key={name} value={name}>{name}</option>)}
        </optgroup>)}
      </select>
      <Button type="button" size="sm" className="min-h-9" disabled={disabled || !category} onClick={apply}>
        {group.count === 2 ? "Beide" : `Alle ${group.count}`} übernehmen
      </Button>
    </li>
  );
}

/** "2 Buchungen von X → beide korrigieren" instead of reviewing each one. */
export function BulkReviewPanel({ disabled }: { disabled: boolean }) {
  const { state } = useFinance();
  const groups = useMemo(() => bulkReviewGroups(state), [state]);
  if (!groups.length) return null;
  return (
    <section aria-labelledby="bulk-review-title" className="mb-4 rounded-2xl border border-orange-500/20 bg-orange-500/5 p-4">
      <h2 id="bulk-review-title" className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <CopyCheck aria-hidden="true" className="size-4 text-orange-700 dark:text-orange-300" />Sammel-Korrekturen
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">Gleiche Händler mit offener Prüfung – mit einem Klick gemeinsam zuordnen.</p>
      <ul className="space-y-2">
        {groups.slice(0, 8).map((group) => <BulkReviewRow key={`${group.key}|${group.ids.join(",")}`} group={group} disabled={disabled} />)}
      </ul>
    </section>
  );
}
