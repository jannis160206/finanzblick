"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { m } from "motion/react";
import { Database, MessageSquareText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useMotionMode } from "@/components/ui/premium-dialog/motion";
import { askAssistant } from "@/lib/assistant-bus";
import {
  agentDef, agentToolSpecs, CHANGE_TOOL, dataSource, delegateTool, isSubagentKey, subagentKeys, toolSpecs, type AgentConfig, type AgentKey, type DataSource,
  type DataSourceId, type ToolSpec,
} from "@/lib/agents/registry";
import { agentHref, orchestratorHref } from "@/lib/assistant/orchestrator-pages";
import { reviewStep } from "@/lib/assistant/orchestrator-info";
import { cn } from "@/lib/utils";
import { ModelPill } from "./overview";
import { agentIcon, agentModel, focusRing, kindLabel, readStatus, Section, tierLabel, useLoad, useRepo, useWide, WarningDot, type AiStatus } from "./shared";

/** The agents column, top to bottom: the specialists, the change workflow, the local fallback. */
const graphAgents: AgentKey[] = [...subagentKeys, "changes", "fallback"];
const sourcesOf = (key: AgentKey) => [...new Set(agentToolSpecs(key).flatMap((tool) => tool.source ? [tool.source] : []))].map(dataSource);
const toolHref = (name: string) => `${orchestratorHref("werkzeuge")}#werkzeug-${name}`;
const sourceHref = (id: DataSourceId) => `${orchestratorHref("daten")}#${id}`;

// Layout in px: five columns left to right, nodes of fixed size, so the graph needs no measuring.
const column = {
  input: { x: 0, w: 124 }, orchestrator: { x: 164, w: 172 }, agents: { x: 428, w: 196 }, tools: { x: 672, w: 156 }, sources: { x: 872, w: 168 },
} as const;
const WIDTH = 1040;
const TOP = 34;
const AGENT_H = 66, AGENT_GAP = 14;
const TOOL_H = 18, TOOL_STEP = 21, GROUP_PAD = 5, GROUP_GAP = 14;
const SOURCE_H = 42, SOURCE_GAP = 8;
const ORCHESTRATOR_H = 92, INPUT_H = 66, REVIEW_H = 66, REVIEW_W = 224;

type Box = { x: number; y: number; w: number; h: number };
type GraphNode = Box & (
  | { id: "chat"; kind: "input" }
  | { id: string; kind: "orchestrator" | "agent" | "review"; agent: AgentKey }
  | { id: string; kind: "tool"; tool: ToolSpec }
  | { id: string; kind: "source"; source: DataSource }
);
type GraphEdge = { id: string; from: string; to: string; path: string; arrow?: string; dashed?: boolean; tier: number; label?: { text: string; x: number; y: number; align: "end" | "start"; mono?: boolean } };
type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; groups: (Box & { agent: AgentKey })[]; height: number };

