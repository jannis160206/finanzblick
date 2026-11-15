"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { m } from "motion/react";
import {
  Ban, Check, CheckCheck, ChevronLeft, ClipboardCheck, Clock, Cpu, Download, Globe, Inbox, ListChecks, MessageSquareText, RefreshCw, RotateCcw, Save, Sparkles,
  ThumbsDown, ThumbsUp, Undo2, Workflow, X, type LucideIcon,
} from "lucide-react";
import { OrchestratorNav } from "@/components/orchestrator-nav";
import { dialogSpring, useMotionMode } from "@/components/ui/premium-dialog/motion";
import { FinancialData } from "@/components/financial-data";
import { useFinance } from "@/components/finance-provider";
import { PageHeading } from "@/components/finance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { askAssistant } from "@/lib/assistant-bus";
import { agentLabel, type AgentId } from "@/lib/assistant/orchestrator";
import {
  agentInfo, agentOrder, agentToolList, assistantRuns, callStateLabel, changesData, orchestratorSteps, reviewStep, runStatusLabel, toolLabel, viaLabel,
  type AssistantRun, type CallState, type RunCall, type RunModel, type RunStatus,
} from "@/lib/assistant/orchestrator-info";
import { costOverview, MONTHLY_BUDGET_USD, taskLabel, type AiTask } from "@/lib/ai/models";
import { MAX_PROMPT_LENGTH, promptGroupName, promptLabel, type PromptId, type PromptMeta } from "@/lib/ai/agent-prompts";
import type { OrchestratorView } from "@/lib/assistant/orchestrator-pages";
import { MAX_ACTIVE_RULES, statusLabel, type FeedbackRule, type RuleStatus } from "@/lib/assistant/feedback-rules";
import { cn } from "@/lib/utils";

type AiStatus = {
  available: boolean; model: string; label?: string; error?: string;
  router?: { model: string; available: boolean };
  local?: { available: boolean; model: string; error?: string };
  cloud?: { provider: "deepseek"; available: boolean; models: Record<"fast" | "pro" | "reasoning", string>; error?: string };
  /** Which model answers each task right now (with the local model as fallback). */
  routing?: { task: AiTask; label: string; model: string; fallback?: boolean }[];
  /** Token counters per model since the server started. */
  usage?: Record<string, { calls: number; input: number; output: number; cached: number }>;
};
const routeLabel = (status: AiStatus | undefined, task: AiTask) => status?.routing?.find((item) => item.task === task)?.label;

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
  if (status.cloud && !status.cloud.available)
    return <Badge variant="warning" title={`DeepSeek: ${status.cloud.error ?? "nicht erreichbar"}`}>Lokal (Qwen) aktiv · DeepSeek {status.cloud.error ?? "nicht erreichbar"}</Badge>;
  return <Badge variant="success" title={status.model}>KI bereit · {status.label ?? shortModel(status.model)}{status.cloud && status.local?.available ? " · Qwen als Rückfall" : ""}</Badge>;
}

/** Which model answers which task, and what happens when DeepSeek fails. */
function Models({ status, loading }: { status?: AiStatus; loading: boolean }) {
  if (loading && !status) return <p className="text-sm text-muted-foreground">Prüfe die Modelle …</p>;
  const routing = status?.routing ?? [];
  const local = status?.local;
  return <div>
    <ul aria-label="Modell je Aufgabe" className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
      {routing.map((item) => <li key={item.task} className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border/50 py-1.5 text-sm">
        <span className="text-muted-foreground">{taskLabel[item.task]}</span>
        <span className="min-w-0 truncate text-right font-medium" title={item.model}>{item.label}{item.fallback && status?.cloud ? <span className="font-normal text-muted-foreground"> · Rückfall</span> : null}</span>
      </li>)}
    </ul>
    <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
      <Cpu aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      {status?.cloud
        ? <span>Fällt DeepSeek aus (Netzwerk, Rate-Limit, Key), antwortet automatisch das lokale Modell{local ? ` (${local.available ? "bereit" : `gerade ${local.error ?? "nicht erreichbar"}`})` : ""}. Namen, IBANs und Nummern gehen nur pseudonymisiert in die Cloud; ganze Kontoauszüge bleiben lokal.</span>
        : <span>Ohne DeepSeek-Key antwortet nur das lokale Modell (Qwen auf der NPU).</span>}
    </p>
  </div>;
}

