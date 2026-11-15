"use client";

import { useEffect, useId, useState } from "react";
import { m } from "motion/react";
import { ChevronDown, FlaskConical, Play } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { dialogSpring, useMotionMode } from "@/components/ui/premium-dialog/motion";
import { cn } from "@/lib/utils";
import { duration, Empty, focusRing, isObject, LoadNote, number, readJson, Section, shortModel, StatusLine, timeFormat, useLoad, useWide, type Load, type Note } from "./shared";

export type EvalScore = { passed: number; total: number; hard: number };
export type EvalRun = {
  id: string; suite: string; trigger: string; status: "running" | "done" | "error"; startedAt: string; finishedAt?: string; model?: string;
  score?: EvalScore; failed?: { group: string; label: string; ok: boolean; hard: boolean; got: string; ms: number }[]; ms?: number; error?: string;
};
export type EvalOverview = {
  file: string;
  suites: { id: string; label: string; cases: number; description: string }[];
  running: { id: string; trigger: string; done: number; total: number; startedAt: string } | null;
  ready: string;
  runs: EvalRun[];
};
const isEvals = (data: unknown) => isObject(data) && Array.isArray(data.suites) && Array.isArray(data.runs) && typeof data.ready === "string";
export const readEvals = () => readJson<EvalOverview>("/api/assistant-evals", isEvals);

export const scoreText = (score: EvalScore) => `${score.passed}/${score.total}`;
const percent = (score: EvalScore) => score.total ? Math.round(score.passed / score.total * 100) : 0;
const statusTone = { running: "info", done: "success", error: "destructive" } as const;
const statusText = { running: "Läuft", done: "Fertig", error: "Fehler" } as const;
const runTime = (run: EvalRun) => run.ms ?? (run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : undefined);

function Score({ run }: { run: EvalRun }) {
  if (!run.score) return <span className="text-muted-foreground">–</span>;
  return <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
    <span className="font-semibold tabular-nums">{scoreText(run.score)}</span>
    <span className="text-xs tabular-nums text-muted-foreground">{percent(run.score)} %</span>
    {run.score.hard > 0 && <span className="text-xs font-medium text-destructive">{run.score.hard} Sicherheitsfehler</span>}
  </span>;
}

function Failures({ run, id }: { run: EvalRun; id: string }) {
  const mode = useMotionMode();
  return <m.div id={id} initial={mode === "full" ? { opacity: 0, y: -4 } : false} animate={{ opacity: 1, y: 0 }} transition={mode === "full" ? dialogSpring : { duration: 0 }}>
    {run.error && <p className="mb-2 text-xs text-destructive">{run.error}</p>}
    {run.failed?.length ? <ul aria-label="Fehlgeschlagene Fälle" className="divide-y divide-border/60 rounded-xl border border-border/70 bg-muted/30">
      {run.failed.map((item, index) => <li key={`${index}:${item.label}`} className="grid gap-1 px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{item.group}</Badge>
          {item.hard && <Badge variant="destructive">Sicherheit</Badge>}
          <span className="min-w-0 break-words font-medium">{item.label}</span>
        </div>
        <p className="min-w-0 break-words text-xs text-muted-foreground">Bekam: <code className="font-mono text-foreground/80">{item.got || "–"}</code></p>
      </li>)}
    </ul> : !run.error && <p className="text-xs text-muted-foreground">Keine Fehler.</p>}
  </m.div>;
}

function FailToggle({ run, open, onToggle, controls }: { run: EvalRun; open: boolean; onToggle: () => void; controls: string }) {
  const count = run.failed?.length ?? 0;
  if (!count && !run.error) return null;
  return <button type="button" aria-expanded={open} aria-controls={open ? controls : undefined} onClick={onToggle}
    className={cn("inline-flex min-h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground", focusRing)}>
    {count ? `${count} Fehler` : "Fehlermeldung"}
    <ChevronDown aria-hidden="true" className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
  </button>;
}

