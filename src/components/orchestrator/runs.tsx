"use client";

import { Ban, BrainCircuit, Check, CheckCheck, Clock, Cpu, Inbox, MessageSquareText, Undo2, X, type LucideIcon } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { askAssistant } from "@/lib/assistant-bus";
import { agentName, isAgentKey } from "@/lib/agents/registry";
import { agentLabel, type AgentId } from "@/lib/assistant/orchestrator";
import {
  callStateLabel, runStatusLabel, runTrace, viaLabel, type AssistantRun, type CallState, type RunCall, type RunModel, type RunStatus, type RunTraceStep,
} from "@/lib/assistant/orchestrator-info";
import { cn } from "@/lib/utils";
import { agentIcon, duration, Empty, median, Section, timeFormat } from "./shared";

// One color per agent of the chat history.
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
const chatAgentName = (agent: AgentId) => agent === "general" ? "Allgemeiner Chat" : agentLabel[agent];
const specialistName = (key: string) => isAgentKey(key) ? agentName(key) : key;

function Dot({ agent }: { agent?: AgentId }) {
  return <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", agent ? agentDot[agent] : "bg-border")} />;
}

// The tools of one run as small chips: what was done, the tool's technical name and how it ended (icon plus text for screen readers).
function Calls({ calls, label = "Werkzeugaufrufe", className }: { calls: RunCall[]; label?: string; className?: string }) {
  return <ul aria-label={label} className={cn("flex flex-wrap gap-1", className)}>
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

// The rails of the trace: a vertical line that ends at the last step, and a short tick to each one.
const branch = "relative pl-6 before:absolute before:left-1.5 before:top-0 before:h-full before:w-px before:bg-border last:before:h-3.5 " +
  "after:absolute after:left-1.5 after:top-3.5 after:h-px after:w-3 after:bg-border";

function StepHead({ step }: { step: RunTraceStep }) {
  const name = step.agent ? specialistName(step.agent) : undefined;
  const Icon = step.agent && isAgentKey(step.agent) ? agentIcon[step.agent] : Cpu;
  if (!step.call) return <p className="flex min-h-7 items-center gap-1.5 text-xs font-medium">
    <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />{name}
  </p>;
  const { icon: State, tone } = callIcon[step.call.state];
  return <p className="flex min-h-7 flex-wrap items-center gap-x-1.5 text-xs" title={callStateLabel[step.call.state]}>
    <State aria-hidden="true" className={cn("size-3.5 shrink-0", tone)} />
    <span className="sr-only">{callStateLabel[step.call.state]}: </span>
    <span className="font-medium">{step.call.summary}</span>
    <span className="sr-only">, Werkzeug </span>
    <code className="font-mono text-2xs text-muted-foreground">{step.call.tool}</code>
  </p>;
}

/** Orchestrator → its delegations → the tool calls each specialist made for it. */
function Trace({ steps }: { steps: RunTraceStep[] }) {
  return <div className="mt-2 rounded-xl border border-border/60 bg-muted/25 px-3 py-2">
    <p className="flex items-center gap-1.5 text-xs font-semibold"><BrainCircuit aria-hidden="true" className="size-3.5 text-primary" />Orchestrator</p>
    <ol aria-label="Ablauf des Orchestrators" className="ml-1 mt-0.5">
      {steps.map((step, index) => <li key={`${index}:${step.call?.tool ?? step.agent}`} className={branch}>
        <StepHead step={step} />
        {step.calls.length > 0 && <Calls calls={step.calls} className="ml-5 pb-1.5" label={`Werkzeuge von ${step.agent ? specialistName(step.agent) : "Orchestrator"}`} />}
      </li>)}
    </ol>
  </div>;
}

function RunModels({ models }: { models: RunModel[] }) {
  // The same model for several steps is named once; a fallback is always shown with its reason.
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

function Run({ run }: { run: AssistantRun }) {
  const { steps, flat } = runTrace(run.calls);
  return <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-3 first:pt-0 last:pb-0">
    <div className="min-w-0">
      <p className="truncate text-sm" title={run.question}>{run.question}</p>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <time dateTime={new Date(run.at).toISOString()} className="tabular-nums">{timeFormat.format(run.at)}</time>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-1.5"><Dot agent={run.agent} />{run.agent ? chatAgentName(run.agent) : "unbekannt"}</span>
        {run.via && <><span aria-hidden="true">·</span><span>{viaLabel[run.via]}</span></>}
        {run.models.length > 0 && <><span aria-hidden="true">·</span><RunModels models={run.models} /></>}
      </p>
    </div>
    <div className="flex flex-col items-end gap-1">
      <Badge variant={statusTone[run.status]}>{runStatusLabel[run.status]}</Badge>
      {run.ms !== undefined && <span className="text-xs tabular-nums text-muted-foreground">{duration(run.ms)}</span>}
    </div>
    {(steps.length > 0 || flat.length > 0) && <div className="col-span-2 min-w-0">
      {steps.length > 0 && <Trace steps={steps} />}
      {flat.length > 0 && <Calls calls={flat} className="mt-1.5" />}
    </div>}
  </li>;
}

export function RunsView({ runs }: { runs: AssistantRun[] }) {
  const typical = median(runs.flatMap((run) => run.ms === undefined ? [] : [run.ms]));
  return <Section id="orchestrator-runs" title="Letzte Läufe"
    meta={runs.length ? `${runs.length} ${runs.length === 1 ? "Lauf" : "Läufe"}${typical !== undefined ? ` · Median ${duration(typical)}` : ""}` : undefined}>
    {runs.length ? <FinancialData as="ul" aria-label="Letzte Läufe" className="divide-y divide-border/70">
      {runs.map((run) => <Run key={run.id} run={run} />)}
    </FinancialData>
      : <div className="space-y-3">
        <Empty icon={Inbox} title="Noch keine Läufe">Jede Frage an den Assistenten erscheint hier mit Agent, Delegationen, Werkzeugen, Status und Dauer.</Empty>
        <Button type="button" variant="outline" size="sm" onClick={() => askAssistant()}><MessageSquareText aria-hidden="true" />Assistent öffnen</Button>
      </div>}
  </Section>;
}
