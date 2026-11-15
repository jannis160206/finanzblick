"use client";

import Link from "next/link";
import { Bot, ClipboardCheck, Coins, Cpu, FlaskConical, ListTree, Wrench, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { agentDefs, toolSpecs } from "@/lib/agents/registry";
import { costOverview, MONTHLY_BUDGET_USD, taskLabel } from "@/lib/ai/models";
import type { AssistantRun } from "@/lib/assistant/orchestrator-info";
import { orchestratorHref } from "@/lib/assistant/orchestrator-pages";
import { cn } from "@/lib/utils";
import { readEvals, scoreText, type EvalOverview } from "./evals";
import { readRulesOverview, type RulesLoad } from "./feedback";
import { duration, focusRing, median, number, readStatus, Section, shortModel, timeFormat, useLoad, type AiStatus, type Load } from "./shared";

export function ModelPill({ status, loading }: { status?: AiStatus; loading: boolean }) {
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
        ? <span>Fällt DeepSeek aus (Netzwerk, Rate-Limit, Key), antwortet automatisch der lokale Rückfall{local ? ` (${local.available ? "bereit" : `gerade ${local.error ?? "nicht erreichbar"}`})` : ""}. Namen, IBANs und Nummern gehen nur pseudonymisiert in die Cloud; ganze Kontoauszüge bleiben lokal.</span>
        : <span>Ohne DeepSeek-Key antwortet nur das lokale Modell (Qwen auf der NPU).</span>}
    </p>
  </div>;
}

const usd = (value: number) => `${value.toLocaleString("de-AT", { minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 })} $`;
export const cents = (value: number) => `${(value * 100).toLocaleString("de-AT", { maximumFractionDigits: 2 })} Cent`;

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

type Kpi = { label: string; icon: LucideIcon; value: string; detail: string; href: string };

function evalKpi(load: Load<EvalOverview>): Pick<Kpi, "value" | "detail"> {
  if (load.state === "loading") return { value: "…", detail: "Lade" };
  if (load.state !== "ready") return { value: "–", detail: load.state === "admin" ? "nur für den Administrator" : "nicht lesbar" };
  const { running, runs } = load.data;
  if (running) return { value: "läuft", detail: `${number(running.done)} von ${number(running.total)} Fällen` };
  const last = runs.find((run) => run.status === "done" && run.score);
  if (!last?.score) return { value: "–", detail: "noch keine" };
  return { value: scoreText(last.score), detail: `${timeFormat.format(new Date(last.finishedAt ?? last.startedAt))}${last.score.hard ? ` · ${last.score.hard} Sicherheitsfehler` : ""}` };
}

function rulesKpi(load: RulesLoad): Pick<Kpi, "value" | "detail"> {
  if (load.state === "loading") return { value: "…", detail: "Lade" };
  if (load.state !== "ready") return { value: "–", detail: load.state === "admin" ? "nur für den Administrator" : "nicht lesbar" };
  const active = load.data.rules.filter((rule) => rule.status === "active").length;
  return { value: number(active), detail: `${active === 1 ? "aktive Änderung" : "aktive Änderungen"} · Prüfung ${load.data.loop}` };
}

/** The platform at a glance: one strip of figures, each leading to its page. */
function Kpis({ runs, status, evals, rules }: { runs: AssistantRun[]; status?: AiStatus; evals: Load<EvalOverview>; rules: RulesLoad }) {
  const count = (kind: string) => agentDefs.filter((agent) => agent.kind === kind).length;
  const changing = toolSpecs.filter((tool) => tool.kind === "change").length;
  const typical = median(runs.flatMap((run) => run.ms === undefined ? [] : [run.ms]));
  const costs = costOverview(status?.usage);
  const kpis: Kpi[] = [
    { label: "Agenten", icon: Bot, value: number(agentDefs.length), href: orchestratorHref("agenten"),
      detail: `${count("llm")} LLM-Agenten · ${count("workflow")} Workflow · Hintergrund und Rückfall` },
    { label: "Werkzeuge", icon: Wrench, value: number(toolSpecs.length), detail: `davon ${changing} ändernd`, href: orchestratorHref("werkzeuge") },
    { label: "Läufe", icon: ListTree, value: number(runs.length), detail: typical !== undefined ? `Median ${duration(typical)}` : "noch keine im Verlauf", href: orchestratorHref("laeufe") },
    { label: "Gold-Eval", icon: FlaskConical, ...evalKpi(evals), href: orchestratorHref("evals") },
    { label: "Kosten pro Frage", icon: Coins, value: status ? `≈ ${cents(costs.perQuestion)}` : "…",
      detail: status ? costs.measured ? "gemessen seit Serverstart" : "Richtwert" : "Prüfe die Modelle", href: "#orchestrator-costs" },
    { label: "Prüfungs-Agent", icon: ClipboardCheck, ...rulesKpi(rules), href: orchestratorHref("feedback") },
  ];
  return <ul aria-label="Kennzahlen" className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-border/80 bg-border/70 shadow-card lg:grid-cols-3">
    {kpis.map((kpi) => <li key={kpi.label} className="min-w-0 bg-card">
      <Link href={kpi.href} className={cn("group flex h-full min-h-28 flex-col gap-1 p-4 transition-colors hover:bg-muted/40 focus-visible:ring-inset sm:p-5", focusRing)}>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <kpi.icon aria-hidden="true" className="size-3.5 shrink-0 transition-colors group-hover:text-primary motion-reduce:transition-none" />{kpi.label}
        </span>
        <span className="text-xl font-semibold tracking-tight tabular-nums sm:text-2xl">{kpi.value}</span>
        <span className="text-xs leading-snug text-muted-foreground">{kpi.detail}</span>
      </Link>
    </li>)}
  </ul>;
}

export function OverviewView({ runs }: { runs: AssistantRun[] }) {
  const [status] = useLoad<AiStatus | undefined>(readStatus, undefined);
  const [evals] = useLoad<Load<EvalOverview>>(readEvals, { state: "loading" });
  const [rules] = useLoad<RulesLoad>(readRulesOverview, { state: "loading" });
  return <>
    <Kpis runs={runs} status={status} evals={evals} rules={rules} />
    <Section id="orchestrator-models" title="Modelle" meta={<ModelPill status={status} loading={!status} />}><Models status={status} loading={!status} /></Section>
    <Section id="orchestrator-costs" title="Kosten" meta={`DeepSeek, Budget ${MONTHLY_BUDGET_USD} $ im Monat`}><Costs status={status} loading={!status} /></Section>
  </>;
}
