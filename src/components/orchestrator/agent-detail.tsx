"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { BookOpen, ChevronLeft, Database, FileClock, PenLine, RotateCcw, Save, Undo2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { agentLimitBounds, isLlmAgentKey, modelTiers, type AgentConfig, type AgentKey, type AgentLimits } from "@/lib/agents/registry";
import { orchestratorHref } from "@/lib/assistant/orchestrator-pages";
import { cn } from "@/lib/utils";
import {
  agentIcon, focusRing, KindBadge, LoadNote, number, Section, StatusLine, textareaClass, tierLabel, timeFormat, useRepo, useRepoSave, WarningDot,
  type RepoAgent, type RepoOverview, type RepoPrompt,
} from "./shared";

type Saved = (data: RepoOverview) => void;
const nextRun = "gilt ab dem nächsten Lauf.";

function PromptEditor({ prompt, limit, onSaved }: { prompt: RepoPrompt; limit: number; onSaved: Saved }) {
  const save = useRepoSave(onSaved);
  const [draft, setDraft] = useState(prompt.text);
  // After a save or reset the server's text is the new starting point.
  useEffect(() => setDraft(prompt.text), [prompt.text]);
  const dirty = draft.trim() !== prompt.text.trim();
  return <div className="space-y-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{prompt.label}</h3>
      <Badge variant={prompt.custom ? "info" : "secondary"}>{prompt.custom ? "Angepasst" : "Standard"}</Badge>
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">{prompt.hint}</p>
    <textarea aria-label={`Prompt: ${prompt.label}`} value={draft} rows={10} maxLength={limit} spellCheck={false}
      onChange={(event) => setDraft(event.target.value)} className={cn(textareaClass, "min-h-48")} />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-2xs tabular-nums text-muted-foreground">{number(draft.length)} / {number(limit)} Zeichen</span>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={save.busy || !prompt.custom && !dirty}
          onClick={() => prompt.custom ? void save.run({ changes: [{ key: `prompt:${prompt.id}`, value: null }] }, `Auf Standard zurückgesetzt – ${nextRun}`) : setDraft(prompt.text)}>
          <RotateCcw aria-hidden="true" />Auf Standard zurücksetzen
        </Button>
        <Button type="button" size="sm" disabled={save.busy || !dirty || !draft.trim()}
          onClick={() => void save.run({ changes: [{ key: `prompt:${prompt.id}`, value: draft.trim() }] }, `Gespeichert – ${nextRun}`)}>
          <Save aria-hidden="true" />Speichern
        </Button>
      </div>
    </div>
    <StatusLine note={save.note} />
  </div>;
}

function PromptPanel({ agent, limit, onSaved }: { agent: RepoAgent; limit: number; onSaved: Saved }) {
  const [editing, setEditing] = useState(!agent.assembled);
  const editor = useId();
  const toggle = agent.assembled && <Button type="button" variant={editing ? "secondary" : "outline"} size="sm" aria-expanded={editing}
    aria-controls={editing ? editor : undefined} onClick={() => setEditing((value) => !value)}>
    {editing ? <X aria-hidden="true" /> : <PenLine aria-hidden="true" />}{editing ? "Bearbeiten schließen" : "Bearbeiten"}
  </Button>;
  return <Section id="agent-prompt" title={agent.assembled ? "System-Prompt" : "Prompts"} meta={toggle}>
    {agent.assembled && <>
      <p className="mb-2 text-xs text-muted-foreground">{number(agent.assembled.length)} Zeichen · so wie ein Lauf ihn sendet</p>
      <pre role="region" aria-label="System-Prompt, wie ein Lauf ihn sendet" tabIndex={0}
        className={cn("max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/70 bg-muted/30 p-4 font-mono text-xs leading-relaxed", focusRing)}>
        {agent.assembled}
      </pre>
    </>}
    {!agent.assembled && <p className="mb-4 text-sm text-muted-foreground">Dieser Agent hat keinen eigenen System-Prompt; das sind die Prompts, mit denen er arbeitet.</p>}
    {editing && <div id={editor} className={cn("space-y-6", agent.assembled && "mt-5 border-t border-border/70 pt-5")}>
      {agent.assembled && <p className="text-xs leading-relaxed text-muted-foreground">Bearbeitbar sind nur diese Teile; Werkzeuge, Wissen, Datenquellen und die
        Datenregel hängt der Code immer an.</p>}
      {agent.prompts.map((prompt) => <PromptEditor key={prompt.id} prompt={prompt} limit={limit} onSaved={onSaved} />)}
    </div>}
  </Section>;
}