// Branch lines of the tree: a vertical rail that ends at the last item, and a short tick to each node.
const branch = "relative pl-7 before:absolute before:left-2 before:top-0 before:h-full before:w-px before:bg-border last:before:h-5 " +
  "after:absolute after:left-2 after:top-5 after:h-px after:w-4 after:bg-border";

const agentName = (agent: AgentId) => agent === "general" ? "Allgemeiner Chat" : agentLabel[agent];

function NodeTitle({ icon: Icon, title, detail, calls }: { icon: LucideIcon; title: string; detail: string; calls: string }) {
  return <div className="flex min-h-10 items-start justify-between gap-3 py-1.5">
    <span className="min-w-0">
      <span className="flex items-center gap-2 text-sm font-semibold"><Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />{title}</span>
      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{detail}</span>
    </span>
    <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">{calls}</span>
  </div>;
}

function ModelBadge({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "pro" | "local" }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs ring-1 ring-inset",
    tone === "pro" ? "bg-primary/10 text-primary ring-primary/20" : tone === "local" ? "bg-warning-soft text-warning ring-warning/25" : "bg-background text-foreground ring-border/60")}>
    <span className="text-muted-foreground">{label}:</span>{value}
  </span>;
}

function ToolChip({ label, tool, changes }: { label: string; tool: string; changes?: boolean }) {
  return <li title={tool} className="inline-flex items-center gap-1 rounded-md bg-muted/70 px-1.5 py-0.5 text-2xs">
    {label}{changes && <><span aria-hidden="true" className="size-1.5 rounded-full bg-warning" /><span className="sr-only">(ändert Daten)</span></>}
  </li>;
}

/** The structure as a tree: orchestrator → rules, supervisor with its specialists and their tools, the local fallback. */
function Topology({ status, loading }: { status?: AiStatus; loading: boolean }) {
  const [rules, supervisor, fallback] = orchestratorSteps;
  const local = status?.local && !status.local.available ? `Qwen · ${status.local.error ?? "nicht erreichbar"}` : "Qwen auf der NPU";
  return <div aria-label="Orchestrator-Baum" role="group">
    <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 rounded-xl border border-border/70 bg-muted/40 px-3 py-2">
      <span className="flex items-center gap-2 text-sm font-semibold"><Workflow aria-hidden="true" className="size-4 text-primary" />Orchestrator</span>
      <ModelPill status={status} loading={loading} />
    </div>
    <ul aria-label="Wege des Orchestrators" className="ml-3">
      <li className={branch}><NodeTitle icon={ListChecks} title={rules.title} detail={rules.detail} calls={rules.calls} /></li>
      <li className={branch}>
        <NodeTitle icon={Sparkles} title={supervisor.title} detail={supervisor.detail} calls={supervisor.calls} />
        <p className="flex flex-wrap gap-1.5 pb-2">
          <ModelBadge label="Plant" value={routeLabel(status, "supervise") ?? "DeepSeek Flash"} />
          <ModelBadge label="Schreibt" value={routeLabel(status, "synthesize") ?? "DeepSeek V4 Pro"} tone="pro" />
        </p>
        <ul aria-label="Spezialisten" className="ml-1">
          {agentOrder.map((agent) => <li key={agent} className={branch}>
            <div className="flex min-h-10 items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2"><Dot agent={agent} /><span className="truncate text-sm font-medium">{agentName(agent)}</span></span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{agentToolList(agent).length}<span className="max-sm:sr-only"> Werkzeuge</span></span>
            </div>
            <ul aria-label={`Werkzeuge im Baum: ${agentName(agent)}`} className="flex flex-wrap gap-1 pb-2">
              {agentToolList(agent).map((tool) => <ToolChip key={tool} tool={tool} label={toolLabel[tool]} changes={changesData(tool)} />)}
            </ul>
          </li>)}
          <li className={branch}>
            <div className="flex min-h-10 items-center gap-2 text-sm font-medium"><Globe aria-hidden="true" className="size-3.5 text-muted-foreground" />Recherche</div>
            <ul aria-label="Recherche-Werkzeuge" className="flex flex-wrap gap-1 pb-2">
              <ToolChip tool="web" label="Websuche" /><ToolChip tool="knowledge_search" label="Finanzwissen" />
            </ul>
          </li>
        </ul>
      </li>
      <li className={branch}>
        <NodeTitle icon={Cpu} title={fallback.title} detail={fallback.detail} calls={fallback.calls} />
        <p className="pb-1"><ModelBadge label="Modell" value={local} tone="local" /></p>
      </li>
    </ul>
    <div role="group" aria-label="Im Hintergrund" className="mt-4 rounded-xl border border-border/70 bg-muted/30 px-3 pb-2">
      <NodeTitle icon={ClipboardCheck} title={reviewStep.title} detail={reviewStep.detail} calls={reviewStep.calls} />
      <p className="flex flex-wrap gap-1.5">
        <ModelBadge label="Prüft" value={routeLabel(status, "rule") ?? "DeepSeek V4 Pro"} tone="pro" />
        <ModelBadge label="Eval" value={routeLabel(status, "supervise") ?? "DeepSeek Flash"} />
        <ModelBadge label="Ändert" value="System-Prompts der Agenten" />
      </p>
    </div>
    <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />ändert Daten – nur nach deiner Bestätigung; der Supervisor nutzt nur lesende Werkzeuge.
    </p>
  </div>;
}

