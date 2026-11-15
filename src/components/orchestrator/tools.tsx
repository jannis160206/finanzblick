"use client";

import { useEffect, useMemo, useState } from "react";
import { PenLine, RotateCcw, Save, Search, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Empty, LoadNote, number, Section, StatusLine, textareaClass, useHash, useRepo, useRepoSave, WarningDot, type RepoOverview, type RepoTool,
} from "./shared";

type Group = { id: string; title: string; tools: RepoTool[]; changes?: boolean };

/** Delegations first, then the reading tools by the data they read, then the change workflow. */
function toolGroups(overview: RepoOverview, query: string): Group[] {
  const words = query.toLocaleLowerCase("de").split(/\s+/).filter(Boolean);
  const shown = overview.tools.filter((tool) => {
    const text = [tool.name, tool.label, tool.description, ...tool.agents, tool.source?.label ?? ""].join(" ").toLocaleLowerCase("de");
    return words.every((word) => text.includes(word));
  });
  const groups: Group[] = [
    { id: "delegation", title: "Delegation · Orchestrator", tools: shown.filter((tool) => tool.kind === "delegate" || tool.kind === "workflow") },
    ...overview.sources.map((source) => ({ id: source.id, title: `${source.label} · ${source.detail}`,
      tools: shown.filter((tool) => tool.kind === "read" && tool.source?.id === source.id) })),
    { id: "changes", title: "Änderungen · Workflow", tools: shown.filter((tool) => tool.kind === "change"), changes: true },
  ];
  return groups.filter((group) => group.tools.length);
}

function ToolRow({ tool, limit, marked, onSaved }: { tool: RepoTool; limit: number; marked: boolean; onSaved: (data: RepoOverview) => void }) {
  const save = useRepoSave(onSaved);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tool.description);
  const dirty = draft.trim() !== tool.description.trim();
  const close = () => { setEditing(false); setDraft(tool.description); };
  const store = async (value: string | null, text: string) => {
    if (await save.run({ changes: [{ key: `tool:${tool.name}`, value }] }, text)) setEditing(false);
  };
  useEffect(() => setDraft(tool.description), [tool.description]);
  return <li id={`werkzeug-${tool.name}`} className={cn("grid scroll-mt-24 gap-x-6 gap-y-2 rounded-xl px-3 py-3 transition-colors md:grid-cols-[13rem_minmax(0,1fr)]",
    marked && "bg-primary/5 ring-1 ring-primary/30")}>
    <div className="min-w-0">
      <p className="flex items-center gap-1.5 break-all font-mono text-sm font-semibold">{tool.name}{tool.kind === "change" && <WarningDot />}</p>
      <p className="text-xs text-muted-foreground">{tool.label}</p>
      <p className="mt-1 font-mono text-2xs text-muted-foreground" title="Agenten, die es aufrufen">{tool.agents.join(", ")}</p>
    </div>
    <div className="min-w-0 space-y-2">
      {editing ? <div className="space-y-2">
        <textarea aria-label={`Beschreibung: ${tool.name}`} value={draft} rows={5} maxLength={limit} onChange={(event) => setDraft(event.target.value)}
          className={cn(textareaClass, "min-h-28 font-sans text-sm")} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-2xs tabular-nums text-muted-foreground">{number(draft.length)} / {number(limit)} Zeichen</span>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={close}>Abbrechen</Button>
            {tool.custom && <Button type="button" variant="outline" size="sm" disabled={save.busy}
              onClick={() => void store(null, "Wieder die Beschreibung aus dem Code – gilt ab dem nächsten Lauf.")}><RotateCcw aria-hidden="true" />Auf Code zurücksetzen</Button>}
            <Button type="button" size="sm" disabled={save.busy || !dirty || !draft.trim()}
              onClick={() => void store(draft.trim(), "Gespeichert – gilt ab dem nächsten Lauf.")}><Save aria-hidden="true" />Speichern</Button>
          </div>
        </div>
      </div> : <p className="max-w-prose text-sm leading-relaxed">{tool.description}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        <span title={tool.param.description}>Parameter <code className="font-mono text-foreground/80">{tool.param.name}</code></span>
        {tool.custom && tool.version !== undefined && <Badge variant="info">Bearbeitet v{tool.version}</Badge>}
        {!editing && <Button type="button" variant="ghost" size="xs" aria-label={`Beschreibung von ${tool.name} bearbeiten`}
          onClick={() => { setEditing(true); save.setNote(undefined); }}><PenLine aria-hidden="true" />Bearbeiten</Button>}
      </div>
      {(editing || save.note) && <StatusLine note={save.note} />}
    </div>
  </li>;
}

export function ToolsView() {
  const [repo, setRepo] = useRepo();
  const hash = useHash();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => repo.state === "ready" ? toolGroups(repo.data, query.trim()) : [], [repo, query]);
  // Links from the topology and the agent page point at one tool ("#werkzeug-query"); it scrolls into view once the list is there.
  const ready = repo.state === "ready";
  useEffect(() => {
    if (ready && hash.startsWith("werkzeug-")) document.getElementById(hash)?.scrollIntoView?.({ block: "center" });
  }, [ready, hash]);
  return <Section id="orchestrator-tools" title="Werkzeuge" meta={repo.state === "ready" ? `${repo.data.tools.length} Werkzeuge` : undefined}>
    <p className="mb-4 max-w-prose text-sm text-muted-foreground">Das Werkzeug-Repo: jedes Werkzeug, das ein Agent aufrufen kann. Die Beschreibung liest das Modell, um
      zu entscheiden, wann es ein Werkzeug aufruft; Code und Parameter bleiben im Code. Eine Änderung gilt ab dem nächsten Lauf.</p>
    {repo.state !== "ready" ? <LoadNote load={repo} what="Das Werkzeug-Repo" /> : <>
      <label className="relative mb-5 block max-w-sm">
        <span className="sr-only">Werkzeuge filtern</span>
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Werkzeuge filtern…"
          className="h-9 w-full rounded-lg border border-input bg-background/50 pl-8 pr-2 text-sm outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20" />
      </label>
      {!groups.length && <Empty icon={Wrench} title="Kein Werkzeug passt">Versuch einen anderen Begriff, z. B. einen Werkzeugnamen oder eine Datenquelle.</Empty>}
      <div className="space-y-6">
        {groups.map((group) => <div key={group.id} role="group" aria-labelledby={`werkzeuge-${group.id}`}>
          <h3 id={`werkzeuge-${group.id}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 pb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {group.title}<span className="font-normal tabular-nums tracking-normal">· {group.tools.length}</span>
            {group.changes && <span className="inline-flex items-center gap-1.5 font-normal normal-case tracking-normal">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />ändert Daten – nur nach Bestätigung</span>}
          </h3>
          <ul className="-mx-3 mt-1 divide-y divide-border/50">
            {group.tools.map((tool) => <ToolRow key={tool.name} tool={tool} limit={repo.data.limits.toolDescription} marked={hash === `werkzeug-${tool.name}`}
              onSaved={(data) => setRepo({ state: "ready", data })} />)}
          </ul>
        </div>)}
      </div>
    </>}
  </Section>;
}
