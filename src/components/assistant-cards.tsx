"use client";

import { useMemo, useState } from "react";
import { Brain, Check, ChevronDown, History, ListChecks, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { classify } from "@/lib/calc";
import { canonicalCategory } from "@/lib/categories";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import type { AppState, AssistantCard, AssistantChangeLog, AssistantMemory, AssistantMessage, Transaction } from "@/lib/types";
import { cn } from "@/lib/utils";

const toneClass = {
  good: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-red-700 dark:text-red-400",
  info: "text-foreground",
} as const;
const kindLabel: Record<AssistantCard["kind"], string> = {
  answer: "Antwort", briefing: "Wochenüberblick", check: "Finanz-Check", coach: "Spar-Coach", depot: "Depot-Rechner", tax: "Arbeitnehmerveranlagung",
  homeoffice: "Home-Office-Rechner", homeoffice_result: "Home-Office · Arbeitnehmerveranlagung",
  rule: "Regel-Vorschau", memory: "Gedächtnis", changes: "Änderungen",
};

function Bookings({ ids, transactions }: { ids: string[]; transactions: Map<string, Transaction> }) {
  const rows = ids.map((id) => transactions.get(id)).filter((row) => row !== undefined);
  if (!rows.length) return <p className="px-1 py-2 text-xs text-muted-foreground">Die Buchungen gibt es nicht mehr.</p>;
  return <ul className="mt-2 divide-y divide-border/50 rounded-xl border border-border/60 bg-background/60 text-xs">
    {rows.map((row) => <li key={row.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
      <span className="min-w-0">
        <span className="block truncate">{row.merchantAlias || row.description}</span>
        <span className="text-muted-foreground">{dateLabel(row.date)} · {canonicalCategory(classify(row).category)}{row.bank ? ` · ${row.bank}` : ""}</span>
      </span>
      <span className={cn("shrink-0 tabular-nums", row.amount < 0 ? "" : "text-emerald-700 dark:text-emerald-400")}>{currency(row.amount)}</span>
    </li>)}
  </ul>;
}

// Calculated card: every number comes from code; the bookings behind a number can be expanded right here.
export function ResultCard({ card, state }: { card: AssistantCard; state: AppState }) {
  const transactions = useMemo(() => new Map(state.transactions.map((row) => [row.id, row])), [state.transactions]);
  const [open, setOpen] = useState<number | "all">();
  const toggle = (key: number | "all") => setOpen((current) => current === key ? undefined : key);
  return <article className="rounded-2xl border border-border/70 bg-background/40 p-4" aria-label={card.title}>
    <p className="text-2xs uppercase tracking-wide text-muted-foreground">{kindLabel[card.kind]}</p>
    <h3 className="mt-0.5 flex items-baseline justify-between gap-3 text-sm font-semibold">
      <span>{card.title}</span>
      {card.total !== undefined && card.kind !== "rule" && card.kind !== "memory" && card.kind !== "changes" &&
        <span className="tabular-nums text-primary">{currency(card.total)}</span>}
    </h3>
    {card.lines.length > 0 && <ul className="mt-3 space-y-1.5">
      {card.lines.map((line, index) => <li key={`${line.label}-${index}`} className="text-sm">
        <div className="flex items-start justify-between gap-3">
          <span className={cn("min-w-0", line.tone && toneClass[line.tone])}>
            {line.transactionIds?.length
              ? <button type="button" className="inline-flex items-center gap-1 text-left underline-offset-2 hover:underline" aria-expanded={open === index}
                onClick={() => toggle(index)}>{line.label}<ChevronDown aria-hidden="true" className={cn("size-3 transition", open === index && "rotate-180")} /></button>
              : line.label}
            {line.detail && <span className="block text-xs text-muted-foreground">{line.detail}</span>}
          </span>
          {line.value !== undefined && <span className="shrink-0 tabular-nums">{currency(line.value)}</span>}
        </div>
        {open === index && line.transactionIds && <Bookings ids={line.transactionIds} transactions={transactions} />}
      </li>)}
    </ul>}
    {card.transactionIds && card.transactionIds.length > 0 && <div className="mt-3">
      <Button type="button" size="sm" variant="outline" className="min-h-9" aria-expanded={open === "all"} onClick={() => toggle("all")}>
        <ListChecks aria-hidden="true" className="size-4" />{open === "all" ? "Buchungen ausblenden" : `Buchungen anzeigen (${card.transactionIds.length}${card.transactionIds.length === 50 ? "+" : ""})`}
      </Button>
      {open === "all" && <Bookings ids={card.transactionIds} transactions={transactions} />}
    </div>}
    {card.note && <p className="mt-3 text-xs text-muted-foreground">{card.note}</p>}
  </article>;
}

// Before/after preview of an agent change; nothing is saved before "Bestätigen".
export function ChangeCard({ message, disabled, onApply, onDismiss, onUndo }: {
  message: AssistantMessage; disabled: boolean; onApply: () => void; onDismiss: () => void; onUndo: () => void;
}) {
  const change = message.change!;
  return <article className={cn("rounded-2xl border bg-background/40 p-4", message.status === "applied" ? "border-emerald-500/40" : "border-primary/40")} aria-label={`Änderung: ${change.title}`}>
    <h3 className="text-sm font-semibold">{change.title}</h3>
    <table className="mt-3 w-full text-sm">
      <thead><tr className="text-left text-2xs uppercase tracking-wide text-muted-foreground">
        <th className="pb-1 font-normal">Was</th><th className="pb-1 font-normal">Vorher</th><th className="pb-1 font-normal">Nachher</th>
      </tr></thead>
      <tbody>{change.diffs.map((diff, index) => <tr key={`${diff.label}-${index}`} className="border-t border-border/50 align-top">
        <td className="py-1.5 pr-3">{diff.label}</td>
        <td className="py-1.5 pr-3 text-muted-foreground line-through decoration-muted-foreground/40">{diff.before}</td>
        <td className="py-1.5 font-medium">{diff.after}</td>
      </tr>)}</tbody>
    </table>
    {message.status === "preview" && <div className="mt-4 flex flex-wrap gap-2">
      <Button type="button" size="sm" className="min-h-10" disabled={disabled} onClick={onApply}><Check aria-hidden="true" className="size-4" />Bestätigen</Button>
      <Button type="button" size="sm" variant="ghost" className="min-h-10" onClick={onDismiss}><X aria-hidden="true" className="size-4" />Verwerfen</Button>
    </div>}
    {message.status === "applied" && <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
      <span className="inline-flex items-center gap-1.5 text-primary"><Check aria-hidden="true" className="size-3.5" />Übernommen</span>
      {change.logId && <Button type="button" size="sm" variant="outline" className="min-h-9" disabled={disabled} onClick={onUndo}><Undo2 aria-hidden="true" className="size-4" />Rückgängig</Button>}
    </div>}
    {message.status === "undone" && <p className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Undo2 aria-hidden="true" className="size-3.5" />Rückgängig gemacht</p>}
  </article>;
}

// Small bar chart: money left per month without and with the idea that is being checked.
export function FreeChart({ rows, label }: { rows: { month: string; before: number; after: number }[]; label: string }) {
  if (rows.length < 2) return null;
  const width = 320;
  const height = 96;
  const max = Math.max(1, ...rows.flatMap((row) => [Math.abs(row.before), Math.abs(row.after)]));
  const hasNegative = rows.some((row) => row.after < 0 || row.before < 0);
  const zero = hasNegative ? height / 2 : height - 14;
  const scale = (hasNegative ? height / 2 - 4 : height - 18) / max;
  const step = width / rows.length;
  const lowest = [...rows].sort((a, b) => a.after - b.after)[0];
  return <figure className="mt-3">
    <svg viewBox={`0 0 ${width} ${height}`} className="h-24 w-full" role="img"
      aria-label={`${label}. Knappster Monat ${monthLabel(lowest.month)} mit ${currency(lowest.after)}.`}>
      <line x1="0" x2={width} y1={zero} y2={zero} className="stroke-border" strokeWidth="1" />
      {rows.map((row, index) => {
        const x = index * step;
        const before = row.before * scale;
        const after = row.after * scale;
        return <g key={row.month}>
          <title>{`${monthLabel(row.month)}: vorher ${currency(row.before)}, danach ${currency(row.after)}`}</title>
          <rect x={x + step * 0.15} width={step * 0.3} y={before >= 0 ? zero - before : zero} height={Math.max(1, Math.abs(before))} className="fill-muted-foreground/30" rx="1.5" />
          <rect x={x + step * 0.5} width={step * 0.3} y={after >= 0 ? zero - after : zero} height={Math.max(1, Math.abs(after))}
            className={row.after < 0 ? "fill-red-500/80" : "fill-primary/80"} rx="1.5" />
          {(index === 0 || index === rows.length - 1 || index % 3 === 0) &&
            <text x={x + step / 2} y={height - 2} textAnchor="middle" className="fill-muted-foreground text-[9px]">{monthLabel(row.month, true)}</text>}
        </g>;
      })}
    </svg>
    <figcaption className="mt-1 flex flex-wrap gap-3 text-2xs text-muted-foreground">
      <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-muted-foreground/30" />frei bisher</span>
      <span className="inline-flex items-center gap-1"><span className="size-2 rounded-sm bg-primary/80" />frei danach</span>
      <span>{label}</span>
    </figcaption>
  </figure>;
}

export function ChangesPanel({ changes, disabled, onUndo }: { changes: AssistantChangeLog[]; disabled: boolean; onUndo: (id: string) => void }) {
  const list = [...changes].reverse();
  return <section className="panel mb-4 p-4" aria-label="Änderungen durch den Assistenten">
    <h2 className="flex items-center gap-2 text-sm font-semibold"><History aria-hidden="true" className="size-4 text-primary" />Änderungen durch den Assistenten</h2>
    {!list.length ? <p className="mt-2 text-sm text-muted-foreground">Noch keine Änderungen.</p>
      : <ul className="mt-3 max-h-80 divide-y divide-border/50 overflow-y-auto text-sm">
        {list.map((entry) => <li key={entry.id} className="flex items-start justify-between gap-3 py-2">
          <span className="min-w-0">
            <span className={cn("block font-medium", entry.undoneAt && "text-muted-foreground line-through")}>{entry.title}</span>
            <span className="block text-xs text-muted-foreground">{new Date(entry.at).toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" })}
              {entry.undoneAt ? " · rückgängig gemacht" : ""}</span>
            {entry.summary.slice(0, 4).map((line) => <span key={line} className="block truncate text-xs text-muted-foreground">{line}</span>)}
          </span>
          {!entry.undoneAt && <Button type="button" size="sm" variant="outline" className="min-h-9 shrink-0" disabled={disabled} onClick={() => onUndo(entry.id)}>
            <Undo2 aria-hidden="true" className="size-4" />Rückgängig</Button>}
        </li>)}
      </ul>}
  </section>;
}

export function MemoryPanel({ memory, disabled, onDelete }: { memory: AssistantMemory[]; disabled: boolean; onDelete: (id: string) => void }) {
  return <section className="panel mb-4 p-4" aria-label="Gedächtnis des Assistenten">
    <h2 className="flex items-center gap-2 text-sm font-semibold"><Brain aria-hidden="true" className="size-4 text-primary" />Das hat sich der Assistent gemerkt</h2>
    {!memory.length ? <p className="mt-2 text-sm text-muted-foreground">Noch nichts. Sag zum Beispiel „Merk dir: Puffer immer 500 €“ oder „Mein Gehalt kommt am 25.“.</p>
      : <ul className="mt-3 divide-y divide-border/50 text-sm">
        {memory.map((entry) => <li key={entry.id} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0">{entry.text}
            <span className="block text-xs text-muted-foreground">{entry.key === "buffer" ? "wird bei „Kann ich mir das leisten?“ abgezogen"
              : entry.key === "salaryDay" ? "für den Wochenüberblick" : "Notiz"} · {new Date(entry.at).toLocaleDateString("de-AT")}</span></span>
          <Button type="button" size="sm" variant="ghost" className="min-h-9 shrink-0" disabled={disabled} onClick={() => onDelete(entry.id)} aria-label={`„${entry.text}“ vergessen`}>
            <X aria-hidden="true" className="size-4" />Vergessen</Button>
        </li>)}
      </ul>}
  </section>;
}