type LimitKey = keyof AgentLimits;
const limitFields: { key: LimitKey; label: string; scale: number }[] = [
  { key: "maxSteps", label: "Max. Schritte", scale: 1 }, { key: "maxToolCalls", label: "Max. Werkzeugaufrufe", scale: 1 },
  { key: "timeoutMs", label: "Timeout (s)", scale: 1000 }, { key: "maxTokens", label: "Max. Tokens", scale: 1 },
];
type Draft = { tier: AgentConfig["tier"] } & Record<LimitKey, string>;
const toDraft = (config: AgentConfig): Draft => ({ tier: config.tier, ...Object.fromEntries(limitFields.map((field) => [field.key, String(config[field.key] / field.scale)])) } as Draft);
const sameConfig = (a: AgentConfig, b: AgentConfig) => a.tier === b.tier && limitFields.every((field) => a[field.key] === b[field.key]);

function LimitsPanel({ agent, config, onSaved }: { agent: RepoAgent; config: AgentConfig; onSaved: Saved }) {
  const save = useRepoSave(onSaved);
  const defaults = agent.defaults ?? config;
  const [draft, setDraft] = useState(() => toDraft(config));
  const base = useId();
  useEffect(() => setDraft(toDraft(config)), [config]);
  const values = Object.fromEntries(limitFields.map((field) => [field.key, Math.round(Number(draft[field.key]) * field.scale)])) as AgentLimits;
  const invalid = (key: LimitKey) => !draft[key].trim() || !Number.isInteger(values[key]) || values[key] < agentLimitBounds[key].min || values[key] > agentLimitBounds[key].max;
  const next: AgentConfig = { tier: draft.tier, ...values };
  const broken = limitFields.some((field) => invalid(field.key));
  const dirty = broken || !sameConfig(next, config);
  return <Section id="agent-limits" title="Modell & Limits">
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={`${base}-tier`} className="text-xs font-medium text-muted-foreground">Modell</label>
        <select id={`${base}-tier`} className="select-input w-full" value={draft.tier} onChange={(event) => setDraft({ ...draft, tier: event.target.value as AgentConfig["tier"] })}>
          {modelTiers.map((tier) => <option key={tier} value={tier}>{tierLabel[tier]}</option>)}
        </select>
        <p className="text-2xs text-muted-foreground">Code: {tierLabel[defaults.tier]}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {limitFields.map((field) => {
          const bound = agentLimitBounds[field.key];
          return <div key={field.key} className="min-w-0 space-y-1">
            <label htmlFor={`${base}-${field.key}`} className="block truncate text-xs font-medium text-muted-foreground">{field.label}</label>
            <input id={`${base}-${field.key}`} type="number" inputMode="numeric" min={bound.min / field.scale} max={bound.max / field.scale} step={1} value={draft[field.key]}
              aria-invalid={invalid(field.key) || undefined} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
              className="h-9 w-full rounded-lg border border-input bg-background/50 px-2.5 text-sm tabular-nums outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-invalid:border-destructive" />
            <p className="text-2xs tabular-nums text-muted-foreground">Code: {number(defaults[field.key] / field.scale)} · {number(bound.min / field.scale)}–{number(bound.max / field.scale)}</p>
          </div>;
        })}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={save.busy || sameConfig(config, defaults)}
          onClick={() => void save.run({ changes: [{ key: `agent:${agent.key}`, value: null }] }, `Wieder die Werte aus dem Code – ${nextRun}`)}>
          <RotateCcw aria-hidden="true" />Auf Code
        </Button>
        <Button type="button" size="sm" disabled={save.busy || broken || !dirty}
          onClick={() => void save.run({ changes: [{ key: `agent:${agent.key}`, value: next }] }, `Modell & Limits gespeichert – ${nextRun}`)}>
          <Save aria-hidden="true" />Speichern
        </Button>
      </div>
      <StatusLine note={broken ? { ok: false, text: "Bitte nur ganze Zahlen innerhalb der Grenzen." } : save.note} />
      <p className="text-xs leading-relaxed text-muted-foreground">Code-Standards kommen aus dem Code; eine Änderung gilt ab dem nächsten Lauf.</p>
    </div>
  </Section>;
}

