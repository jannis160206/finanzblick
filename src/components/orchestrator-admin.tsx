"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Ban, Check, CheckCheck, ChevronLeft, Clock, Download, Inbox, MessageSquareText, RefreshCw, ThumbsDown, ThumbsUp, Undo2, Workflow, X, type LucideIcon } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { useFinance } from "@/components/finance-provider";
import { PageHeading } from "@/components/finance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { askAssistant } from "@/lib/assistant-bus";
import { agentLabel, type AgentId } from "@/lib/assistant/orchestrator";
import {
  agentInfo, agentOrder, agentToolList, assistantRuns, callStateLabel, changesData, orchestratorSteps, runStatusLabel, toolLabel, viaLabel,
  type AssistantRun, type CallState, type RunCall, type RunStatus,
} from "@/lib/assistant/orchestrator-info";
import { cn } from "@/lib/utils";

type AiStatus = { available: boolean; model: string; error?: string; router?: { model: string; available: boolean } };

// One color per agent, used in the tree, the agent list, the runs and the tools.
const agentDot: Record<AgentId, string> = {
  transactions: "bg-chart-2", contracts: "bg-chart-3", budget: "bg-chart-1", payroll: "bg-chart-4", general: "bg-muted-foreground/60",
};
const statusTone: Record<RunStatus, "success" | "info" | "warning" | "destructive"> = {
  answered: "success", question: "info", unclear: "warning", error: "destructive",
};
// Each call state has its own icon, so success and failure never rely on color alone.
const callIcon: Record<CallState, { icon: LucideIcon; tone: string }> = {
  ok: { icon: Check, tone: "text-success" }, applied: { icon: CheckCheck, tone: "text-success" }, failed: { icon: X, tone: "text-destructive" },
  pending: { icon: Clock, tone: "text-warning" }, dismissed: { icon: Ban, tone: "text-muted-foreground" }, undone: { icon: Undo2, tone: "text-muted-foreground" },
};
const shortModel = (name: string) => name.split("/").at(-1) ?? name;
const duration = (ms: number) => ms < 60_000 ? `${Math.max(0.1, Math.round(ms / 100) / 10).toLocaleString("de-AT")} s` : `${Math.round(ms / 60_000)} min`;
const timeFormat = new Intl.DateTimeFormat("de-AT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function Dot({ agent, className }: { agent?: AgentId; className?: string }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", agent ? agentDot[agent] : "bg-border", className)} />;
}