const usd = (value: number) => `${value.toLocaleString("de-AT", { minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 })} $`;
const cents = (value: number) => `${(value * 100).toLocaleString("de-AT", { maximumFractionDigits: 2 })} Cent`;

/** What DeepSeek costs: per question, how many questions the monthly budget covers, and the counters since the server started. */
function Costs({ status, loading }: { status?: AiStatus; loading: boolean }) {
  if (loading && !status) return <p className="text-sm text-muted-foreground">Prüfe die Modelle …</p>;
  const costs = costOverview(status?.usage);
  const calls = costs.models.reduce((sum, item) => sum + item.calls, 0);
  const tiles = [
    { label: "Pro Frage", value: `≈ ${cents(costs.perQuestion)}`, hint: costs.measured ? "gemessen seit Serverstart" : "Richtwert ohne Cache-Treffer" },
    { label: `Fragen für ${MONTHLY_BUDGET_USD} $ im Monat`, value: `≈ ${costs.perBudget.toLocaleString("de-AT")}`, hint: "zur Spitzenzeit, nachts doppelt so viele" },
    { label: "Seit Serverstart", value: usd(costs.total), hint: `${calls.toLocaleString("de-AT")} ${calls === 1 ? "Aufruf" : "Aufrufe"} bei DeepSeek` },
  ];
  return <div className="space-y-3">
    <dl aria-label="Kosten" className="grid gap-3 sm:grid-cols-3">
      {tiles.map((tile) => <div key={tile.label} className="rounded-xl border border-border/60 bg-background/50 p-3">
        <dt className="text-xs text-muted-foreground">{tile.label}</dt>
        <dd className="mt-1 text-lg font-semibold tracking-tight tabular-nums">{tile.value}</dd>
        <dd className="text-2xs text-muted-foreground">{tile.hint}</dd>
      </div>)}
    </dl>
    {costs.models.length > 0 && <ul aria-label="Kosten je Modell" className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
      {costs.models.map((item) => <li key={item.model} className="flex items-baseline justify-between gap-3 border-b border-border/50 py-1.5 text-sm">
        <span className="text-muted-foreground">{item.model} · {item.calls.toLocaleString("de-AT")}×</span><span className="font-medium tabular-nums">{usd(item.cost)}</span>
      </li>)}
    </ul>}
    <p className="text-xs leading-relaxed text-muted-foreground">Listenpreise von DeepSeek zur Spitzenzeit (Stand 15.11.2026). Wiederholte System-Prompts kommen
      meist aus dem Cache und kosten einen Bruchteil, die echten Kosten liegen daher eher darunter.</p>
  </div>;
}

function Agents({ status, runs }: { status?: AiStatus; runs: AssistantRun[] }) {
  const main = routeLabel(status, "chat") ?? (status?.model ? shortModel(status.model) : "Hauptmodell");
  const router = routeLabel(status, "route") ?? (status?.router?.model ? shortModel(status.router.model) : main);
  const action = routeLabel(status, "action") ?? router;
  const reasoning = routeLabel(status, "reasoning") ?? main;
  const web = routeLabel(status, "web") ?? main;
  const writer = routeLabel(status, "synthesize") ?? main;
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
            ? <>Antwort: <span className="text-foreground">{writer}</span> · Smalltalk: <span className="text-foreground">{main}</span> · Websuche: <span className="text-foreground">{web}</span></>
            : <>Werkzeugwahl: <span className="text-foreground">{router}</span> · Aktion: <span className="text-foreground">{action}</span> · Antwort: <span className="text-foreground">{writer}</span>
              {" "}· Steuer-Analyse: <span className="text-foreground">{reasoning}</span></>}
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