function RunRow({ run, wide }: { run: EvalRun; wide: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const time = runTime(run);
  const date = <time dateTime={run.startedAt} className="tabular-nums">{timeFormat.format(new Date(run.startedAt))}</time>;
  const badge = <Badge variant={statusTone[run.status]}>{statusText[run.status]}</Badge>;
  const toggle = <FailToggle run={run} open={open} onToggle={() => setOpen((value) => !value)} controls={id} />;
  if (!wide) return <li className="space-y-2 py-3 first:pt-0 last:pb-0">
    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">{date}{badge}</div>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm"><Score run={run} />{toggle}</div>
    <p className="text-xs text-muted-foreground">{run.trigger}{time !== undefined ? ` · ${duration(time)}` : ""}{run.model ? ` · ${shortModel(run.model)}` : ""}</p>
    {open && <Failures run={run} id={id} />}
  </li>;
  return <>
    <tr className="border-t border-border/60 align-middle">
      <td className="py-2.5 pr-4 text-muted-foreground">{date}</td>
      <td className="py-2.5 pr-4">{run.trigger}</td>
      <td className="py-2.5 pr-4"><Score run={run} /></td>
      <td className="py-2.5 pr-4 tabular-nums text-muted-foreground">{time !== undefined ? duration(time) : "–"}</td>
      <td className="max-w-40 truncate py-2.5 pr-4 text-muted-foreground" title={run.model}>{run.model ? shortModel(run.model) : "–"}</td>
      <td className="py-2.5 pr-2">{badge}</td>
      <td className="py-2.5 text-right">{toggle}</td>
    </tr>
    {open && <tr><td colSpan={7} className="pb-3"><Failures run={run} id={id} /></td></tr>}
  </>;
}

function EvalRuns({ runs }: { runs: EvalRun[] }) {
  const wide = useWide() !== false;
  if (!runs.length) return <Empty icon={FlaskConical} title="Noch keine Eval-Läufe">Starte die Gold-Eval oben; jeder Lauf erscheint hier mit Ergebnis und Fehlern.</Empty>;
  if (!wide) return <ul aria-label="Eval-Läufe" className="divide-y divide-border/70">{runs.map((run) => <RunRow key={run.id} run={run} wide={false} />)}</ul>;
  return <div className="-mx-1 overflow-x-auto px-1">
    <table aria-label="Eval-Läufe" className="w-full min-w-[40rem] text-sm">
      <thead>
        <tr className="text-left text-2xs uppercase tracking-wide text-muted-foreground">
          {["Datum", "Auslöser", "Ergebnis", "Dauer", "Modell", "Status"].map((title) => <th key={title} scope="col" className="pb-2 pr-4 font-medium">{title}</th>)}
          <th scope="col" className="pb-2"><span className="sr-only">Fehler</span></th>
        </tr>
      </thead>
      <tbody>{runs.map((run) => <RunRow key={run.id} run={run} wide />)}</tbody>
    </table>
  </div>;
}

export function EvalsView() {
  const [load, setLoad] = useLoad<Load<EvalOverview>>(readEvals, { state: "loading" });
  const [note, setNote] = useState<Note>();
  const [starting, setStarting] = useState(false);
  const running = load.state === "ready" ? load.data.running : null;
  // While an eval runs, its progress refreshes every three seconds.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void readEvals().then(setLoad), 3000);
    return () => window.clearInterval(timer);
  }, [running, setLoad]);
  const start = async (suite: string) => {
    setStarting(true);
    setNote(undefined);
    try {
      const response = await fetch("/api/assistant-evals", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ suite }) });
      const data: unknown = await response.json().catch(() => undefined);
      setNote(response.ok ? { ok: true, text: "Eval gestartet – sie läuft im Hintergrund weiter, auch wenn du die Seite verlässt." }
        : { ok: false, text: isObject(data) && typeof data.error === "string" ? data.error : `Start hat nicht geklappt (HTTP ${response.status}).` });
    } catch {
      setNote({ ok: false, text: "Start hat nicht geklappt – keine Verbindung." });
    }
    setLoad(await readEvals());
    setStarting(false);
  };
  if (load.state !== "ready") return <Section id="orchestrator-evals" title="Evals"><LoadNote load={load} what="Die Evals" /></Section>;
  const { suites, ready, runs } = load.data;
  const live = ready === "bereit";
  return <>
    <Section id="orchestrator-evals" title="Evals" meta={<Badge variant={live ? "success" : "warning"}>DeepSeek {ready}</Badge>}>
      <ul className="divide-y divide-border/70">
        {suites.map((suite) => <li key={suite.id} className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
          <div className="min-w-0 space-y-1">
            <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">{suite.label}
              <span className="text-xs font-normal tabular-nums text-muted-foreground">{number(suite.cases)} Fälle</span></h3>
            <p className="max-w-prose text-sm text-muted-foreground">{suite.description}</p>
          </div>
          <Button type="button" size="sm" className="self-start" disabled={starting || !!running || !live} onClick={() => void start(suite.id)}>
            <Play aria-hidden="true" />Eval starten
          </Button>
        </li>)}
      </ul>
      {running && <div className="mt-4 space-y-1.5 rounded-xl border border-border/70 bg-muted/30 p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
          <span className="font-medium">Läuft seit <time dateTime={running.startedAt}>{timeFormat.format(new Date(running.startedAt))}</time> · {running.trigger}</span>
          <span className="tabular-nums text-muted-foreground">{number(running.done)} von {number(running.total)} Fällen</span>
        </div>
        <Progress value={running.done} max={running.total} label="Fortschritt der Eval" valueText={`${running.done} von ${running.total} Fällen`} tone="info" />
      </div>}
      <StatusLine note={note} className="mt-3" />
      {!live && <p className="text-xs text-muted-foreground">Ohne erreichbares DeepSeek startet keine Eval.</p>}
    </Section>
    <Section id="orchestrator-eval-runs" title="Eval-Läufe" meta={`${runs.length} ${runs.length === 1 ? "Lauf" : "Läufe"}, neueste zuerst`}>
      <EvalRuns runs={runs} />
      <p className="mt-3 text-xs text-muted-foreground">Datei: <code className="break-all rounded bg-muted px-1.5 py-0.5">{load.data.file}</code></p>
    </Section>
  </>;
}
