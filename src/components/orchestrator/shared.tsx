"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Banknote, BrainCircuit, ClipboardCheck, Cpu, FileText, Globe, PiggyBank, ReceiptText, Workflow, type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { AgentConfig, AgentKey, AgentKind, CatalogEntry, DataSource, ToolKind } from "@/lib/agents/registry";
import type { PromptId } from "@/lib/ai/agent-prompts";
import type { AiTask, ModelTier } from "@/lib/ai/models";
import { cn } from "@/lib/utils";

export type AiStatus = {
  available: boolean; model: string; label?: string; error?: string;
  router?: { model: string; available: boolean };
  local?: { available: boolean; model: string; error?: string };
  cloud?: { provider: "deepseek"; available: boolean; models: Record<ModelTier, string>; error?: string };
  /** Which model answers each task right now (with the local model as fallback). */
  routing?: { task: AiTask; label: string; model: string; fallback?: boolean }[];
  /** Token counters per model since the server started. */
  usage?: Record<string, { calls: number; input: number; output: number; cached: number }>;
};
export const routeLabel = (status: AiStatus | undefined, task: AiTask) => status?.routing?.find((item) => item.task === task)?.label;

export const shortModel = (name: string) => name.split("/").at(-1) ?? name;
export const duration = (ms: number) => ms < 60_000 ? `${Math.max(0.1, Math.round(ms / 100) / 10).toLocaleString("de-AT")} s` : `${Math.round(ms / 60_000)} min`;
export const timeFormat = new Intl.DateTimeFormat("de-AT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
// Grouped like the rest of the app: 12.000.
export const number = (value: number) => value.toLocaleString("de-DE");
export const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
};

export const tierLabel: Record<ModelTier, string> = { fast: "DeepSeek Flash", pro: "DeepSeek V4 Pro", reasoning: "V4 Pro · Denkmodus" };
export const kindLabel: Record<AgentKind, string> = { llm: "LLM-Agent", workflow: "Workflow", background: "Hintergrund", fallback: "Rückfall" };
const kindTone: Record<AgentKind, "info" | "default" | "secondary" | "outline"> = { llm: "info", workflow: "default", background: "secondary", fallback: "outline" };
export function KindBadge({ kind }: { kind: AgentKind }) {
  return <Badge variant={kindTone[kind]}>{kindLabel[kind]}</Badge>;
}
export const agentIcon: Record<AgentKey, LucideIcon> = {
  orchestrator: BrainCircuit, transactions: ReceiptText, contracts: FileText, budget: PiggyBank, payroll: Banknote, research: Globe,
  changes: Workflow, review: ClipboardCheck, fallback: Cpu,
};
/** How an agent runs: its model for LLM agents, its mode for the workflow and the fallback. */
export const agentModel = (agent: { config?: AgentConfig; mode?: string }) => agent.config ? tierLabel[agent.config.tier] : agent.mode ?? "–";

export function Section({ id, title, meta, children, className }: { id: string; title: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  return <section id={id} aria-labelledby={`${id}-title`} className={cn("panel min-w-0 scroll-mt-24 p-5 sm:p-6", className)}>
    <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">{title}</h2>
      {meta && <div className="text-xs text-muted-foreground">{meta}</div>}
    </div>
    {children}
  </section>;
}

/** A save or reset result next to the button that caused it. */
export type Note = { ok: boolean; text: string };
export function StatusLine({ note, className }: { note?: Note; className?: string }) {
  return <p role="status" className={cn("min-h-4 text-xs", note?.ok ? "text-success" : "text-destructive", className)}>{note?.text}</p>;
}

export function WarningDot({ label = "ändert Daten" }: { label?: string }) {
  return <><span aria-hidden="true" className="inline-block size-1.5 shrink-0 rounded-full bg-warning" /><span className="sr-only">({label})</span></>;
}

export type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "admin" } | { state: "error" };

/** GET of an admin endpoint: 403 means the caller is no admin; an answer without the expected shape counts as an error. */
export async function readJson<T>(url: string, valid: (data: unknown) => boolean): Promise<Load<T>> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (response.status === 403) return { state: "admin" };
    if (!response.ok) return { state: "error" };
    const data: unknown = await response.json();
    return valid(data) ? { state: "ready", data: data as T } : { state: "error" };
  } catch {
    return { state: "error" };
  }
}

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export async function readStatus(): Promise<AiStatus> {
  try {
    const response = await fetch("/api/ai/status", { cache: "no-store" });
    return response.ok ? await response.json() as AiStatus : { available: false, model: "", error: `HTTP ${response.status}` };
  } catch {
    return { available: false, model: "", error: "nicht erreichbar" };
  }
}

/** The loading, admin-only and error states of a page that reads an admin endpoint. */
export function LoadNote({ load, what }: { load: Load<unknown>; what: string }) {
  if (load.state === "ready") return null;
  return <p className="text-sm text-muted-foreground">
    {load.state === "loading" ? "Lade …" : load.state === "admin" ? `${what} kann nur der Administrator ansehen und bearbeiten.` : `${what} ist gerade nicht lesbar.`}
  </p>;
}

