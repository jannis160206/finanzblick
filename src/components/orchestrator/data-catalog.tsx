"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { m } from "motion/react";
import { Database, Search } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { Badge } from "@/components/ui/badge";
import { dialogSpring, useMotionMode } from "@/components/ui/premium-dialog/motion";
import { agentName, dataCatalog, dataSource, dataSources, toolSpecs, type CatalogEntry, type DataSourceId } from "@/lib/agents/registry";
import { orchestratorHref } from "@/lib/assistant/orchestrator-pages";
import type { AppState } from "@/lib/types";
import { cn } from "@/lib/utils";
import { focusRing, number, Section, useHash, WarningDot } from "./shared";

/** How many entries the app holds right now, where that is plain from the state; "–" for data outside it. */
function entryCount(id: DataSourceId, state: AppState): { value: string; note?: string } {
  const count = (value: number) => ({ value: number(value) });
  switch (id) {
    case "buchungen": return count(state.transactions.length);
    case "regeln": return count(state.merchantRules?.length ?? 0);
    case "vertraege": return { value: number(state.contracts?.length ?? 0), note: "eigene/entschiedene" };
    case "ziele": return count((state.savingsGoals?.length ?? 0) + (state.plannedOneOffs?.length ?? 0));
    case "gehalt": return count(state.payslips?.length ?? 0);
    case "gedaechtnis": return count(state.assistantMemory?.length ?? 0);
    default: return { value: "–" };
  }
}

const catalogIds = new Set(dataCatalog.map((entry) => entry.id));
// Sources the agents read that are no data set of the app (web, market data, calculators …).
const otherSources = dataSources.filter((source) => !catalogIds.has(source.id));

const matches = (id: DataSourceId, query: string) => {
  if (!query) return true;
  const source = dataSource(id);
  const entry = dataCatalog.find((item) => item.id === id);
  const text = [id, source.label, source.detail, entry?.description, entry?.grain, ...(entry?.fields.flat() ?? [])].join(" ").toLocaleLowerCase("de");
  return query.toLocaleLowerCase("de").split(/\s+/).every((word) => text.includes(word));
};

function Picker({ ids, picked, onPick, label }: { ids: DataSourceId[]; picked: DataSourceId; onPick: (id: DataSourceId) => void; label: string }) {
  if (!ids.length) return null;
  return <div>
    <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">{label}</p>
    <ul aria-label={label} className="flex flex-wrap gap-1 xl:flex-col xl:gap-0.5">
      {ids.map((id) => <li key={id}>
        <button type="button" aria-current={id === picked ? "true" : undefined} onClick={() => onPick(id)}
          className={cn("flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border border-border/60 px-2.5 text-left text-sm transition-colors hover:bg-muted/50 xl:border-transparent",
            "aria-[current=true]:border-primary/30 aria-[current=true]:bg-primary/10 aria-[current=true]:font-medium", focusRing)}>
          <span className="truncate">{dataSource(id).label}</span>
          <code className="hidden shrink-0 font-mono text-2xs text-muted-foreground xl:inline">{id}</code>
        </button>
      </li>)}
    </ul>
  </div>;
}

/** The chosen data set in the middle, the ones it relates to around it; a click moves the center. */
function Relations({ entry, onPick }: { entry?: CatalogEntry; onPick: (id: DataSourceId) => void }) {
  const mode = useMotionMode();
  const related = entry?.related ?? [];
  const points = related.map((id, index) => {
    const angle = -Math.PI / 2 + index * 2 * Math.PI / related.length;
    return { id, x: 50 + 34 * Math.cos(angle), y: 50 + 36 * Math.sin(angle) };
  });
  const center = entry ? dataSource(entry.id) : undefined;
  if (!entry || !center) return <div className="grid min-h-48 place-items-center rounded-xl border border-dashed border-border/70 p-4 text-center text-sm text-muted-foreground">
    Keine Beziehungen – diese Quelle liegt außerhalb der App-Daten.
  </div>;
  const enter = (index: number) => mode === "full"
    ? { initial: { opacity: 0, scale: 0.92 }, animate: { opacity: 1, scale: 1 }, transition: { ...dialogSpring, delay: 0.03 * index } }
    : { initial: false as const };
  return <div role="group" aria-label={`Beziehungen von ${center.label}`} className="relative mx-auto aspect-square w-full max-w-md rounded-xl bg-muted/30 sm:aspect-[4/3]">
    <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full" fill="none">
      {points.map((point) => <line key={`${entry.id}>${point.id}`} x1={50} y1={50} x2={point.x} y2={point.y} vectorEffect="non-scaling-stroke"
        className="stroke-muted-foreground/40" strokeWidth={1.25} strokeDasharray={catalogIds.has(point.id) ? undefined : "3 3"} />)}
    </svg>
    {points.map((point, index) => {
      const source = dataSource(point.id);
      return <m.button key={`${entry.id}:${point.id}`} type="button" onClick={() => onPick(point.id)} {...enter(index + 1)}
        style={{ left: `${point.x}%`, top: `${point.y}%` }} aria-label={`${source.label} öffnen`}
        className={cn("absolute w-max max-w-[7.5rem] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border/80 bg-card px-2 py-1 text-left shadow-xs transition-colors hover:border-primary/40",
          focusRing)}>
        <span className="block truncate text-xs font-medium">{source.label}</span>
        <span className="block truncate text-2xs text-muted-foreground">{source.detail}</span>
      </m.button>;
    })}
    <m.div key={entry.id} {...enter(0)} style={{ left: "50%", top: "50%" }}
      className="absolute w-max max-w-[9rem] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-primary/40 bg-[color-mix(in_oklab,var(--primary)_8%,var(--card))] px-3 py-2 text-center shadow-card">
      <Database aria-hidden="true" className="mx-auto mb-1 size-4 text-primary" />
      <span className="block text-sm font-semibold leading-tight">{center.label}</span>
      <code className="block font-mono text-2xs text-muted-foreground">{entry.id}</code>
    </m.div>
  </div>;
}