function RunModels({ models }: { models: RunModel[] }) {
  // The same model for routing and answer is named once; a fallback is always shown with its reason.
  const shown = models.filter((item, index) => item.fallback || models.findIndex((other) => other.label === item.label && !other.fallback) === index);
  return <span role="group" className="inline-flex flex-wrap items-center gap-x-1.5" aria-label="Modelle">
    {shown.map((item, index) => <span key={`${index}:${item.label}`} data-model={item.model}
      title={`${item.task}${item.fallback ? ` · Rückfall${item.reason ? `, weil DeepSeek: ${item.reason}` : ""}` : ""}`}
      className="inline-flex items-center gap-1">
      {index > 0 && <span aria-hidden="true" className="text-muted-foreground">·</span>}
      <Cpu aria-hidden="true" className={cn("size-3", item.fallback && "text-warning")} />{item.label}
      {item.fallback && <span> (Rückfall{item.reason && <span className="sr-only">, weil DeepSeek: {item.reason}</span>})</span>}
    </span>)}
  </span>;
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
          {run.models.length > 0 && <><span aria-hidden="true">·</span><RunModels models={run.models} /></>}
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

type LearnedChange = FeedbackRule & { votes?: { up: number; down: number } };
type RulesOverview = { file: string; loop: string; count: Partial<Record<RuleStatus, number>>; rules: LearnedChange[] };
type RulesLoad = { state: "loading" } | { state: "ready"; data: RulesOverview } | { state: "admin" } | { state: "error" };
type RuleAction = "enable" | "disable" | "recheck";

async function readRulesOverview(): Promise<RulesLoad> {
  try {
    const response = await fetch("/api/assistant-rules", { cache: "no-store" });
    if (response.status === 403) return { state: "admin" };
    if (!response.ok) return { state: "error" };
    const data = await response.json() as Partial<RulesOverview>;
    return typeof data.file === "string" && Array.isArray(data.rules) ? { state: "ready", data: data as RulesOverview } : { state: "error" };
  } catch {
    return { state: "error" };
  }
}

const ruleTone: Record<RuleStatus, "success" | "info" | "warning" | "secondary" | "destructive"> = {
  active: "success", checking: "info", pending: "info", rejected: "warning", vague: "secondary", unusable: "secondary", disabled: "secondary", error: "destructive",
};
const scopeName = (rule: FeedbackRule) => !rule.scope || rule.scope === "all" ? "alle Bereiche" : rule.scope === "general" ? "Allgemeiner Chat" : agentLabel[rule.scope];
const score = (value: { passed: number; total: number; hard: number }) => `${value.passed}/${value.total}${value.hard ? ` · ${value.hard} Sicherheitsfehler` : ""}`;
const changeTarget = (rule: FeedbackRule) => rule.kind === "prompt" && rule.prompt ? `Prompt ${rule.prompt.mode === "replace" ? "geändert" : "ergänzt"} · ${promptLabel(rule.prompt.id)}`
  : rule.rule ? `Regel · ${rule.target === "routing" ? "Werkzeugwahl" : "Antworten"} · ${scopeName(rule)}` : undefined;

function ChangeButton({ rule, loop, working, onAction }: { rule: LearnedChange; loop: string; working?: string; onAction: (id: string, action: RuleAction) => void }) {
  const prompt = rule.kind === "prompt";
  const props = { type: "button" as const, size: "sm" as const, className: "shrink-0", disabled: working === rule.id };
  if (rule.status === "active") return <Button {...props} variant="outline" onClick={() => onAction(rule.id, "disable")}
    aria-label={`${prompt ? "Änderung zurücknehmen" : "Regel deaktivieren"}: ${rule.rule}`}>{prompt ? <Undo2 aria-hidden="true" /> : <Ban aria-hidden="true" />}
    {prompt ? "Zurücknehmen" : "Deaktivieren"}</Button>;
  if (rule.status === "disabled" && rule.check?.passed) return <Button {...props} variant="outline" onClick={() => onAction(rule.id, "enable")}
    aria-label={`${prompt ? "Änderung wieder anwenden" : "Regel aktivieren"}: ${rule.rule}`}><Check aria-hidden="true" />{prompt ? "Wieder anwenden" : "Aktivieren"}</Button>;
  if (["pending", "error", "rejected", "unusable"].includes(rule.status)) return <Button {...props} variant="ghost" disabled={props.disabled || loop.startsWith("aus")}
    onClick={() => onAction(rule.id, "recheck")}><RefreshCw aria-hidden="true" />Erneut prüfen</Button>;
  return null;
}

/**
 * What the review agent learned from 👎 comments: which prompt it changed and how, its retest, the gold eval, the votes since,
 * and a switch to take a change back.
 */
function Learned({ load, onAction, working }: { load: RulesLoad; onAction: (id: string, action: RuleAction) => void; working?: string }) {
  return <div className="space-y-4 text-sm">
    <p className="text-muted-foreground">Jedes 👍 und 👎 geht an den Prüfungs-Agent (DeepSeek V4 Pro). Bei einem 👎 mit konkretem Kommentar sucht er den Prompt,
      der schuld ist – Planung, Antwort, Antwortregeln, Stimme oder Werkzeugwahl eines Agenten – und ändert ihn um einen Satz. Dann prüft er zweimal: Er stellt
      die Frage mit dem geänderten Prompt erneut und beurteilt, ob die Beschwerde behoben ist, und die Gold-Eval (80 Fragen und 6 Antworten) muss gleich gut
      oder besser bleiben. Erst dann gilt die Änderung, ab der nächsten Frage; vage Kommentare wie „war schlecht“ ändern nichts. Höchstens {MAX_ACTIVE_RULES} Änderungen sind aktiv.</p>
    {load.state === "loading" ? <p className="text-muted-foreground">Lade …</p>
      : load.state === "admin" ? <p className="text-muted-foreground">Die Änderungen kann nur der Administrator ansehen und zurücknehmen.</p>
        : load.state === "error" ? <p className="text-muted-foreground">Die Datei des Prüfungs-Agents ist gerade nicht lesbar.</p>
          : !load.data.rules.length ? <p className="text-muted-foreground">Noch nichts gelernt. Ein 👎 mit Kommentar unter einer Antwort startet die Prüfung.</p>
            : <ul aria-label="Änderungen des Prüfungs-Agents" className="divide-y divide-border/70">
              {load.data.rules.map((rule) => {
                const target = changeTarget(rule);
                return <li key={rule.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <Badge variant={ruleTone[rule.status]}>{statusLabel[rule.status]}</Badge>
                      {target && <span>{target}</span>}
                      <time dateTime={rule.updatedAt} className="tabular-nums">{timeFormat.format(new Date(rule.updatedAt))}</time>
                    </div>
                    {rule.rule ? <p className="font-medium break-words">{rule.rule}</p>
                      : <p className="text-muted-foreground">{rule.status === "checking" ? "Der Prüfungs-Agent sieht sich den Kommentar an …"
                        : rule.status === "pending" ? "Wartet auf DeepSeek." : "Keine Änderung"}</p>}
                    {rule.prompt?.mode === "replace" && rule.prompt.before && <p className="break-words text-xs text-muted-foreground">Statt: „{rule.prompt.before}“</p>}
                    <p className="break-words text-xs text-muted-foreground">Aus dem Kommentar: „{rule.comment}“</p>
                    {rule.review && <p className={cn("break-words text-xs", rule.review.fixed ? "text-muted-foreground" : "text-warning")}>
                      Nachtest: {rule.review.fixed ? "behoben" : "nicht behoben"} – {rule.review.note}</p>}
                    {rule.check && <p className="text-xs tabular-nums text-muted-foreground">Gold-Eval ohne → mit {rule.kind === "prompt" ? "Änderung" : "Regel"}: {score(rule.check.baseline)} → {score(rule.check.candidate)}</p>}
                    {rule.check?.worse?.length ? <p className="break-words text-xs text-muted-foreground">Schlechter bei: {rule.check.worse.map((label) => `„${label}“`).join(", ")}</p> : null}
                    {rule.votes && <p className="flex flex-wrap items-center gap-x-2 text-xs tabular-nums text-muted-foreground">
                      <span>{rule.status === "active" ? "Seit der Änderung" : "Solange sie galt"}:</span>
                      <span className="inline-flex items-center gap-1"><ThumbsUp aria-hidden="true" className="size-3.5" /><span className="sr-only">Hilfreich: </span>{rule.votes.up}</span>
                      <span className="inline-flex items-center gap-1"><ThumbsDown aria-hidden="true" className="size-3.5" /><span className="sr-only">Nicht hilfreich: </span>{rule.votes.down}</span>
                    </p>}
                    {rule.reason && <p className={cn("text-xs", rule.status === "rejected" || rule.status === "error" ? "text-warning" : "text-muted-foreground")}>{rule.reason}</p>}
                  </div>
                  <ChangeButton rule={rule} loop={load.data.loop} working={working} onAction={onAction} />
                </li>;
              })}
            </ul>}
    {load.state === "ready" && <p className="text-xs text-muted-foreground">Datei: <code className="break-all rounded bg-muted px-1.5 py-0.5">{load.data.file}</code> · Prüfung: {load.data.loop}</p>}
  </div>;
}

type PromptEntry = PromptMeta & { default: string; text: string; custom: boolean };
type PromptLoad = { state: "loading" } | { state: "ready"; file: string; prompts: PromptEntry[] } | { state: "admin" } | { state: "error" };

async function readPrompts(): Promise<PromptLoad> {
  try {
    const response = await fetch("/api/agent-prompts", { cache: "no-store" });
    if (response.status === 403) return { state: "admin" };
    if (!response.ok) return { state: "error" };
    const data = await response.json() as { file?: unknown; prompts?: unknown };
    return typeof data.file === "string" && Array.isArray(data.prompts) ? { state: "ready", file: data.file, prompts: data.prompts as PromptEntry[] } : { state: "error" };
  } catch {
    return { state: "error" };
  }
}

const groupName = promptGroupName;

/** Every agent's system prompt: pick one, edit it, save it or put it back to the default; the next chat run uses it. */
function PromptEditor({ load, onChange }: { load: PromptLoad; onChange: (next: PromptLoad) => void }) {
  const [selected, setSelected] = useState<PromptId>("supervisor");
  const [drafts, setDrafts] = useState<Partial<Record<PromptId, string>>>({});
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const field = useId();
  if (load.state === "loading") return <p className="text-sm text-muted-foreground">Lade …</p>;
  if (load.state === "admin") return <p className="text-sm text-muted-foreground">Die Prompts kann nur der Administrator ansehen und bearbeiten.</p>;
  if (load.state === "error") return <p className="text-sm text-muted-foreground">Die Prompts sind gerade nicht lesbar.</p>;
  const entry = load.prompts.find((item) => item.id === selected) ?? load.prompts[0];
  if (!entry) return null;
  const draft = drafts[entry.id] ?? entry.text;
  const dirty = draft.trim() !== entry.text.trim();
  const forget = (id: PromptId) => setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
  const save = async (body: { id: PromptId; text: string } | { id: PromptId; reset: true }) => {
    setSaving(true);
    setNote(undefined);
    try {
      const response = await fetch("/api/agent-prompts", { method: "PUT", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body) });
      const data = await response.json() as { prompts?: unknown; error?: unknown };
      if (!response.ok || !Array.isArray(data.prompts)) throw new Error(typeof data.error === "string" ? data.error : "Speichern hat nicht geklappt.");
      onChange({ state: "ready", file: load.file, prompts: data.prompts as PromptEntry[] });
      forget(body.id);
      setNote({ ok: true, text: "reset" in body ? "Auf Standard zurückgesetzt – gilt ab der nächsten Frage." : "Gespeichert – gilt ab der nächsten Frage." });
    } catch (error) {
      setNote({ ok: false, text: error instanceof Error ? error.message : "Speichern hat nicht geklappt." });
    } finally {
      setSaving(false);
    }
  };
  const groups = [...new Set(load.prompts.map((item) => item.group))];
  return <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
    <nav aria-label="Prompts" className="space-y-2">
      {groups.map((group) => <div key={group}>
        <p className="px-2 pb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{groupName(group)}</p>
        <ul className="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
          {load.prompts.filter((item) => item.group === group).map((item) => <li key={item.id}>
            <button type="button" aria-current={item.id === entry.id ? "true" : undefined} onClick={() => { setSelected(item.id); setNote(undefined); }}
              className="flex min-h-9 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-muted aria-[current=true]:font-medium">
              <span>{item.label}</span>
              {(item.custom || drafts[item.id] !== undefined) && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />}
              {item.custom && <span className="sr-only">(angepasst)</span>}
            </button>
          </li>)}
        </ul>
      </div>)}
    </nav>
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{groupName(entry.group)} · {entry.label}</h3>
        <Badge variant={entry.custom ? "info" : "secondary"}>{entry.custom ? "Angepasst" : "Standard"}</Badge>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{entry.hint}</p>
      <label htmlFor={field} className="sr-only">System-Prompt: {groupName(entry.group)} · {entry.label}</label>
      <textarea id={field} value={draft} rows={14} maxLength={MAX_PROMPT_LENGTH} spellCheck={false}
        onChange={(event) => { const value = event.target.value; setDrafts((current) => ({ ...current, [entry.id]: value })); }}
        className="block min-h-64 w-full resize-y rounded-xl border border-input bg-background/60 p-3 font-mono text-xs leading-relaxed text-foreground shadow-inner focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-2xs tabular-nums text-muted-foreground">{draft.length.toLocaleString("de-AT")} / {MAX_PROMPT_LENGTH.toLocaleString("de-AT")} Zeichen</span>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={saving || !entry.custom && !dirty}
            onClick={() => entry.custom ? void save({ id: entry.id, reset: true }) : forget(entry.id)}>
            <RotateCcw aria-hidden="true" />Auf Standard zurücksetzen
          </Button>
          <Button type="button" size="sm" disabled={saving || !dirty || !draft.trim()} onClick={() => void save({ id: entry.id, text: draft })}>
            <Save aria-hidden="true" />Speichern
          </Button>
        </div>
      </div>
      <p role="status" className={cn("min-h-4 text-xs", note?.ok ? "text-success" : "text-destructive")}>{note?.text}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">Datei: <code className="break-all rounded bg-muted px-1.5 py-0.5">{load.file}</code>. Werkzeuglisten,
        JSON-Felder, die Regel für belegte Zahlen und der Datenschutz-Hinweis hängt die App immer an; Namen und IBANs gehen nie an DeepSeek.</p>
    </div>
  </div>;
}

// The header's "Aktualisieren" asks the open subpage to load its data again; the button spins while anything loads.
const RefreshContext = createContext<{ tick: number; track: (work: Promise<unknown>) => void }>({ tick: 0, track: () => undefined });

function useLoad<T>(read: () => Promise<T>, initial: T): [T, (value: T) => void] {
  const { tick, track } = useContext(RefreshContext);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    let alive = true;
    track(read().then((next) => { if (alive) setValue(next); }));
    return () => { alive = false; };
  }, [read, tick, track]);
  return [value, setValue];
}