const right = (box: Box) => ({ x: box.x + box.w, y: box.y + box.h / 2 });
const left = (box: Box) => ({ x: box.x, y: box.y + box.h / 2 });
const curve = (from: { x: number; y: number }, to: { x: number; y: number }) => {
  const bend = Math.max(24, (to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
};

function buildGraph(): Graph {
  const nodes: GraphNode[] = [];
  const groups: Graph["groups"] = [];
  let cursor = TOP;
  for (const agent of graphAgents) {
    const tools = agentToolSpecs(agent);
    if (!tools.length) continue;
    const h = GROUP_PAD * 2 + tools.length * TOOL_STEP - (TOOL_STEP - TOOL_H);
    groups.push({ agent, x: column.tools.x, y: cursor, w: column.tools.w, h });
    tools.forEach((tool, index) => nodes.push({ id: `tool:${tool.name}`, kind: "tool", tool, x: column.tools.x + GROUP_PAD, y: cursor + GROUP_PAD + index * TOOL_STEP,
      w: column.tools.w - GROUP_PAD * 2, h: TOOL_H }));
    cursor += h + GROUP_GAP;
  }
  // Each agent sits at the middle of its tools, pushed down where it would touch the one above.
  let bottom = TOP - AGENT_GAP;
  const agents: GraphNode[] = graphAgents.map((agent) => {
    const group = groups.find((item) => item.agent === agent);
    const y = Math.max(group ? group.y + group.h / 2 - AGENT_H / 2 : 0, bottom + AGENT_GAP);
    bottom = y + AGENT_H;
    return { id: `agent:${agent}`, kind: "agent", agent, x: column.agents.x, y, w: column.agents.w, h: AGENT_H };
  });
  // The orchestrator faces the specialists; the change workflow and the fallback hang below.
  const hubs = agents.filter((node) => node.kind === "agent" && isSubagentKey(node.agent));
  const middle = hubs.reduce((sum, node) => sum + node.y + node.h / 2, 0) / hubs.length;
  const orchestrator: GraphNode = { id: "agent:orchestrator", kind: "orchestrator", agent: "orchestrator", x: column.orchestrator.x, y: middle - ORCHESTRATOR_H / 2,
    w: column.orchestrator.w, h: ORCHESTRATOR_H };
  const chat: GraphNode = { id: "chat", kind: "input", x: column.input.x, y: middle - INPUT_H / 2, w: column.input.w, h: INPUT_H };
  const review: GraphNode = { id: "agent:review", kind: "review", agent: "review", x: column.orchestrator.x + column.orchestrator.w / 2 - REVIEW_W / 2,
    y: orchestrator.y + ORCHESTRATOR_H + 112, w: REVIEW_W, h: REVIEW_H };
  const tools = nodes.filter((node) => node.kind === "tool");
  // Sources stand next to the tools that read them, in that order, so the edges cross as little as possible.
  const wanted = [...new Set(tools.flatMap((node) => node.kind === "tool" && node.tool.source ? [node.tool.source] : []))].map((id) => {
    const readers = tools.filter((node) => node.kind === "tool" && node.tool.source === id);
    return { id, y: readers.reduce((sum, node) => sum + node.y + node.h / 2, 0) / readers.length };
  }).sort((a, b) => a.y - b.y);
  let sourceBottom = TOP - SOURCE_GAP;
  const sources: GraphNode[] = wanted.map(({ id, y: center }) => {
    const y = Math.max(center - SOURCE_H / 2, sourceBottom + SOURCE_GAP);
    sourceBottom = y + SOURCE_H;
    return { id: `source:${id}`, kind: "source", source: dataSource(id), x: column.sources.x, y, w: column.sources.w, h: SOURCE_H };
  });
  nodes.push(chat, orchestrator, review, ...agents, ...sources);

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: GraphEdge[] = [{ id: "chat>orchestrator", from: "chat", to: orchestrator.id, path: curve(right(chat), left(orchestrator)), tier: 0 }];
  for (const node of agents) {
    if (node.kind !== "agent") continue;
    const end = left(node);
    const tool = isSubagentKey(node.agent) ? delegateTool[node.agent] : node.agent === "changes" ? CHANGE_TOOL : undefined;
    edges.push({ id: `${orchestrator.id}>${node.id}`, from: orchestrator.id, to: node.id, path: curve(right(orchestrator), end), tier: 1, dashed: node.agent === "fallback",
      label: { text: tool ?? "ohne DeepSeek", x: end.x - 6, y: end.y - 15, align: "end", mono: !!tool } });
    for (const spec of agentToolSpecs(node.agent)) {
      const target = byId.get(`tool:${spec.name}`);
      if (target) edges.push({ id: `${node.id}>${target.id}`, from: node.id, to: target.id, path: curve(right(node), left(target)), tier: 2 });
    }
  }
  for (const node of tools) {
    if (node.kind !== "tool" || !node.tool.source) continue;
    const target = byId.get(`source:${node.tool.source}`);
    if (target) edges.push({ id: `${node.id}>${target.id}`, from: node.id, to: target.id, path: curve(right(node), left(target)), tier: 3 });
  }
  const x = orchestrator.x + orchestrator.w / 2;
  const top = orchestrator.y + orchestrator.h;
  edges.push({ id: `${review.id}>${orchestrator.id}`, from: review.id, to: orchestrator.id, dashed: true, tier: 1,
    path: `M ${x} ${review.y} L ${x} ${top + 2}`, arrow: `M ${x - 4} ${top + 8} L ${x} ${top + 2} L ${x + 4} ${top + 8}`,
    label: { text: "passt Prompts an", x: x + 8, y: (review.y + top) / 2 - 8, align: "start" } });
  const height = Math.max(...nodes.map((node) => node.y + node.h), ...groups.map((group) => group.y + group.h)) + 8;
  return { nodes, edges, groups, height };
}

/** Everything upstream and downstream of a node: what feeds it and what it reaches. */
function lineage(graph: Graph, id: string) {
  const nodes = new Set([id]);
  const edges = new Set<string>();
  for (const direction of ["down", "up"] as const) {
    const queue = [id];
    while (queue.length) {
      const current = queue.pop();
      for (const edge of graph.edges) {
        const [from, to] = direction === "down" ? [edge.from, edge.to] : [edge.to, edge.from];
        if (from !== current || edges.has(edge.id)) continue;
        edges.add(edge.id);
        if (!nodes.has(to)) {
          nodes.add(to);
          queue.push(to);
        }
      }
    }
  }
  return { nodes, edges };
}

type Configs = Partial<Record<AgentKey, AgentConfig>>;
const liveConfig = (configs: Configs, agent: AgentKey) => configs[agent] ?? agentDef(agent).config;

function nodeLabel(node: GraphNode, configs: Configs): string {
  if (node.kind === "input") return "Chat: Chat-Panel, Agent-Lauf. Assistent öffnen";
  if (node.kind === "tool") return `Werkzeug ${node.tool.name}: ${node.tool.label}${node.tool.kind === "change" ? " (ändert Daten)" : ""}`;
  if (node.kind === "source") return `Datenquelle ${node.source.label} (${node.source.detail})`;
  const def = agentDef(node.agent);
  const tools = agentToolSpecs(node.agent).length;
  return `${def.name} (${def.key}) – ${kindLabel[def.kind]}, ${agentModel({ config: liveConfig(configs, node.agent), mode: def.mode })}${tools ? `, ${tools} Werkzeuge` : ""}`;
}

const cardBase = "absolute flex rounded-xl border bg-card text-left transition-[opacity,box-shadow,border-color] duration-200 motion-reduce:transition-none";

function NodeView({ node, configs, state, onActive }: { node: GraphNode; configs: Configs; state: "lit" | "dim" | "idle"; onActive: (id?: string) => void }) {
  const events = {
    onMouseEnter: () => onActive(node.id), onMouseLeave: () => onActive(undefined), onFocus: () => onActive(node.id), onBlur: () => onActive(undefined),
    style: { left: node.x, top: node.y, width: node.w, height: node.h }, "aria-label": nodeLabel(node, configs), "data-state": state,
  };
  const look = cn(focusRing, state === "dim" && "opacity-35", state === "lit" && "border-primary/60 ring-2 ring-primary/25");
  if (node.kind === "tool") {
    const change = node.tool.kind === "change";
    return <Link href={toolHref(node.tool.name)} {...events} title={node.tool.label}
      className={cn(cardBase, "items-center justify-between gap-1 rounded-md border-border/70 bg-background px-1.5 font-mono text-2xs leading-none", look)}>
      <span className="truncate">{node.tool.name}</span>{change && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-warning" />}
    </Link>;
  }
  if (node.kind === "source") return <Link href={sourceHref(node.source.id)} {...events} title={`${node.source.label} · ${node.source.detail}`}
    className={cn(cardBase, "items-center gap-2 rounded-lg border-border/80 px-2.5 shadow-xs", look)}>
    <Database aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    <span className="min-w-0">
      <span className="block truncate text-xs font-medium">{node.source.label}</span>
      <span className="block truncate text-2xs text-muted-foreground">{node.source.detail}</span>
    </span>
  </Link>;
  if (node.kind === "input") return <button type="button" {...events} onClick={() => askAssistant()}
    className={cn(cardBase, "items-start gap-2.5 border-border/80 px-2.5 py-2 shadow-xs hover:border-primary/40", look)}>
    <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><MessageSquareText aria-hidden="true" className="size-4" /></span>
    <span className="min-w-0">
      <span className="block text-sm font-semibold">Chat</span>
      <span className="block text-2xs leading-snug text-muted-foreground">Chat-Panel · Agent-Lauf</span>
    </span>
  </button>;
  const def = agentDef(node.agent);
  const Icon = agentIcon[node.agent];
  const config = liveConfig(configs, node.agent);
  const detail = node.kind === "review" ? `Hintergrund · ${config ? tierLabel[config.tier] : ""}` : config ? tierLabel[config.tier] : def.mode ?? "";
  return <Link href={agentHref(node.agent)} {...events} title={def.summary}
    className={cn(cardBase, "flex-col justify-center gap-1.5 px-2.5 py-2 hover:border-primary/40",
      node.kind === "orchestrator" ? "border-primary/30 bg-[color-mix(in_oklab,var(--primary)_5%,var(--card))] shadow-card" : "border-border/80 shadow-xs",
      (def.kind === "workflow" || node.kind === "review") && "border-dashed", node.kind === "review" && "bg-muted/50", look)}>
    <span className="flex min-w-0 items-start gap-2.5">
      <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg", def.kind === "fallback" || node.kind === "review" ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary")}>
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-semibold">{def.name}</span>
        <span className="block truncate font-mono text-2xs text-muted-foreground">{def.key}</span>
        {node.kind !== "orchestrator" && <span className="mt-0.5 block truncate text-2xs text-muted-foreground" title={detail}>{detail}</span>}
      </span>
    </span>
    {node.kind === "orchestrator" && config && <span className="flex flex-wrap gap-1"><Badge variant="default">{tierLabel[config.tier]}</Badge></span>}
  </Link>;
}

const columnTitles = [["Eingang", column.input], ["Orchestrator", column.orchestrator], ["Agenten", column.agents], ["Werkzeuge", column.tools], ["Datenquellen", column.sources]] as const;

function TopologyGraph({ configs, className }: { configs: Configs; className?: string }) {
  const graph = useMemo(buildGraph, []);
  const [active, setActive] = useState<string>();
  const lit = useMemo(() => active ? lineage(graph, active) : undefined, [active, graph]);
  const mode = useMotionMode();
  return <div role="group" aria-label="Topologie als Graph" className={cn("-mx-2 overflow-x-auto overscroll-x-contain px-2 pb-2", className)}>
    <div className="relative" style={{ width: WIDTH, height: graph.height }}>
      {columnTitles.map(([title, place]) => <span key={title} aria-hidden="true" style={{ left: place.x, width: place.w }}
        className="absolute top-0 text-2xs font-medium uppercase tracking-wide text-muted-foreground">{title}</span>)}
      {graph.groups.map((group) => <span key={group.agent} aria-hidden="true" style={{ left: group.x, top: group.y, width: group.w, height: group.h }}
        className={cn("absolute rounded-lg border bg-muted/40", group.agent === "changes" ? "border-dashed border-border" : "border-transparent")} />)}
      <svg aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-visible" width={WIDTH} height={graph.height} fill="none">
        {graph.edges.map((edge) => {
          const on = lit?.edges.has(edge.id);
          const tone = on ? "stroke-primary" : lit ? "stroke-muted-foreground/10" : edge.tier === 3 ? "stroke-muted-foreground/20" : "stroke-muted-foreground/35";
          const draw = mode === "full" && !edge.dashed;
          return <m.path key={edge.id} d={edge.path} strokeWidth={on ? 1.75 : 1.25} strokeLinecap="round" strokeDasharray={edge.dashed ? "4 4" : undefined}
            className={cn("transition-[stroke,stroke-width] duration-200 motion-reduce:transition-none", tone)}
            initial={draw ? { pathLength: 0 } : false} animate={draw ? { pathLength: 1 } : undefined}
            transition={draw ? { duration: 0.7, delay: 0.08 * edge.tier, ease: [0.16, 1, 0.3, 1] } : undefined} />;
        })}
        {graph.edges.flatMap((edge) => edge.arrow ? [<path key={`arrow:${edge.id}`} d={edge.arrow} strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round"
          className={cn("transition-[stroke] duration-200 motion-reduce:transition-none",
            lit?.edges.has(edge.id) ? "stroke-primary" : lit ? "stroke-muted-foreground/10" : "stroke-muted-foreground/50")} />] : [])}
      </svg>
      {graph.edges.flatMap((edge) => edge.label ? [<span key={`label:${edge.id}`} aria-hidden="true" style={{ left: edge.label.x, top: edge.label.y }}
        className={cn("absolute whitespace-nowrap rounded bg-card px-1 text-2xs leading-4 text-muted-foreground transition-opacity duration-200 motion-reduce:transition-none",
          edge.label.align === "end" && "-translate-x-full", edge.label.mono && "font-mono", lit && !lit.edges.has(edge.id) && "opacity-30")}>
        {edge.label.text}</span>] : [])}
      {graph.nodes.map((node) => <NodeView key={node.id} node={node} configs={configs} onActive={setActive}
        state={!lit ? "idle" : lit.nodes.has(node.id) ? (node.id === active ? "lit" : "idle") : "dim"} />)}
    </div>
  </div>;
}

// Rails of the stacked list on small screens.
const branch = "relative pl-6 before:absolute before:left-2 before:top-0 before:h-full before:w-px before:bg-border last:before:h-6 " +
  "after:absolute after:left-2 after:top-6 after:h-px after:w-3 after:bg-border";

function ListAgent({ agent, configs }: { agent: AgentKey; configs: Configs }) {
  const def = agentDef(agent);
  const Icon = agentIcon[agent];
  const tools = agentToolSpecs(agent);
  const sources = sourcesOf(agent);
  return <div className={cn("rounded-xl border bg-card p-3 shadow-xs", def.kind === "workflow" || agent === "review" ? "border-dashed border-border" : "border-border/80")}>
    <Link href={agentHref(agent)} className={cn("flex items-start gap-2.5 rounded-lg", focusRing)} aria-label={nodeLabel({ id: `agent:${agent}`, kind: "agent", agent, x: 0, y: 0, w: 0, h: 0 }, configs)}>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Icon aria-hidden="true" className="size-4" /></span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-baseline gap-x-2"><span className="text-sm font-semibold">{def.name}</span><code className="font-mono text-2xs text-muted-foreground">{def.key}</code></span>
        <span className="block text-2xs text-muted-foreground">{agentModel({ config: liveConfig(configs, agent), mode: def.mode })}</span>
      </span>
    </Link>
    {tools.length > 0 && <ul aria-label={`Werkzeuge: ${def.name}`} className="mt-2 flex flex-wrap gap-1">
      {tools.map((tool) => <li key={tool.name}>
        <Link href={toolHref(tool.name)} title={tool.label} className={cn("inline-flex items-center gap-1 rounded-md border border-border/70 bg-background px-1.5 py-0.5 font-mono text-2xs", focusRing)}>
          {tool.name}{tool.kind === "change" && <WarningDot />}
        </Link>
      </li>)}
    </ul>}
    {sources.length > 0 && <p className="mt-2 flex items-start gap-1.5 text-2xs leading-relaxed text-muted-foreground">
      <Database aria-hidden="true" className="mt-0.5 size-3 shrink-0" /><span>liest {sources.map((source) => source.label).join(", ")}</span>
    </p>}
  </div>;
}

function TopologyList({ configs, className }: { configs: Configs; className?: string }) {
  return <div role="group" aria-label="Topologie als Liste" className={cn("space-y-3", className)}>
    <button type="button" onClick={() => askAssistant()} className={cn("flex w-full items-center gap-2.5 rounded-xl border border-border/80 bg-card p-3 text-left shadow-xs", focusRing)}>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><MessageSquareText aria-hidden="true" className="size-4" /></span>
      <span><span className="block text-sm font-semibold">Chat</span><span className="block text-2xs text-muted-foreground">Chat-Panel · Agent-Lauf</span></span>
    </button>
    <div className="ml-5 h-3 w-px bg-border" aria-hidden="true" />
    <ListAgent agent="orchestrator" configs={configs} />
    <ul aria-label="Agenten des Orchestrators" className="ml-3">
      {graphAgents.map((agent) => <li key={agent} className={cn(branch, "pt-3")}><ListAgent agent={agent} configs={configs} /></li>)}
    </ul>
    <div className="pt-2">
      <p className="mb-1.5 text-xs text-muted-foreground">Im Hintergrund – passt Prompts an:</p>
      <ListAgent agent="review" configs={configs} />
    </div>
  </div>;
}

function Legend() {
  return <ul aria-label="Legende" className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
    <li className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />ändert Daten – nur nach Bestätigung</li>
    <li className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="h-3 w-5 rounded border border-dashed border-muted-foreground/60" />Workflow und Hintergrund</li>
    <li className="inline-flex items-center gap-1.5">
      <svg aria-hidden="true" width="20" height="6" className="stroke-muted-foreground/70"><path d="M1 3 H19" strokeDasharray="3 3" strokeWidth="1.25" /></svg>nur bei Bedarf
    </li>
  </ul>;
}

export function TopologyView() {
  const [status] = useLoad<AiStatus | undefined>(readStatus, undefined);
  const [repo] = useRepo();
  const wide = useWide();
  // Live models and limits from the repo; without admin rights the code defaults.
  const configs = useMemo<Configs>(() => repo.state === "ready"
    ? Object.fromEntries(repo.data.agents.flatMap((agent) => agent.config ? [[agent.key, agent.config]] : [])) : {}, [repo]);
  return <Section id="orchestrator-topology" title="Topologie" meta={<ModelPill status={status} loading={!status} />}>
    <p className="mb-3 max-w-prose text-sm text-muted-foreground">
      Der Orchestrator delegiert per Tool-Call an {subagentKeys.length} Spezialisten; jeder hat eigene Werkzeuge und liest seine Datenquellen. Änderungen laufen
      über einen festen Workflow, der zuerst fragt. {reviewStep.title} und lokaler Rückfall arbeiten daneben.
      {wide !== false && " Fahre über einen Knoten oder fokussiere ihn, um seine Verbindungen zu sehen."}
    </p>
    <div className="mb-4"><Legend /></div>
    {wide !== false && <TopologyGraph configs={configs} className={wide === undefined ? "max-md:hidden" : undefined} />}
    {wide !== true && <TopologyList configs={configs} className={wide === undefined ? "md:hidden" : undefined} />}
    <p className="mt-3 text-xs text-muted-foreground">{toolSpecs.length} Werkzeuge · Klick auf einen Agenten öffnet sein Repo, auf ein Werkzeug seine Beschreibung.</p>
  </Section>;
}
