"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { m } from "motion/react";
import { BookOpen, ChevronDown, PenLine, Plus, RotateCcw, Save, Trash } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { dialogSpring, useMotionMode } from "@/components/ui/premium-dialog/motion";
import { agentName, isLlmAgentKey, llmAgentKeys, type LlmAgentKey } from "@/lib/agents/registry";
import { cn } from "@/lib/utils";
import {
  agentIcon, Empty, focusRing, LoadNote, number, Section, StatusLine, textareaClass, timeFormat, useHash, useRepo, useRepoSave, type RepoDoc, type RepoOverview,
} from "./shared";

/** A document id from its title: lowercase ASCII, umlauts spelled out, dashes between words, 3–60 characters, unique for the agent. */
export function docId(title: string, taken: readonly string[]): string {
  const base = title.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 60).replace(/-+$/, "");
  const id = base.length >= 3 ? base : `dokument${base ? `-${base}` : ""}`;
  if (!taken.includes(id)) return id;
  for (let count = 2; ; count += 1) {
    const suffix = `-${count}`;
    const candidate = `${id.slice(0, 60 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

type RepoSave = ReturnType<typeof useRepoSave>;
const inputClass = "h-9 w-full rounded-lg border border-input bg-background/50 px-3 text-sm outline-none transition-[border-color,box-shadow] "
  + "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20";

function DocForm({ initial, limit, busy, submit, onCancel, label }: {
  initial: { title: string; text: string }; limit: number; busy: boolean; label: string;
  submit: (value: { title: string; text: string }) => Promise<boolean>; onCancel: () => void;
}) {
  const [title, setTitle] = useState(initial.title);
  const [text, setText] = useState(initial.text);
  const id = useId();
  const changed = title.trim() !== initial.title.trim() || text.trim() !== initial.text.trim();
  return <form aria-label={label} className="space-y-2" onSubmit={(event) => {
    event.preventDefault();
    void submit({ title: title.trim(), text: text.trim() });
  }}>
    <label htmlFor={`${id}-title`} className="block text-xs font-medium text-muted-foreground">Titel</label>
    <input id={`${id}-title`} value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} className={inputClass} />
    <label htmlFor={`${id}-text`} className="block text-xs font-medium text-muted-foreground">Text</label>
    <textarea id={`${id}-text`} value={text} maxLength={limit} rows={8} onChange={(event) => setText(event.target.value)} className={cn(textareaClass, "min-h-40 font-sans text-sm")} />
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-2xs tabular-nums text-muted-foreground">{number(text.length)} / {number(limit)} Zeichen</span>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Abbrechen</Button>
        <Button type="submit" size="sm" disabled={busy || !changed || !title.trim() || !text.trim()}><Save aria-hidden="true" />Speichern</Button>
      </div>
    </div>
  </form>;
}

function DocRow({ agent, doc, limit, save }: { agent: LlmAgentKey; doc: RepoDoc; limit: number; save: RepoSave }) {
  const [view, setView] = useState<"closed" | "open" | "edit" | "delete">("closed");
  const mode = useMotionMode();
  const body = useId();
  const key = `knowledge:${agent}:${doc.id}`;
  const quoted = `„${doc.title}“`;
  return <li className="py-3 first:pt-0 last:pb-0">
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h4 className="break-words text-sm font-medium">{doc.title}</h4>
        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {doc.code && <Badge variant="secondary">Code</Badge>}
          {doc.custom && doc.version !== undefined && <Badge variant="info">Bearbeitet v{doc.version}</Badge>}
          <span className="tabular-nums">{number(doc.chars)} Zeichen</span>
          <code className="font-mono text-2xs">{doc.id}</code>
          {doc.custom && doc.at && <span>· {timeFormat.format(new Date(doc.at))}{doc.by ? ` · ${doc.by}` : ""}</span>}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-1">
        <Button type="button" variant="ghost" size="sm" aria-expanded={view === "open"} aria-controls={view === "open" ? body : undefined}
          aria-label={`${quoted} ${view === "open" ? "zuklappen" : "lesen"}`} onClick={() => setView(view === "open" ? "closed" : "open")}>
          <ChevronDown aria-hidden="true" className={cn("transition-transform motion-reduce:transition-none", view === "open" && "rotate-180")} />Lesen
        </Button>
        <Button type="button" variant="ghost" size="sm" aria-label={`${quoted} bearbeiten`} onClick={() => setView("edit")}><PenLine aria-hidden="true" />Bearbeiten</Button>
        <Button type="button" variant="ghost" size="sm" aria-label={`${quoted} löschen`} onClick={() => setView("delete")}><Trash aria-hidden="true" />Löschen</Button>
        {doc.code && doc.custom && <Button type="button" variant="ghost" size="sm" disabled={save.busy} aria-label={`${quoted} auf Code zurücksetzen`}
          onClick={() => void save.run({ changes: [{ key, value: null }] }, `${quoted} ist wieder die Version aus dem Code – gilt ab dem nächsten Lauf.`)}>
          <RotateCcw aria-hidden="true" />Auf Code zurücksetzen</Button>}
      </div>
    </div>
    {view === "open" && <m.div id={body} initial={mode === "full" ? { opacity: 0, y: -4 } : false} animate={{ opacity: 1, y: 0 }} transition={mode === "full" ? dialogSpring : { duration: 0 }}
      className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap rounded-xl border border-border/60 bg-muted/30 p-3 text-sm leading-relaxed">{doc.text}</m.div>}
    {view === "edit" && <div className="mt-3"><DocForm label={`${quoted} bearbeiten`} initial={doc} limit={limit} busy={save.busy} onCancel={() => setView("closed")}
      submit={async (value) => {
        const ok = await save.run({ changes: [{ key, value }] }, `${quoted} gespeichert – gilt ab dem nächsten Lauf.`);
        if (ok) setView("closed");
        return ok;
      }} /></div>}
    {view === "delete" && <div role="group" aria-label={`${quoted} löschen`}
      className="mt-3 flex flex-col gap-2 rounded-xl border border-destructive/30 bg-destructive-soft p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p>{quoted} löschen? Der Agent liest es ab dem nächsten Lauf nicht mehr; der Verlauf behält jede Version.</p>
      <div className="flex shrink-0 gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setView("closed")}>Abbrechen</Button>
        <Button type="button" variant="destructive" size="sm" disabled={save.busy}
          onClick={() => void save.run({ changes: [{ key, value: { deleted: true } }] }, `${quoted} gelöscht – gilt ab dem nächsten Lauf.`)}>
          <Trash aria-hidden="true" />Löschen bestätigen</Button>
      </div>
    </div>}
  </li>;
}

function AgentKnowledge({ agent, docs, limits, onSaved }: { agent: LlmAgentKey; docs: RepoDoc[]; limits: RepoOverview["limits"]; onSaved: (data: RepoOverview) => void }) {
  const save = useRepoSave(onSaved);
  const [adding, setAdding] = useState(false);
  const total = docs.reduce((sum, doc) => sum + doc.chars, 0);
  const over = total > limits.knowledgeChars;
  return <div className="space-y-4">
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs">
        <span className={cn("tabular-nums", over ? "font-medium text-warning" : "text-muted-foreground")}>
          {number(total)} von {number(limits.knowledgeChars)} Zeichen{over ? " – der Agent liest nur den Anfang" : ""}</span>
        <span className="text-muted-foreground">höchstens {number(limits.knowledgeDoc)} Zeichen je Dokument</span>
      </div>
      <Progress value={total} max={limits.knowledgeChars} label={`Wissen von ${agentName(agent)}`} valueText={`${total} von ${limits.knowledgeChars} Zeichen`}
        tone={over ? "warning" : "default"} className="h-1.5" />
    </div>
    <StatusLine note={save.note} />
    {docs.length ? <ul aria-label={`Dokumente: ${agentName(agent)}`} className="divide-y divide-border/70">
      {docs.map((doc) => <DocRow key={doc.id} agent={agent} doc={doc} limit={limits.knowledgeDoc} save={save} />)}
    </ul> : <Empty icon={BookOpen} title="Noch kein Wissen">{agentName(agent)} liest bisher nur seinen System-Prompt und die Daten seiner Werkzeuge.</Empty>}
    {adding ? <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
      <DocForm label="Neues Dokument" initial={{ title: "", text: "" }} limit={limits.knowledgeDoc} busy={save.busy} onCancel={() => setAdding(false)}
        submit={async (value) => {
          const id = docId(value.title, docs.map((doc) => doc.id));
          const ok = await save.run({ changes: [{ key: `knowledge:${agent}:${id}`, value }] }, `„${value.title}“ hinzugefügt – gilt ab dem nächsten Lauf.`);
          if (ok) setAdding(false);
          return ok;
        }} />
    </div> : <Button type="button" variant="outline" size="sm" onClick={() => { setAdding(true); save.setNote(undefined); }}><Plus aria-hidden="true" />Dokument hinzufügen</Button>}
  </div>;
}

export function KnowledgeView() {
  const [repo, setRepo] = useRepo();
  const hash = useHash();
  const [tab, setTab] = useState<LlmAgentKey>("orchestrator");
  const tabs = useRef<Partial<Record<LlmAgentKey, HTMLButtonElement | null>>>({});
  const base = useId();
  // The agent page links to its tab ("#budget").
  useEffect(() => {
    if (isLlmAgentKey(hash)) setTab(hash);
  }, [hash]);
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = llmAgentKeys.indexOf(tab);
    const next = event.key === "ArrowRight" ? index + 1 : event.key === "ArrowLeft" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? llmAgentKeys.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault();
    const key = llmAgentKeys[(next + llmAgentKeys.length) % llmAgentKeys.length];
    setTab(key);
    tabs.current[key]?.focus();
  };
  const docs = repo.state === "ready" ? repo.data.knowledge : {};
  return <Section id="orchestrator-knowledge" title="Wissen" meta={repo.state === "ready" ? `${number(repo.data.limits.knowledgeChars)} Zeichen je Agent` : undefined}>
    <p className="mb-4 max-w-prose text-sm text-muted-foreground">Dokumente, die ein Agent in jedem Lauf liest. Der Code liefert eine erste Version; jede Änderung ist
      eine neue Version und gilt ab dem nächsten Lauf.</p>
    {repo.state !== "ready" ? <LoadNote load={repo} what="Das Wissen der Agenten" /> : <>
      <div role="tablist" aria-label="Agenten" className="-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1">
        {llmAgentKeys.map((agent) => {
          const Icon = agentIcon[agent];
          const selected = agent === tab;
          return <button key={agent} ref={(element) => { tabs.current[agent] = element; }} type="button" role="tab" id={`${base}-tab-${agent}`}
            aria-selected={selected} aria-controls={`${base}-panel-${agent}`} tabIndex={selected ? 0 : -1} onClick={() => setTab(agent)} onKeyDown={move}
            className={cn("inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors", focusRing,
              selected ? "bg-primary/10 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}>
            <Icon aria-hidden="true" className={cn("size-3.5", selected && "text-primary")} />{agentName(agent)}
            <span className="rounded-full bg-muted px-1.5 text-2xs tabular-nums text-muted-foreground">{docs[agent]?.length ?? 0}</span>
          </button>;
        })}
      </div>
      <div role="tabpanel" id={`${base}-panel-${tab}`} aria-labelledby={`${base}-tab-${tab}`}>
        <AgentKnowledge key={tab} agent={tab} docs={docs[tab] ?? []} limits={repo.data.limits} onSaved={(data) => setRepo({ state: "ready", data })} />
      </div>
    </>}
  </Section>;
}