/** Header and navigation of the orchestrator view; the subpages render below. */
export function OrchestratorShell({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(0);
  const track = useCallback((work: Promise<unknown>) => {
    setPending((count) => count + 1);
    void work.finally(() => setPending((count) => Math.max(0, count - 1)));
  }, []);
  const value = useMemo(() => ({ tick, track }), [tick, track]);
  return <div className="mx-auto max-w-4xl">
    <PageHeading title="Orchestrator" description="Interne Ansicht des Finanz-Assistenten: Aufbau, Prompts, Läufe und Feedback.">
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="ghost" size="sm"><Link href="/einstellungen"><ChevronLeft aria-hidden="true" />Einstellungen</Link></Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setTick((count) => count + 1)} disabled={pending > 0}>
          <RefreshCw aria-hidden="true" className={cn(pending > 0 && "animate-spin motion-reduce:animate-none")} />Aktualisieren
        </Button>
      </div>
    </PageHeading>
    <OrchestratorNav />
    <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
  </div>;
}

function BuildView() {
  const [status] = useLoad<AiStatus | undefined>(readStatus, undefined);
  return <>
    <Section id="orchestrator-tree" title="Topologie" meta="Orchestrator → Supervisor → Spezialisten → Werkzeuge"><Topology status={status} loading={!status} /></Section>
    <Section id="orchestrator-models" title="Modelle" meta="Flash plant, V4 Pro schreibt, lokales Qwen als Rückfall"><Models status={status} loading={!status} /></Section>
    <Section id="orchestrator-costs" title="Kosten" meta={`DeepSeek, Budget ${MONTHLY_BUDGET_USD} $ im Monat`}><Costs status={status} loading={!status} /></Section>
  </>;
}

