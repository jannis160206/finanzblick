"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Brain, Check, ChevronDown, Copy, Download, ExternalLink, Globe, History, ListChecks, Mail, Printer, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AssistantChartView } from "@/components/assistant-chart";
import { WhatIfCard } from "@/components/whatif-card";
import type { AgentResult } from "@/lib/assistant/agent";
import { classify } from "@/lib/calc";
import { canonicalCategory } from "@/lib/categories";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { downloadTaxFolder, taxFolder } from "@/lib/tax-folder";
import { ruleText } from "@/lib/assistant/funds";
import { closeAssistant } from "@/lib/assistant-bus";
import type { AccountRule, AppState, AssistantAlias, AssistantCard, AssistantChangeLog, AssistantGap, AssistantKnowledge, AssistantMemory, AssistantMessage, Transaction } from "@/lib/types";
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
  rule: "Regel-Vorschau", memory: "Gedächtnis", changes: "Änderungen", loan: "Kreditrechner", review: "Jahresrückblick",
  cancel: "Kündigungshilfe", why: "Warum diese Kategorie?", forecast: "Kontoprognose", whatif: "Was wäre wenn",
  contracts: "Verträge & Abos", insights: "Hinweise", context: "Diese Ansicht",
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
// Shows links in a note as short labels ("Wikipedia: Kapitalertragsteuer") instead of raw URLs.
function NoteText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s·]+?)(?=[.,;]?(?:\s|$))/g);
  return <>{parts.map((part, index) => {
    if (!/^https?:\/\//.test(part)) return part;
    let label = part;
    try {
      const url = new URL(part);
      const page = decodeURIComponent(url.pathname.split("/").pop() ?? "").replace(/_/g, " ");
      label = url.hostname.endsWith("wikipedia.org") ? `Wikipedia: ${page}` : url.hostname.replace(/^www\./, "");
    } catch { /* keep the raw text */ }
    return <a key={index} href={part} target="_blank" rel="noreferrer noopener"
      className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"><Globe aria-hidden="true" className="size-3" />{label}</a>;
  })}</>;
}

// With "embedded" the card sits inside the assistant's chat bubble, so text and result form one answer.
const CARD_LINES = 6;

