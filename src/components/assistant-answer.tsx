"use client";

import { useState } from "react";
import { ChevronDown, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { ResultCard } from "@/components/assistant-cards";
import { AnswerMarkdown } from "@/components/assistant-markdown";
import type { AgentResult } from "@/lib/assistant/agent";
import { answerKpis, splitTitle, tileLines, trendOf, type Kpi, type Tone } from "@/lib/assistant/answer-view";
import { currency as format } from "@/lib/format";
import type { AppState, AssistantCard } from "@/lib/types";
import { cn } from "@/lib/utils";

// The answer layout: the orchestrator's words on top, the specialists' results below as key figures and a bento grid of tiles.
// Colours come from the semantic tokens (success, destructive, warning), so light and dark mode follow the design system.

const toneText: Record<Tone, string> = {
  positive: "text-success", negative: "text-destructive", warning: "text-warning", neutral: "text-foreground",
};
const toneSurface: Record<Tone, string> = {
  positive: "bg-success-soft ring-success/20", negative: "bg-destructive-soft ring-destructive/20", warning: "bg-warning-soft ring-warning/25", neutral: "bg-muted/40 ring-border/60",
};
const toneDot: Record<Tone, string> = { positive: "bg-success", negative: "bg-destructive", warning: "bg-warning", neutral: "bg-muted-foreground/40" };
const toneName: Record<Tone, string> = { positive: "positiv", negative: "negativ", warning: "Achtung", neutral: "" };
// "-0,00 €" from a rounded zero reads like a loss; it is shown as zero.
const currency = (value: number) => format(value === 0 ? 0 : value);

/** The written answer as formatted Markdown: the key statement first, then short paragraphs, lists, tables or code. */
export function AnswerProse({ text, streaming }: { text: string; streaming?: boolean }) {
  return <AnswerMarkdown text={text} streaming={streaming} />;
}

export function KpiBadge({ kpi }: { kpi: Kpi }) {
  return <div className={cn("min-w-0 rounded-xl px-3 py-2 ring-1 ring-inset", toneSurface[kpi.tone])}>
    <p className="truncate text-2xs font-medium text-muted-foreground" title={kpi.label}>{kpi.label}</p>
    <p className={cn("mt-0.5 truncate text-base font-semibold tracking-tight tabular-nums", toneText[kpi.tone])}>
      {currency(kpi.value)}{toneName[kpi.tone] && <span className="sr-only"> ({toneName[kpi.tone]})</span>}</p>
    {kpi.hint && <p className="truncate text-2xs text-muted-foreground">{kpi.hint}</p>}
  </div>;
}

/** A small trend line with a soft area; the label carries the numbers for screen readers. */
export function Sparkline({ values, tone, label, className }: { values: number[]; tone: Tone; label: string; className?: string }) {
  const width = 96;
  const height = 28;
  const pad = 2.5;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const points = values.map((value, index) => [pad + index * (width - 2 * pad) / Math.max(1, values.length - 1), height - pad - (value - min) / span * (height - 2 * pad)]);
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lastX, lastY] = points.at(-1)!;
  return <svg viewBox={`0 0 ${width} ${height}`} className={cn("h-7 w-24 shrink-0 overflow-visible", tone === "neutral" ? "text-primary" : toneText[tone], className)} role="img" aria-label={label}>
    <polygon points={`${pad},${height} ${line} ${width - pad},${height}`} className="fill-current opacity-10" />
    <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx={lastX} cy={lastY} r="2.4" className="fill-current" />
  </svg>;
}

function Delta({ change, percent, tone }: { change: number; percent?: number; tone: Tone }) {
  const Icon = change > 0 ? TrendingUp : change < 0 ? TrendingDown : Minus;
  const sign = change > 0 ? "+" : change < 0 ? "−" : "±";
  const text = percent !== undefined && Math.abs(percent) < 1000 ? `${sign}${Math.abs(percent).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %` : `${sign}${currency(Math.abs(change))}`;
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold tabular-nums ring-1 ring-inset", toneSurface[tone], toneText[tone])}>
    <Icon aria-hidden="true" className="size-3" />{text}</span>;
}

function Tile({ card, state, onResult }: { card: AssistantCard; state: AppState; onResult?: (result: AgentResult) => void }) {
  const [open, setOpen] = useState(false);
  const { label, hint } = splitTitle(card.title);
  const trend = trendOf(card);
  const lines = tileLines(card);
  const more = card.lines.length > lines.length || !!card.chart || !!card.transactionIds?.length || !!card.page || !!card.note;
  return <article className="flex h-full min-w-0 flex-col rounded-xl border border-border/60 bg-background/50 p-3" aria-label={card.title}>
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h4 className="truncate text-sm font-semibold">{label}</h4>
        {hint && <p className="truncate text-2xs text-muted-foreground">{hint}</p>}
      </div>
      {card.total !== undefined && card.kind !== "rule" && card.kind !== "memory" && card.kind !== "changes" &&
        <span className={cn("shrink-0 text-base font-semibold tracking-tight tabular-nums", toneText[card.total < 0 ? "negative" : "neutral"])}>{currency(card.total)}</span>}
    </div>
    {trend && <div className="mt-2 flex items-center justify-between gap-3">
      <Sparkline values={trend.values} tone={trend.tone}
        label={`Verlauf ${trend.name}: ${trend.labels.map((item, index) => `${item} ${currency(trend.values[index])}`).join(", ")}`} />
      <Delta change={trend.change} percent={trend.percent} tone={trend.tone} />
    </div>}
    {lines.length > 0 && <ul className="mt-2 space-y-1">
      {lines.map((line, index) => <li key={`${line.label}-${index}`} className="flex items-start justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-start gap-1.5">
          <span aria-hidden="true" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", toneDot[line.tone])} />
          <span className="min-w-0"><span className="block truncate">{line.label}</span>{line.detail && <span className="block truncate text-muted-foreground">{line.detail}</span>}</span>
        </span>
        {line.value !== undefined && <span className={cn("shrink-0 tabular-nums", toneText[line.tone])}>{currency(line.value)}
          {toneName[line.tone] && <span className="sr-only"> ({toneName[line.tone]})</span>}</span>}
      </li>)}
    </ul>}
    {more && <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}
      className="mt-auto inline-flex min-h-9 items-center gap-1 self-start pt-2 text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
      <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")} />{open ? "Weniger" : "Mehr"}</button>}
    {open && <ResultCard card={card} state={state} embedded onResult={onResult} />}
  </article>;
}

/** Key figures as badges and one tile per result in a bento grid; the grid follows the chat's width, not the window's. */
export function AnswerLayout({ cards, state, onResult }: { cards: AssistantCard[]; state: AppState; onResult?: (result: AgentResult) => void }) {
  const kpis = answerKpis(cards);
  return <div className="@container mt-3 space-y-2.5 border-t border-border/60 pt-3">
    {kpis.length > 0 && <ul aria-label="Kennzahlen" className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
      {kpis.map((kpi) => <li key={kpi.label} className="min-w-0"><KpiBadge kpi={kpi} /></li>)}
    </ul>}
    <ul aria-label="Ergebnisse" className="grid gap-2 @sm:grid-cols-2">
      {cards.map((card, index) => <li key={`${card.title}-${index}`} className={cn("min-w-0", cards.length % 2 === 1 && index === cards.length - 1 && "@sm:col-span-2")}>
        <Tile card={card} state={state} onResult={onResult} /></li>)}
    </ul>
  </div>;
}