function AgentsView({ runs }: { runs: AssistantRun[] }) {
  const [status] = useLoad<AiStatus | undefined>(readStatus, undefined);
  const [prompts, setPrompts] = useLoad<PromptLoad>(readPrompts, { state: "loading" });
  const custom = prompts.state === "ready" ? prompts.prompts.filter((item) => item.custom).length : 0;
  return <>
    <Section id="orchestrator-agents" title="Agenten" meta="4 Spezialisten und der allgemeine Chat"><Agents status={status} runs={runs} /></Section>
    <Section id="orchestrator-prompts" title="System-Prompts" meta={prompts.state === "ready" ? `${custom} von ${prompts.prompts.length} angepasst` : undefined}>
      <PromptEditor load={prompts} onChange={setPrompts} />
    </Section>
  </>;
}

function RunsView({ runs }: { runs: AssistantRun[] }) {
  const times = runs.flatMap((run) => run.ms === undefined ? [] : [run.ms]).sort((a, b) => a - b);
  const median = times.length ? times[Math.floor(times.length / 2)] : undefined;
  return <Section id="orchestrator-runs" title="Letzte Läufe"
    meta={runs.length ? `${runs.length} ${runs.length === 1 ? "Lauf" : "Läufe"}${median !== undefined ? ` · Median ${duration(median)}` : ""}` : undefined}>
    <Runs runs={runs} />
  </Section>;
}

