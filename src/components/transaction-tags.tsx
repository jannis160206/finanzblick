"use client";

import { useMemo, useState } from "react";
import { Tag, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, PremiumDialog, PremiumDialogBody, PremiumDialogContent, PremiumDialogFooter, PremiumDialogHeader, PremiumDialogItem } from "@/components/ui/premium-dialog";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { allTags, setTag, tagSummaries } from "@/lib/tags";
import { currency, dateLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

export function TagDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { state, update } = useFinance();
  const [value, setValue] = useState("");
  const known = useMemo(() => allTags(state), [state]);
  const selectedTags = useMemo(() => {
    const set = new Set(ids);
    return allTags({ ...state, transactions: state.transactions.filter((row) => set.has(row.id)) });
  }, [state, ids]);
  function apply(tag: string, remove = false) {
    if (!tag.trim()) return;
    update((current) => setTag(current, new Set(ids), tag, remove));
    toast.success(remove ? `Tag „${tag}“ entfernt` : `${ids.length} ${ids.length === 1 ? "Buchung" : "Buchungen"} mit „${tag.replace(/^#+/, "").trim()}“ markiert`);
    if (!remove) onClose();
  }
  return (
    <PremiumDialog open onOpenChange={(open) => !open && onClose()}>
      <PremiumDialogContent size="sm">
        <PremiumDialogHeader icon={Tag} title="Tag vergeben"
          description={`${ids.length === 1 ? "1 Buchung" : `${ids.length} Buchungen`} über Kategorien hinweg zusammenfassen, z. B. eine Reise „Malaga 2026“.`} />
        <form id="tag-form" onSubmit={(event) => { event.preventDefault(); apply(value); }} className="flex min-h-0 flex-1 flex-col">
          <PremiumDialogBody className="space-y-5">
          <Field label="Tag" hint="Neuen Namen eingeben oder einen vorhandenen Tag antippen.">
            <Input autoFocus list="known-tags" maxLength={40} value={value} onChange={(event) => setValue(event.target.value)} placeholder="z. B. Malaga 2026" />
          </Field>
          <datalist id="known-tags">{known.map((tag) => <option key={tag} value={tag} />)}</datalist>
          {known.length > 0 && <PremiumDialogItem className="space-y-2">
            <h3 className="eyebrow">Vorhandene Tags</h3>
            <div className="flex flex-wrap gap-1.5" aria-label="Vorhandene Tags">
              {known.map((tag) => <button key={tag} type="button" onClick={() => apply(tag)}
                className="min-h-9 rounded-full border border-border/70 bg-card px-3.5 text-xs font-medium transition-[border-color,color,scale] duration-150 ease-soft hover:border-primary/40 hover:text-primary active:scale-95 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none">#{tag}</button>)}
            </div>
          </PremiumDialogItem>}
          {selectedTags.length > 0 && <PremiumDialogItem className="space-y-2 border-t border-border/60 pt-4">
            <h3 className="eyebrow">Entfernen</h3>
            <div className="flex flex-wrap items-center gap-1.5">
              {selectedTags.map((tag) => <button key={tag} type="button" onClick={() => apply(tag, true)} aria-label={`Tag ${tag} entfernen`}
                className="inline-flex min-h-9 items-center gap-1 rounded-full bg-primary/10 px-3.5 text-xs font-medium text-primary transition-[background-color,color,scale] duration-150 ease-soft hover:bg-destructive/10 hover:text-destructive active:scale-95 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:transition-none">#{tag}<X aria-hidden="true" className="size-3" /></button>)}
            </div>
          </PremiumDialogItem>}
          </PremiumDialogBody>
        </form>
        <PremiumDialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>Abbrechen</Button>
          <Button type="submit" form="tag-form" disabled={!value.trim()}>Tag vergeben</Button>
        </PremiumDialogFooter>
      </PremiumDialogContent>
    </PremiumDialog>
  );
}

/** Per-tag totals across categories; clicking a tag filters the ledger. */
export function TagSummaryPanel({ query, onSelect }: { query: string; onSelect: (query: string) => void }) {
  const { state } = useFinance();
  const summaries = useMemo(() => tagSummaries(state), [state]);
  if (!summaries.length) return null;
  const active = summaries.find((entry) => query.trim().toLocaleLowerCase("de") === `#${entry.tag}`.toLocaleLowerCase("de"));
  return (
    <section aria-label="Tags und Reisen" className="mb-4 rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Tag aria-hidden="true" className="size-3.5" />Tags</span>
        {summaries.map((entry) => {
          const selected = entry === active;
          return <button key={entry.tag} type="button" aria-pressed={selected} onClick={() => onSelect(selected ? "" : `#${entry.tag}`)}
            className={cn("inline-flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs focus-visible:outline-2 focus-visible:outline-ring",
              selected ? "border-primary/40 bg-primary/10 text-primary" : "border-border/70 hover:border-primary/40")}>
            #{entry.tag}<FinancialData as="span" className="tabular-nums text-muted-foreground">{currency(entry.spent)}</FinancialData>
          </button>;
        })}
      </div>
      {active && <FinancialData className="mt-3 border-t border-border/60 pt-3">
        <p className="text-sm font-medium">#{active.tag} · {currency(active.spent)} <span className="font-normal text-muted-foreground">· {active.count} Buchungen · {dateLabel(active.from)} – {dateLabel(active.to)}</span></p>
        <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
          {active.categories.map((part) => <li key={part.category} className="flex justify-between gap-2 rounded-lg bg-muted/30 px-2.5 py-1.5">
            <span>{part.category}</span><span className="tabular-nums">{currency(part.amount)}</span>
          </li>)}
        </ul>
      </FinancialData>}
    </section>
  );
}