export function ResultCard({ card, state, embedded, onResult }: { card: AssistantCard; state: AppState; embedded?: boolean; onResult?: (result: AgentResult) => void }) {
  const transactions = useMemo(() => new Map(state.transactions.map((row) => [row.id, row])), [state.transactions]);
  const [open, setOpen] = useState<number | "all">();
  const toggle = (key: number | "all") => setOpen((current) => current === key ? undefined : key);
  // A single line repeating the title becomes its subtitle.
  const subtitle = card.lines.length === 1 && card.lines[0].label === card.title && !card.lines[0].value && !card.lines[0].transactionIds?.length ? card.lines[0].detail : undefined;
  const lines = subtitle !== undefined || card.whatif ? [] : card.lines;
  // Summary first: long cards show their first lines; the rest only on request.
  const [all, setAll] = useState(false);
  const shown = all || lines.length <= CARD_LINES + 1 ? lines : lines.slice(0, CARD_LINES);
  return <article className={embedded ? "mt-3 border-t border-border/60 pt-3" : "rounded-2xl border border-border/70 bg-background/40 p-4"} aria-label={card.title}>
    {!(embedded && card.kind === "answer") && <p className="text-2xs uppercase tracking-wide text-muted-foreground">{kindLabel[card.kind]}</p>}
    <h3 className="mt-0.5 flex items-baseline justify-between gap-3 text-sm font-semibold">
      <span>{card.title}</span>
      {card.total !== undefined && card.kind !== "rule" && card.kind !== "memory" && card.kind !== "changes" && !card.whatif &&
        <span className="tabular-nums text-primary">{currency(card.total)}</span>}
    </h3>
    {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
    {card.chart && <AssistantChartView chart={card.chart} title={card.title} />}
    {card.whatif && <WhatIfCard data={card.whatif} state={state} onResult={onResult} />}
    {lines.length > 0 && <ul className="mt-3 space-y-1.5">
      {shown.map((line, index) => <li key={`${line.label}-${index}`} className="text-sm">
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
    {shown.length < lines.length && <button type="button" onClick={() => setAll(true)}
      className="mt-2 inline-flex min-h-9 items-center gap-1 rounded-lg text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
      <ChevronDown aria-hidden="true" className="size-3.5" />Alle {lines.length} anzeigen</button>}
    {card.transactionIds && card.transactionIds.length > 0 && <div className="mt-3">
      <Button type="button" size="sm" variant="outline" className="min-h-9" aria-expanded={open === "all"} onClick={() => toggle("all")}>
        <ListChecks aria-hidden="true" className="size-4" />{open === "all" ? "Buchungen ausblenden" : `Buchungen anzeigen (${card.transactionIds.length}${card.transactionIds.length === 50 ? "+" : ""})`}
      </Button>
      {open === "all" && <Bookings ids={card.transactionIds} transactions={transactions} />}
    </div>}
    {card.letter && <CancelLetter letter={card.letter} subject={card.title} />}
    {card.links && card.links.length > 0 && <ul className="mt-3 flex flex-wrap gap-2" aria-label="Weiterführende Links">
      {card.links.map((link) => <li key={link.url}><a href={link.url} target="_blank" rel="noreferrer noopener"
        className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/70 px-3 text-xs font-medium text-primary hover:bg-muted"><ExternalLink aria-hidden="true" className="size-3.5" />{link.label}</a></li>)}
    </ul>}
    {card.page && <Link href={card.page.href} onClick={() => closeAssistant()}
      className="mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border/70 px-3 text-xs font-medium text-primary hover:bg-muted">
      <ArrowRight aria-hidden="true" className="size-3.5" />{card.page.label}</Link>}
    {card.kind === "tax" && card.year && <TaxFolderDownload state={state} year={card.year} />}
    {card.note && <p className="mt-3 text-xs leading-relaxed text-muted-foreground"><NoteText text={card.note} /></p>}
  </article>;
}

// Steuer-Mappe export, built locally from the current bookings; nothing is uploaded.
export function TaxFolderDownload({ state, year, className }: { state: AppState; year: number; className?: string }) {
  const save = (format: "csv" | "html") => downloadTaxFolder(taxFolder(state, year), format);
  return <div className={cn("mt-3 flex flex-wrap gap-2", className)}>
    <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={() => save("csv")}><Download aria-hidden="true" className="size-4" />Mappe herunterladen (CSV)</Button>
    <Button type="button" size="sm" variant="ghost" className="min-h-9" onClick={() => save("html")}><Printer aria-hidden="true" className="size-4" />Druckansicht</Button>
  </div>;
}

// Ready cancellation letter: copy it or open it in the mail app; placeholders stay for the user to fill in.
function CancelLetter({ letter, subject }: { letter: string; subject: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(letter);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch { setCopied(false); }
  };
  const mail = `mailto:?subject=${encodeURIComponent(subject.replace(/^Kündigungshilfe · /, "Kündigung "))}&body=${encodeURIComponent(letter)}`;
  return <div className="mt-3">
    <p className="text-xs font-medium">Kündigungsschreiben</p>
    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-border/60 bg-background/60 p-3 font-sans text-xs leading-relaxed" tabIndex={0} aria-label="Kündigungsschreiben">{letter}</pre>
    <div className="mt-2 flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={copy}>{copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}{copied ? "Kopiert" : "Text kopieren"}</Button>
      <Button asChild size="sm" variant="ghost" className="min-h-9"><a href={mail}><Mail aria-hidden="true" className="size-4" />Als E-Mail öffnen</a></Button>
      <span role="status" className="sr-only">{copied ? "Kündigungsschreiben kopiert" : ""}</span>
    </div>
  </div>;
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

export function MemoryPanel({ memory, knowledge = [], phrases = 0, aliases = [], gaps = [], rules = [], disabled, onDelete, onForgetKnowledge, onResetPhrases, onForgetAlias, onRemoveGap, onForgetRule }: {
  memory: AssistantMemory[]; knowledge?: AssistantKnowledge[]; phrases?: number; aliases?: AssistantAlias[]; gaps?: AssistantGap[]; rules?: AccountRule[]; disabled: boolean;
  onDelete: (id: string) => void; onForgetKnowledge?: (id: string) => void; onResetPhrases?: () => void; onForgetAlias?: (from: string) => void; onRemoveGap?: (text: string) => void;
  onForgetRule?: (id: string) => void;
}) {
  const openGapList = gaps.filter((entry) => !entry.resolved).sort((a, b) => b.at - a.at).slice(0, 10);
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
    {rules.length > 0 && <>
      <h3 className="mt-5 text-sm font-semibold">Kontoregeln</h3>
      <ul className="mt-2 divide-y divide-border/50 text-sm">
        {rules.map((rule) => <li key={rule.id} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0">{rule.account}: {ruleText(rule)}
            <span className="block text-xs text-muted-foreground">gilt beim Konten-Check „Kann ich mir … leisten?“ · seit {new Date(rule.at).toLocaleDateString("de-AT")}</span></span>
          {onForgetRule && <Button type="button" size="sm" variant="ghost" className="min-h-9 shrink-0" disabled={disabled} onClick={() => onForgetRule(rule.id)}
            aria-label={`Kontoregel für ${rule.account} löschen`}><X aria-hidden="true" className="size-4" />Löschen</Button>}
        </li>)}
      </ul>
    </>}
    <h3 className="mt-5 flex items-center gap-2 text-sm font-semibold"><Globe aria-hidden="true" className="size-4 text-primary" />Selbst dazugelernt</h3>
    {!knowledge.length ? <p className="mt-2 text-sm text-muted-foreground">Noch nichts. Frag zum Beispiel „Was ist ein ETF?“; ich schlage es nach und merke es mir.</p>
      : <ul className="mt-3 divide-y divide-border/50 text-sm">
        {[...knowledge].sort((a, b) => b.at - a.at).map((entry) => <li key={entry.id} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0"><a href={entry.url} target="_blank" rel="noreferrer noopener" className="underline-offset-2 hover:underline">{entry.title}</a>
            <span className="block text-xs text-muted-foreground">{entry.kind === "web"
              ? entry.rejected ? `abgelehnt · wird nicht mehr vorgeschlagen${entry.note ? ` · dein Hinweis: „${entry.note}“` : ""}`
                : `bestätigte Websuche · ${new Date(entry.at).toLocaleDateString("de-AT")} · ${entry.votes ?? 1}× 👍${entry.uses ? ` · ${entry.uses}× wieder genutzt` : ""}`
              : `gefragt als „${entry.topic}“ · ${new Date(entry.at).toLocaleDateString("de-AT")}${entry.uses ? ` · ${entry.uses}× wieder genutzt` : ""}`} · {entry.source}</span></span>
          {onForgetKnowledge && <Button type="button" size="sm" variant="ghost" className="min-h-9 shrink-0" disabled={disabled} onClick={() => onForgetKnowledge(entry.id)}
            aria-label={`Wissen „${entry.title}“ vergessen`}><X aria-hidden="true" className="size-4" />Vergessen</Button>}
        </li>)}
      </ul>}
    {phrases > 0 && <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-3 text-sm">
      <span>{phrases} gelernte Formulierung{phrases === 1 ? "" : "en"}
        <span className="block text-xs text-muted-foreground">versteht der Assistent jetzt sofort, ohne die KI zu fragen</span></span>
      {onResetPhrases && <Button type="button" size="sm" variant="ghost" className="min-h-9 shrink-0" disabled={disabled} onClick={onResetPhrases}>
        <X aria-hidden="true" className="size-4" />Zurücksetzen</Button>}
    </div>}
    {aliases.length > 0 && <>
      <h3 className="mt-5 text-sm font-semibold">Deine Bezeichnungen</h3>
      <ul className="mt-2 divide-y divide-border/50 text-sm">
        {aliases.map((entry) => <li key={entry.from} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0">„{entry.from}“ → {entry.to}
            <span className="block text-xs text-muted-foreground">seit {new Date(entry.at).toLocaleDateString("de-AT")}{entry.hits ? ` · ${entry.hits}× verwendet` : ""}</span></span>
          {onForgetAlias && <Button type="button" size="sm" variant="ghost" className="min-h-9 shrink-0" disabled={disabled} onClick={() => onForgetAlias(entry.from)}
            aria-label={`Bezeichnung „${entry.from}“ vergessen`}><X aria-hidden="true" className="size-4" />Vergessen</Button>}
        </li>)}
      </ul></>}
    {openGapList.length > 0 && <>
      <h3 className="mt-5 text-sm font-semibold">Noch nicht verstanden</h3>
      <p className="mt-1 text-xs text-muted-foreground">Diese Fragen versucht der Assistent beim nächsten Öffnen selbst nachzulernen. Schreib sie gern anders, dann lernt er es sofort.</p>
      <ul className="mt-2 divide-y divide-border/50 text-sm">
        {openGapList.map((entry) => <li key={entry.text} className="flex items-center justify-between gap-3 py-2">
          <span className="min-w-0">„{entry.text}“
            <span className="block text-xs text-muted-foreground">{entry.count}× gefragt · zuletzt {new Date(entry.at).toLocaleDateString("de-AT")}</span></span>
          {onRemoveGap && <Button type="button" size="sm" variant="ghost" className="min-h-9 shrink-0" disabled={disabled} onClick={() => onRemoveGap(entry.text)}
            aria-label={`„${entry.text}“ entfernen`}><X aria-hidden="true" className="size-4" />Entfernen</Button>}
        </li>)}
      </ul></>}
  </section>;
}