function FeedbackView() {
  const [feedback] = useLoad<FeedbackLoad>(readFeedbackOverview, { state: "loading" });
  const [rules, setRules] = useLoad<RulesLoad>(readRulesOverview, { state: "loading" });
  const [working, setWorking] = useState<string>();
  // While the review agent works in the background, the list refreshes itself every few seconds.
  const checking = rules.state === "ready" && rules.data.rules.some((rule) => rule.status === "checking");
  useEffect(() => {
    if (!checking) return;
    const timer = window.setInterval(() => void readRulesOverview().then(setRules), 5000);
    return () => window.clearInterval(timer);
  }, [checking, setRules]);
  const ruleAction = async (id: string, action: RuleAction) => {
    setWorking(id);
    try {
      await fetch("/api/assistant-rules", { method: "PATCH", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify({ id, action }) });
    } finally {
      setRules(await readRulesOverview());
      setWorking(undefined);
    }
  };
  const activeCount = rules.state === "ready" ? rules.data.rules.filter((rule) => rule.status === "active").length : 0;
  return <>
    <Section id="orchestrator-feedback" title="Feedback" meta="👍/👎 aus dem Chat, für die Fehlersuche mit Copilot"><Feedback load={feedback} /></Section>
    <Section id="orchestrator-rules" title="Prüfungs-Agent" meta={rules.state === "ready" ? `${activeCount} aktiv · Prüfung ${rules.data.loop}` : undefined}>
      <Learned load={rules} working={working} onAction={(id, action) => void ruleAction(id, action)} />
    </Section>
  </>;
}

/** One subpage of the admin view of the assistant's orchestrator; it glides in when opened. */
export function OrchestratorAdmin({ view }: { view: OrchestratorView }) {
  const { state } = useFinance();
  const runs = useMemo(() => assistantRuns(state.assistantChat ?? []), [state.assistantChat]);
  const mode = useMotionMode();
  return <m.div key={view} className="space-y-6" data-orchestrator-view={view}
    initial={mode === "full" ? { opacity: 0, y: 8, filter: "blur(2px)" } : false} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
    transition={mode === "full" ? dialogSpring : { duration: 0 }}>
    {view === "aufbau" ? <BuildView />
      : view === "agenten" ? <AgentsView runs={runs} />
        : view === "laeufe" ? <RunsView runs={runs} />
          : view === "werkzeuge" ? <Section id="orchestrator-tools" title="Werkzeuge" meta="Jedes Werkzeug gehört genau einem Agenten"><Tools /></Section>
            : <FeedbackView />}
  </m.div>;
}
