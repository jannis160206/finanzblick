"use client";

import Link from "next/link";
import { Bot } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { agentHref } from "@/lib/assistant/orchestrator-pages";
import { cn } from "@/lib/utils";
import { agentIcon, agentModel, Empty, focusRing, KindBadge, LoadNote, number, Section, useLarge, useRepo, type RepoAgent } from "./shared";

export function RepoBadge({ agent }: { agent: Pick<RepoAgent, "edits" | "version"> }) {
  return agent.edits > 0 && agent.version !== undefined ? <Badge variant="info">Bearbeitet v{agent.version}</Badge> : <span className="text-xs text-muted-foreground">Code</span>;
}

const seconds = (ms: number) => `${(ms / 1000).toLocaleString("de-AT")} s`;
const sourceList = (agent: RepoAgent) => agent.sources.map((source) => source.label).join(", ") || "–";

function AgentName({ agent, stretched }: { agent: RepoAgent; stretched?: boolean }) {
  const Icon = agentIcon[agent.key];
  return <Link href={agentHref(agent.key)} aria-label={`${agent.name} (${agent.key})`}
    className={cn("group/name inline-flex min-w-0 items-start gap-2.5 rounded-lg", focusRing, stretched && "after:absolute after:inset-0")}>
    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Icon aria-hidden="true" className="size-4" /></span>
    <span className="min-w-0">
      <span className="block font-medium group-hover/name:text-primary">{agent.name}</span>
      <code className="block font-mono text-2xs font-normal text-muted-foreground">{agent.key}</code>
    </span>
  </Link>;
}

function AgentTable({ agents }: { agents: RepoAgent[] }) {
  const heads = ["Agent", "Art", "Modell", "Max. Schritte", "Timeout (s)", "Werkzeuge", "Quellen", "Repo"];
  return <table aria-label="Agenten" className="w-full text-sm">
    <thead>
      <tr className="border-b border-border/70 text-left text-2xs uppercase tracking-wide text-muted-foreground">
        {heads.map((title) => <th key={title} scope="col" className="pb-2 pr-4 font-medium last:pr-0">{title}</th>)}
      </tr>
    </thead>
    <tbody className="divide-y divide-border/60">
      {agents.map((agent) => <tr key={agent.key} className="relative align-top transition-colors hover:bg-muted/40">
        <th scope="row" className="py-3 pr-4 text-left font-normal"><AgentName agent={agent} stretched /></th>
        <td className="py-3 pr-4"><KindBadge kind={agent.kind} /></td>
        <td className="max-w-44 py-3 pr-4">{agentModel(agent)}</td>
        <td className="py-3 pr-4 tabular-nums">{agent.config?.maxSteps ?? "–"}</td>
        <td className="py-3 pr-4 tabular-nums">{agent.config ? number(agent.config.timeoutMs / 1000) : "–"}</td>
        <td className="py-3 pr-4 tabular-nums">{agent.tools.length}</td>
        <td className="max-w-56 py-3 pr-4 text-xs leading-relaxed text-muted-foreground">{sourceList(agent)}</td>
        <td className="py-3"><RepoBadge agent={agent} /></td>
      </tr>)}
    </tbody>
  </table>;
}

function AgentCards({ agents }: { agents: RepoAgent[] }) {
  return <ul aria-label="Agenten" className="grid gap-3 sm:grid-cols-2">
    {agents.map((agent) => <li key={agent.key} className="relative flex flex-col gap-2 rounded-xl border border-border/70 bg-background/40 p-3 transition-colors hover:border-primary/40">
      <div className="flex items-start justify-between gap-2"><AgentName agent={agent} stretched /><KindBadge kind={agent.kind} /></div>
      <p className="text-xs text-muted-foreground">{agent.summary}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Modell</dt><dd>{agentModel(agent)}</dd>
        {agent.config && <><dt className="text-muted-foreground">Limits</dt><dd className="tabular-nums">{agent.config.maxSteps} Schritte · {seconds(agent.config.timeoutMs)}</dd></>}
        <dt className="text-muted-foreground">Werkzeuge</dt><dd className="tabular-nums">{agent.tools.length}</dd>
        <dt className="text-muted-foreground">Quellen</dt><dd>{sourceList(agent)}</dd>
        <dt className="text-muted-foreground">Repo</dt><dd><RepoBadge agent={agent} /></dd>
      </dl>
    </li>)}
  </ul>;
}

export function AgentsView() {
  const [repo] = useRepo();
  const large = useLarge();
  return <Section id="orchestrator-agents" title="Agenten" meta={repo.state === "ready" ? `${repo.data.agents.length} Agenten` : undefined}>
    <p className="mb-4 max-w-prose text-sm text-muted-foreground">Das Agent-Repo: jeder Agent mit Modell, Limits, Werkzeugen und Quellen. Die Standards kommen aus
      dem Code; jede Änderung an Prompt, Modell oder Wissen ist eine neue Version und gilt ab dem nächsten Lauf.</p>
    {repo.state !== "ready" ? <LoadNote load={repo} what="Das Agent-Repo" />
      : !repo.data.agents.length ? <Empty icon={Bot} title="Keine Agenten" />
        : large === false ? <AgentCards agents={repo.data.agents} />
          : <div className="-mx-1 overflow-x-auto px-1"><AgentTable agents={repo.data.agents} /></div>}
    {repo.state === "ready" && <p className="mt-4 text-xs text-muted-foreground">Datei: <code className="break-all rounded bg-muted px-1.5 py-0.5">{repo.data.file}</code></p>}
  </Section>;
}