function ToolsPanel({ agent, overview }: { agent: RepoAgent; overview: RepoOverview }) {
  const tools = agent.tools.map((name) => overview.tools.find((tool) => tool.name === name) ?? { name, label: name, kind: "read" as const });
  return <Section id="agent-tools" title="Werkzeuge" meta={tools.length ? `${tools.length}` : undefined}>
    {tools.length ? <ul aria-label={`Werkzeuge von ${agent.name}`} className="flex flex-wrap gap-1.5">
      {tools.map((tool) => <li key={tool.name}>
        <Link href={`${orchestratorHref("werkzeuge")}#werkzeug-${tool.name}`} title={tool.label}
          className={cn("inline-flex items-center gap-1 rounded-md border border-border/70 bg-background px-1.5 py-0.5 font-mono text-xs transition-colors hover:border-primary/40 hover:text-primary", focusRing)}>
          {tool.name}{tool.kind === "change" && <WarningDot />}
        </Link>
      </li>)}
    </ul> : <p className="text-sm text-muted-foreground">Keine Werkzeuge.</p>}
    {agent.sources.length > 0 && <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
      <Database aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /><span>Liest {agent.sources.map((source) => source.label).join(", ")}</span>
    </p>}
    <Link href={orchestratorHref("werkzeuge")} className={cn("mt-3 inline-flex text-xs font-medium text-primary hover:underline", focusRing)}>Alle Werkzeuge</Link>
  </Section>;
}

function KnowledgePanel({ agent }: { agent: RepoAgent }) {
  return <Section id="agent-knowledge" title="Wissen">
    <p className="flex items-center gap-2 text-sm"><BookOpen aria-hidden="true" className="size-4 text-muted-foreground" />
      {agent.knowledge} {agent.knowledge === 1 ? "Dokument" : "Dokumente"} in jedem Lauf</p>
    <Link href={`${orchestratorHref("wissen")}#${agent.key}`} className={cn("mt-3 inline-flex text-xs font-medium text-primary hover:underline", focusRing)}>
      Wissen von {agent.name} öffnen</Link>
  </Section>;
}

