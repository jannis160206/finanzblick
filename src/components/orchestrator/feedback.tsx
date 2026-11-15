"use client";

import { useEffect, useState } from "react";
import { Ban, Check, Download, RefreshCw, ThumbsDown, ThumbsUp, Undo2 } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { currentPromptId, promptLabel } from "@/lib/ai/agent-prompts";
import { MAX_ACTIVE_RULES, statusLabel, type FeedbackRule, type RuleStatus } from "@/lib/assistant/feedback-rules";
import { agentLabel } from "@/lib/assistant/orchestrator";
import { cn } from "@/lib/utils";
import { Section, timeFormat, useLoad } from "./shared";

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
export type RulesOverview = { file: string; loop: string; count: Partial<Record<RuleStatus, number>>; rules: LearnedChange[] };
export type RulesLoad = { state: "loading" } | { state: "ready"; data: RulesOverview } | { state: "admin" } | { state: "error" };
type RuleAction = "enable" | "disable" | "recheck";

export async function readRulesOverview(): Promise<RulesLoad> {
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
// Changes of earlier versions name their prompt by an old id ("supervisor"); they show the prompt that took over.
const changeTarget = (rule: FeedbackRule) => rule.kind === "prompt" && rule.prompt
  ? `Prompt ${rule.prompt.mode === "replace" ? "geändert" : "ergänzt"} · ${promptLabel(currentPromptId(rule.prompt.id) ?? rule.prompt.id)}`
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

export function FeedbackView() {
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