function Section({ id, title, meta, children }: { id: string; title: string; meta?: ReactNode; children: ReactNode }) {
  return <section aria-labelledby={`${id}-title`} className="panel p-5 sm:p-6">
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">{title}</h2>
      {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
    </div>
    {children}
  </section>;
}

function ModelPill({ status, loading }: { status?: AiStatus; loading: boolean }) {
  if (loading && !status) return <Badge variant="secondary">Prüfe KI …</Badge>;
  if (!status?.available) return <Badge variant="warning" title={status?.error}>KI nicht erreichbar · nur Regeln</Badge>;
  return <Badge variant="success" title={status.model}>KI bereit · {shortModel(status.model)}</Badge>;
}

// Branch lines of the tree: a vertical rail that ends at the last item, and a short tick to each node.
const branch = "relative pl-7 before:absolute before:left-2 before:top-0 before:h-full before:w-px before:bg-border last:before:h-5 " +
  "after:absolute after:left-2 after:top-5 after:h-px after:w-4 after:bg-border";

const agentName = (agent: AgentId) => agent === "general" ? "Allgemeiner Chat" : agentLabel[agent];

function Tree({ status, loading }: { status?: AiStatus; loading: boolean }) {
  return <div aria-label="Orchestrator-Baum" role="group">
    <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-muted/40 px-3 py-2">
      <span className="flex items-center gap-2 text-sm font-semibold"><Workflow aria-hidden="true" className="size-4 text-primary" />Orchestrator</span>
      <ModelPill status={status} loading={loading} />
    </div>
    <ul className="ml-3">
      <li className={branch}>
        <p className="flex min-h-10 items-center text-xs font-medium text-muted-foreground">Entscheidet in drei Schritten</p>
        <ol aria-label="Entscheidungsschritte" className="space-y-0.5 pb-2">
          {orchestratorSteps.map((step, index) => <li key={step.title} className="flex items-start justify-between gap-3 rounded-lg px-2 py-1.5 even:bg-muted/30">
            <span className="flex min-w-0 items-baseline gap-2.5">
              <span aria-hidden="true" className="w-3 shrink-0 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
              <span className="min-w-0"><span className="text-sm font-medium">{step.title}</span>
                <span className="block text-xs text-muted-foreground">{step.detail}</span></span>
            </span>
            <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{step.calls}</span>
          </li>)}
        </ol>
      </li>
      <li className={branch}>
        <p className="flex min-h-10 items-center text-xs font-medium text-muted-foreground">Übergibt an genau einen Agenten</p>
        <ul aria-label="Agenten" className="ml-1">
          {agentOrder.map((agent) => <li key={agent} className={branch}>
            <div className="flex min-h-10 items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <Dot agent={agent} />
                <span className="truncate text-sm font-medium">{agentName(agent)}</span>
                {agent === "general" && <Badge variant="secondary">Rückfall</Badge>}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={`${agentToolList(agent).length} Werkzeuge`}>{agentToolList(agent).length}<span className="max-sm:sr-only"> Werkzeuge</span></span>
            </div>
          </li>)}
        </ul>
      </li>
    </ul>
    <p className="mt-3 text-xs text-muted-foreground">Höchstens zwei KI-Aufrufe pro Nachricht; klare Fragen kommen ganz ohne KI aus.</p>
  </div>;
}

function Agents({ status, runs }: { status?: AiStatus; runs: AssistantRun[] }) {
  const main = status?.model ? shortModel(status.model) : "Hauptmodell";
  const router = status?.router?.model ? shortModel(status.router.model) : main;
  return <ul className="divide-y divide-border/70">
    {agentOrder.map((agent) => {
      const count = runs.filter((run) => run.agent === agent).length;
      return <li key={agent} className="py-3.5 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Dot agent={agent} />{agentName(agent)}
            <Badge variant={agent === "general" ? "secondary" : "outline"}>{agent === "general" ? "Rückfall" : "Spezialist"}</Badge>
          </h3>
          <span className="text-xs tabular-nums text-muted-foreground">{agentToolList(agent).length} Werkzeuge · {count} {count === 1 ? "Lauf" : "Läufe"}</span>
        </div>
        <p className="mt-1 text-sm">{agentInfo[agent].summary}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{agentInfo[agent].scope}</p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {agent === "general"
            ? <>Antwort: <span className="text-foreground">{main}</span> · Smalltalk ohne Modell</>
            : <>Werkzeugwahl: <span className="text-foreground">{router}</span> · Antwort: <span className="text-foreground">{main}</span></>}
        </p>
      </li>;
    })}
  </ul>;
}

// The tools of one run as small chips: what was done, the tool's technical name and how it ended (icon plus text for screen readers).
function Calls({ calls }: { calls: RunCall[] }) {
  return <ul aria-label="Werkzeugaufrufe" className="col-span-2 mt-1.5 flex flex-wrap gap-1">
    {calls.map((call, index) => {
      const { icon: Icon, tone } = callIcon[call.state];
      return <li key={`${index}:${call.tool}`} title={`${call.label} · ${callStateLabel[call.state]}`}
        className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-muted/70 px-1.5 py-0.5 text-xs">
        <Icon aria-hidden="true" className={cn("size-3 shrink-0", tone)} />
        <span className="sr-only">{callStateLabel[call.state]}: </span>
        <span className="min-w-0 break-words">{call.summary}</span>
        <span className="sr-only">, Werkzeug </span>
        <code className="shrink-0 font-mono text-2xs text-muted-foreground">{call.tool}</code>
      </li>;
    })}
  </ul>;
}

function Runs({ runs }: { runs: AssistantRun[] }) {
  if (!runs.length) return <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border/70 p-5">
    <Inbox aria-hidden="true" className="size-5 text-muted-foreground" />
    <div>
      <p className="text-sm font-medium">Noch keine Läufe</p>
      <p className="mt-0.5 text-xs text-muted-foreground">Jede Frage an den Assistenten erscheint hier mit Agent, Werkzeugen, Status und Dauer.</p>
    </div>
    <Button type="button" variant="outline" size="sm" onClick={() => askAssistant()}><MessageSquareText aria-hidden="true" />Assistent öffnen</Button>
  </div>;
  return <FinancialData as="ul" aria-label="Letzte Läufe" className="divide-y divide-border/70">
    {runs.map((run) => <li key={run.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="truncate text-sm" title={run.question}>{run.question}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <time dateTime={new Date(run.at).toISOString()} className="tabular-nums">{timeFormat.format(run.at)}</time>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1.5"><Dot agent={run.agent} />{run.agent ? agentName(run.agent) : "unbekannt"}</span>
          {run.via && <><span aria-hidden="true">·</span><span>{viaLabel[run.via]}</span></>}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <Badge variant={statusTone[run.status]}>{runStatusLabel[run.status]}</Badge>
        {run.ms !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{duration(run.ms)}</span>}
      </div>
      {run.calls.length > 0 && <Calls calls={run.calls} />}
    </li>)}
  </FinancialData>;
}

function Tools() {
  return <div>
    <table className="w-full text-sm">
      <caption className="sr-only">Werkzeuge je Agent</caption>
      <thead className="sr-only"><tr><th scope="col">Agent</th><th scope="col">Werkzeuge</th></tr></thead>
      <tbody className="divide-y divide-border/70">
        {agentOrder.map((agent) => <tr key={agent} className="align-top">
          <th scope="row" className="w-44 py-3 pr-4 text-left font-medium max-sm:block max-sm:w-auto max-sm:pb-1.5">
            <span className="inline-flex items-center gap-2"><Dot agent={agent} />{agentName(agent)}</span>
          </th>
          <td className="py-3 max-sm:block max-sm:pt-0">
            <ul className="flex flex-wrap gap-1.5" aria-label={`Werkzeuge ${agentName(agent)}`}>
              {agentToolList(agent).map((tool) => <li key={tool} title={tool}
                className="inline-flex items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 text-xs">
                {toolLabel[tool]}
                {changesData(tool) && <><span aria-hidden="true" className="size-1.5 rounded-full bg-warning" /><span className="sr-only">(ändert Daten)</span></>}
              </li>)}
            </ul>
          </td>
        </tr>)}
      </tbody>
    </table>
    <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />ändert Daten – nur nach deiner Bestätigung
    </p>
  </div>;
}

async function readStatus(): Promise<AiStatus> {
  try {
    const response = await fetch("/api/ai/status", { cache: "no-store" });
    return response.ok ? await response.json() as AiStatus : { available: false, model: "", error: `HTTP ${response.status}` };
  } catch {
    return { available: false, model: "", error: "nicht erreichbar" };
  }
}

type FeedbackOverview = {
  file: string;
  count: { total: number; like: number; dislike: number; withComment: number };
  latest: { id: string; rating: "like" | "dislike"; summary: string; recordedAt: string }[];
};
type FeedbackLoad = { state: "loading" } | { state: "ready"; data: FeedbackOverview } | { state: "admin" } | { state: "error" };

async function readFeedbackOverview(): Promise<FeedbackLoad> {
  try {
    const response = await fetch("/api/assistant-feedback", { cache: "no-store" });
    if (response.status === 403) return { state: "admin" };
    if (!response.ok) return { state: "error" };
    const data = await response.json() as Partial<FeedbackOverview>;
    return typeof data.file === "string" && data.count && Array.isArray(data.latest) ? { state: "ready", data: data as FeedbackOverview } : { state: "error" };
  } catch {
    return { state: "error" };
  }
}

const copilotPrompt = "Lies assistant-feedback.json. Fang bei den Einträgen mit rating \"dislike\" an, finde zu jedem die Ursache im Code und behebe sie mit einem Test.";

function Feedback({ load }: { load: FeedbackLoad }) {
  return <div className="space-y-4 text-sm">
    <p className="text-muted-foreground">Jedes 👍 und 👎 unter einer Antwort landet mit Frage, vollständiger Antwort, Agent, Werkzeug, Status-Schritten, Wissens- und Webquellen
      und den Nachrichten davor in einer einzigen JSON-Datei. Kontonummern, E-Mail-Adressen und Passwörter werden vorher entfernt.</p>
    {load.state === "loading" ? <p className="text-muted-foreground">Lade …</p>
      : load.state === "admin" ? <p className="text-muted-foreground">Die Feedback-Datei kann nur der Administrator ansehen und herunterladen.</p>
        : load.state === "error" ? <p className="text-muted-foreground">Die Feedback-Datei ist gerade nicht lesbar.</p>
          : <>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">Datei</dt>
              <dd className="min-w-0"><code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">{load.data.file}</code></dd>
              <dt className="text-muted-foreground">Einträge</dt>
              <dd className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
                <span>{load.data.count.total}</span>
                <span className="inline-flex items-center gap-1"><ThumbsUp aria-hidden="true" className="size-3.5 text-primary" /><span className="sr-only">Hilfreich: </span>{load.data.count.like}</span>
                <span className="inline-flex items-center gap-1"><ThumbsDown aria-hidden="true" className="size-3.5" /><span className="sr-only">Nicht hilfreich: </span>{load.data.count.dislike}</span>
                <span className="text-muted-foreground">{load.data.count.withComment} mit Kommentar</span>
              </dd>
            </dl>
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="sm" variant="outline"><a href="/api/assistant-feedback?download=1" download="assistant-feedback.json">
                <Download aria-hidden="true" />Herunterladen</a></Button>
              <p className="text-xs text-muted-foreground">Für Copilot, z. B.: „{copilotPrompt}“</p>
            </div>
            {load.data.latest.length > 0 && <FinancialData as="ul" aria-label="Neuestes Feedback" className="divide-y divide-border/70">
              {load.data.latest.map((entry) => <li key={entry.id} className="flex items-start gap-3 py-2.5">
                {entry.rating === "like" ? <ThumbsUp aria-label="Hilfreich" className="mt-0.5 size-4 shrink-0 text-primary" />
                  : <ThumbsDown aria-label="Nicht hilfreich" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 break-words">{entry.summary.replace(/^(?:👍|👎)\s*/u, "")}</span>
                <time dateTime={entry.recordedAt} className="shrink-0 text-xs text-muted-foreground tabular-nums">{timeFormat.format(new Date(entry.recordedAt))}</time>
              </li>)}
            </FinancialData>}
          </>}
  </div>;
}

/** Read-only admin view of the assistant's orchestrator: tree, agents, recent runs, tools and the feedback file. */
export function OrchestratorAdmin() {
  const { state } = useFinance();
  const runs = useMemo(() => assistantRuns(state.assistantChat ?? []), [state.assistantChat]);
  const [status, setStatus] = useState<AiStatus>();
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<FeedbackLoad>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    void readStatus().then((next) => { if (alive) { setStatus(next); setLoading(false); } });
    void readFeedbackOverview().then((next) => { if (alive) setFeedback(next); });
    return () => { alive = false; };
  }, []);
  const refresh = () => {
    setLoading(true);
    void readStatus().then((next) => { setStatus(next); setLoading(false); });
    void readFeedbackOverview().then(setFeedback);
  };
  const times = runs.flatMap((run) => run.ms === undefined ? [] : [run.ms]).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : undefined;

  return <div className="mx-auto max-w-4xl">
    <PageHeading title="Orchestrator" description="Interne Ansicht des Finanz-Assistenten – nur lesen.">
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="ghost" size="sm"><Link href="/einstellungen"><ChevronLeft aria-hidden="true" />Einstellungen</Link></Button>
        <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw aria-hidden="true" className={cn(loading && "animate-spin motion-reduce:animate-none")} />Aktualisieren
        </Button>
      </div>
    </PageHeading>
    <div className="space-y-6">
      <Section id="orchestrator-tree" title="Aufbau"><Tree status={status} loading={loading} /></Section>
      <Section id="orchestrator-agents" title="Agenten" meta="4 Spezialisten und der allgemeine Chat"><Agents status={status} runs={runs} /></Section>
      <Section id="orchestrator-runs" title="Letzte Läufe"
        meta={runs.length ? `${runs.length} ${runs.length === 1 ? "Lauf" : "Läufe"}${median !== undefined ? ` · Median ${duration(median)}` : ""}` : undefined}>
        <Runs runs={runs} />
      </Section>
      <Section id="orchestrator-tools" title="Werkzeuge" meta="Jedes Werkzeug gehört genau einem Agenten"><Tools /></Section>
      <Section id="orchestrator-feedback" title="Feedback" meta="👍/👎 aus dem Chat, für die Fehlersuche mit Copilot"><Feedback load={feedback} /></Section>
    </div>
  </div>;
}