// The agent repo as GET /api/agent-repo returns it.
export type RepoPrompt = { id: PromptId; agent: AgentKey; label: string; hint: string; default: string; text: string; custom: boolean };
export type RepoHistory = { key: string; label: string; v: number; at: string; by: string; note?: string; reset: boolean };
export type RepoAgent = {
  key: AgentKey; name: string; kind: AgentKind; summary: string; mode?: string; config?: AgentConfig; defaults?: AgentConfig;
  tools: string[]; sources: DataSource[]; prompts: RepoPrompt[]; assembled?: string; knowledge: number; edits: number; version?: number; history: RepoHistory[];
};
export type RepoTool = {
  name: string; label: string; kind: ToolKind; source?: DataSource; agents: AgentKey[]; description: string; default: string; custom: boolean; version?: number;
  param: { name: string; description: string };
};
export type RepoDoc = { id: string; title: string; text: string; chars: number; code: boolean; custom: boolean; version?: number; by?: string; at?: string };
export type RepoOverview = {
  file: string; agents: RepoAgent[]; tools: RepoTool[]; knowledge: Partial<Record<AgentKey, RepoDoc[]>>; sources: DataSource[]; catalog: CatalogEntry[];
  limits: { knowledgeChars: number; knowledgeDoc: number; promptLength: number; toolDescription: number };
};
const isRepo = (data: unknown) => isObject(data) && typeof data.file === "string" && Array.isArray(data.agents) && Array.isArray(data.tools)
  && isObject(data.knowledge) && isObject(data.limits);
export const readRepo = () => readJson<RepoOverview>("/api/agent-repo", isRepo);

export type RepoChange = { key: string; value: unknown };
type RepoRequest = { changes: RepoChange[]; note?: string } | { reset: AgentKey };

/** Saves new versions in the agent repo (PUT) or resets an agent (POST); the answer is the new overview. */
export async function sendRepo(request: RepoRequest): Promise<{ ok: true; data: RepoOverview } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/agent-repo", { method: "reset" in request ? "POST" : "PUT", headers: { "Content-Type": "application/json" },
      cache: "no-store", body: JSON.stringify(request) });
    const data: unknown = await response.json().catch(() => undefined);
    if (response.ok && isRepo(data)) return { ok: true, data: data as RepoOverview };
    return { ok: false, error: isObject(data) && typeof data.error === "string" ? data.error : `Speichern hat nicht geklappt (HTTP ${response.status}).` };
  } catch {
    return { ok: false, error: "Speichern hat nicht geklappt – keine Verbindung." };
  }
}

/** One save or reset in the repo with its busy state and the note it leaves. */
export function useRepoSave(onSaved: (data: RepoOverview) => void) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>();
  const run = async (request: RepoRequest, success: string) => {
    setBusy(true);
    setNote(undefined);
    const result = await sendRepo(request);
    setBusy(false);
    if (result.ok) onSaved(result.data);
    setNote(result.ok ? { ok: true, text: success } : { ok: false, text: result.error });
    return result.ok;
  };
  return { busy, note, setNote, run };
}

// The header's "Aktualisieren" asks the open subpage to load its data again; the button spins while anything loads.
export const RefreshContext = createContext<{ tick: number; track: (work: Promise<unknown>) => void }>({ tick: 0, track: () => undefined });

export function useLoad<T>(read: () => Promise<T>, initial: T): [T, (value: T) => void] {
  const { tick, track } = useContext(RefreshContext);
  const [value, setValue] = useState(initial);
  useEffect(() => {
    let alive = true;
    track(read().then((next) => { if (alive) setValue(next); }));
    return () => { alive = false; };
  }, [read, tick, track]);
  return [value, setValue];
}

/** The page's agent repo, shared by the parts of one page so that a save updates all of them. */
export const useRepo = () => useLoad<Load<RepoOverview>>(readRepo, { state: "loading" });

/**
 * Whether a media query matches. The server and the first client render know nothing (undefined): render both variants and let
 * CSS pick one, so nothing flashes. Without matchMedia (tests) the wide variant wins.
 */
function mediaHook(query: string) {
  const subscribe = (onChange: () => void) => {
    if (typeof window.matchMedia !== "function") return () => undefined;
    const media = window.matchMedia(query);
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  };
  const snapshot = () => typeof window.matchMedia === "function" ? window.matchMedia(query).matches : true;
  return () => useSyncExternalStore<boolean | undefined>(subscribe, snapshot, () => undefined);
}
/** md and up: graphs and tables instead of stacked lists. */
export const useWide = mediaHook("(min-width: 768px)");
/** xl and up: tables with many columns, three-column layouts. */
export const useLarge = mediaHook("(min-width: 1280px)");

/** The `#…` of the address, also after in-page links; the pages use it to open a tab, select an entry or mark a tool. */
export function useHash(): string {
  const [hash, setHash] = useState("");
  useEffect(() => {
    const read = () => setHash(decodeURIComponent(window.location.hash.slice(1)));
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  return hash;
}

/** An empty state with an icon, a title and a sentence. */
export function Empty({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border/70 p-5">
    <Icon aria-hidden="true" className="size-5 text-muted-foreground" />
    <div>
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-0.5 text-xs text-muted-foreground">{children}</div>}
    </div>
  </div>;
}

export const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
export const textareaClass = "block w-full resize-y rounded-xl border border-input bg-background/60 p-3 font-mono text-xs leading-relaxed text-foreground shadow-inner "
  + focusRing;