function Details({ id, state }: { id: DataSourceId; state: AppState }) {
  const source = dataSource(id);
  const entry = dataCatalog.find((item) => item.id === id);
  const readers = toolSpecs.filter((tool) => tool.source === id);
  const count = entryCount(id, state);
  return <div className="min-w-0 space-y-4">
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold tracking-tight">{source.label}</h3>
        <code className="font-mono text-2xs text-muted-foreground">{id}</code>
      </div>
      <p className="text-xs text-muted-foreground">{source.detail}</p>
    </div>
    {entry && <p className="text-sm leading-relaxed">{entry.description}</p>}
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {entry && <><dt className="text-muted-foreground">Körnung</dt><dd>{entry.grain}</dd></>}
      <dt className="text-muted-foreground">Einträge</dt>
      <dd className="tabular-nums">{count.value}{count.note && <span className="text-muted-foreground"> {count.note}</span>}</dd>
    </dl>
    {entry && <div className="overflow-hidden rounded-xl border border-border/70">
      <table aria-label={`Felder von ${source.label}`} className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr><th scope="col" className="px-3 py-1.5 font-medium">Feld</th><th scope="col" className="px-3 py-1.5 font-medium">Bedeutung</th></tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {entry.fields.map(([field, meaning]) => <tr key={field} className="align-top">
            <td className="px-3 py-1.5 font-mono text-xs">{field}</td><td className="px-3 py-1.5 text-muted-foreground">{meaning}</td>
          </tr>)}
        </tbody>
      </table>
    </div>}
    <div>
      <h4 className="mb-1.5 text-sm font-medium">Gelesen von</h4>
      {readers.length ? <ul aria-label={`Werkzeuge für ${source.label}`} className="space-y-1">
        {readers.map((tool) => <li key={tool.name} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
          <Link href={`${orchestratorHref("werkzeuge")}#werkzeug-${tool.name}`} className={cn("inline-flex items-center gap-1.5 rounded font-mono text-xs hover:text-primary", focusRing)}>
            {tool.name}{tool.kind === "change" && <WarningDot label="schreibt" />}
          </Link>
          <span className="text-xs text-muted-foreground">{tool.agents.map(agentName).join(", ")}</span>
        </li>)}
      </ul> : <p className="text-sm text-muted-foreground">Kein Werkzeug liest diese Quelle.</p>}
    </div>
  </div>;
}

export function DataCatalogView() {
  const { state } = useFinance();
  const hash = useHash();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<DataSourceId>(dataCatalog[0].id);
  // Links from the topology open a source by its id ("#buchungen").
  useEffect(() => {
    const source = dataSources.find((item) => item.id === hash);
    if (source) setPicked(source.id);
  }, [hash]);
  const shown = useMemo(() => ({
    catalog: dataCatalog.map((entry) => entry.id).filter((id) => matches(id, query.trim())),
    other: otherSources.map((source) => source.id).filter((id) => matches(id, query.trim())),
  }), [query]);
  const entry = dataCatalog.find((item) => item.id === picked);
  return <Section id="orchestrator-data" title="Datenkatalog" meta={<Badge variant="secondary">Aus dem Code</Badge>}>
    <p className="mb-4 max-w-prose text-sm text-muted-foreground">Was die Agenten lesen: jede Datenquelle mit Körnung, Feldern, Beziehungen und den Werkzeugen, die
      sie lesen. Nur zur Ansicht – der Katalog kommt aus dem Code.</p>
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-[12.5rem_minmax(0,1fr)_19rem]">
      <div className="min-w-0 space-y-3 md:col-span-2 xl:col-span-1">
        <label className="relative block">
          <span className="sr-only">Daten filtern</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Daten filtern…"
            className="h-9 w-full rounded-lg border border-input bg-background/50 pl-8 pr-2 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20" />
        </label>
        <Picker ids={shown.catalog} picked={picked} onPick={setPicked} label="Datensätze" />
        <Picker ids={shown.other} picked={picked} onPick={setPicked} label="Weitere Quellen" />
        {!shown.catalog.length && !shown.other.length && <p className="text-sm text-muted-foreground">Keine Daten passen zu „{query.trim()}“.</p>}
      </div>
      <Relations entry={entry} onPick={setPicked} />
      <Details id={picked} state={state} />
    </div>
  </Section>;
}