function HistoryPanel({ agent, onSaved }: { agent: RepoAgent; onSaved: Saved }) {
  const save = useRepoSave(onSaved);
  const [confirm, setConfirm] = useState(false);
  return <Section id="agent-history" title="Verlauf" meta={agent.history.length ? `${agent.history.length} Versionen` : undefined}>
    {agent.history.length ? <ol aria-label={`Verlauf von ${agent.name}`} className="max-h-80 space-y-2.5 overflow-y-auto pr-1">
      {agent.history.map((entry) => <li key={`${entry.key}:${entry.v}`} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 text-sm">
        <code className="mt-0.5 rounded bg-muted px-1.5 font-mono text-2xs leading-5 tabular-nums">v{entry.v}</code>
        <div className="min-w-0">
          <p className="break-words">{entry.note ?? entry.label}{entry.reset && <Badge variant="secondary" className="ml-1.5 align-middle">Auf Code zurückgesetzt</Badge>}</p>
          <p className="text-2xs text-muted-foreground">{entry.note ? `${entry.label} · ` : ""}<time dateTime={entry.at}>{timeFormat.format(new Date(entry.at))}</time> · {entry.by}</p>
        </div>
      </li>)}
    </ol> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><FileClock aria-hidden="true" className="size-4" />Noch keine Änderung – alles kommt aus dem Code.</p>}
    <div className="mt-4 border-t border-border/70 pt-4">
      {confirm ? <div role="group" aria-label="Alles auf Code zurücksetzen" className="space-y-2 rounded-xl border border-destructive/30 bg-destructive-soft p-3 text-sm">
        <p>Alle Prompts, Modell & Limits und das Wissen von {agent.name} auf den Code zurücksetzen? Der Verlauf behält jede Version.</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm(false)}>Abbrechen</Button>
          <Button type="button" variant="destructive" size="sm" disabled={save.busy} onClick={() => void save.run({ reset: agent.key }, `Alles auf Code zurückgesetzt – ${nextRun}`)
            .then((ok) => { if (ok) setConfirm(false); })}><Undo2 aria-hidden="true" />Zurücksetzen</Button>
        </div>
      </div> : <Button type="button" variant="outline" size="sm" disabled={agent.edits === 0} onClick={() => { setConfirm(true); save.setNote(undefined); }}>
        <Undo2 aria-hidden="true" />Alles auf Code zurücksetzen</Button>}
      <StatusLine note={save.note} className="mt-2" />
    </div>
  </Section>;
}

export function AgentDetailView({ agent: key }: { agent: AgentKey }) {
  const [repo, setRepo] = useRepo();
  const back = <Link href={orchestratorHref("agenten")} aria-label="Zurück zu Agenten"
    className={cn("inline-flex min-h-9 items-center gap-1 rounded-lg pr-2 text-sm text-muted-foreground transition-colors hover:text-foreground", focusRing)}>
    <ChevronLeft aria-hidden="true" className="size-4" />Agenten
  </Link>;
  const agent = repo.state === "ready" ? repo.data.agents.find((item) => item.key === key) : undefined;
  if (repo.state !== "ready" || !agent) return <>{back}<Section id="agent-detail" title="Agent">
    {repo.state === "ready" ? <p className="text-sm text-muted-foreground">Diesen Agenten gibt es im Repo nicht.</p> : <LoadNote load={repo} what="Das Agent-Repo" />}
  </Section></>;
  const onSaved: Saved = (data) => setRepo({ state: "ready", data });
  const Icon = agentIcon[agent.key];
  return <>
    {back}
    <header className="panel flex flex-col gap-3 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Icon aria-hidden="true" className="size-5" /></span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">{agent.name}</h2>
            <Badge variant="success">Live</Badge>
            {agent.edits > 0 && agent.version !== undefined && <Badge variant="info">Bearbeitet v{agent.version}</Badge>}
          </div>
          <code className="font-mono text-xs text-muted-foreground">{agent.key}</code>
          <p className="mt-1.5 max-w-prose text-sm text-muted-foreground">{agent.summary}</p>
        </div>
      </div>
      <KindBadge kind={agent.kind} />
    </header>
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
      <div className="min-w-0 space-y-6"><PromptPanel agent={agent} limit={repo.data.limits.promptLength} onSaved={onSaved} /></div>
      <div className="min-w-0 space-y-6">
        {agent.config ? <LimitsPanel agent={agent} config={agent.config} onSaved={onSaved} />
          : <Section id="agent-limits" title="Ablauf"><p className="text-sm">{agent.mode}</p>
            <p className="mt-2 text-xs text-muted-foreground">Kein Modell und keine Limits – dieser Agent läuft im Code.</p></Section>}
        <ToolsPanel agent={agent} overview={repo.data} />
        {isLlmAgentKey(agent.key) && <KnowledgePanel agent={agent} />}
        <HistoryPanel agent={agent} onSaved={onSaved} />
      </div>
    </div>
  </>;
}
