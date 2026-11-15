import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { currentPromptId, defaultPrompts, isPromptId, MAX_PROMPT_LENGTH, promptIds, promptMeta, type PromptId, type PromptOverrides } from "@/lib/ai/agent-prompts";
import {
  agentDef, agentDefs, agentLimitBounds, agentToolSpecs, defaultKnowledge, isAgentKey, MAX_KNOWLEDGE_DOC, modelTiers, toolSpec, toolSpecs,
  type AgentConfig, type AgentKey, type KnowledgeDoc,
} from "@/lib/agents/registry";
import { applyEdit } from "@/lib/assistant/feedback-rules";
import { readRules, rulesFilePath } from "./rules-store";

/**
 * The agent repo: code defaults, overridden by the edits saved here, every edit a new version. Prompts, model and limits per
 * agent, tool descriptions and the agents' knowledge each keep their own history; the newest version is live, `null` puts the
 * code default back ("Auf Code zurücksetzen"). A save applies to the next run. One local JSON file next to the prompts file of
 * earlier versions (config/agent-repo.json, in production next to the database), which it takes over once.
 */

export const REPO_FORMAT = "finanzblick-agent-repo";
const MAX_VERSIONS = 30;
export const MAX_TOOL_DESCRIPTION = 1200;

/** The file exists but is no readable agent repo; it is left untouched. */
export class AgentRepoFileError extends Error {
  constructor() {
    super("The agent repo file is damaged or belongs to something else; it is not overwritten.");
    this.name = "AgentRepoFileError";
  }
}

export type RepoKey = `prompt:${PromptId}` | `agent:${AgentKey}` | `tool:${string}` | `knowledge:${AgentKey}:${string}`;
const versionSchema = z.object({
  v: z.number().int().positive(),
  at: z.string().max(40),
  by: z.string().max(60),
  note: z.string().max(200).optional(),
  value: z.unknown(),
}).strict();
export type RepoVersion = z.infer<typeof versionSchema> & { value: unknown };
const fileSchema = z.object({ format: z.literal(REPO_FORMAT), version: z.literal(1), items: z.record(z.string(), z.array(versionSchema).max(MAX_VERSIONS)) }).strict();
export type RepoFile = { format: typeof REPO_FORMAT; version: 1; items: Record<string, RepoVersion[]> };

const configSchema = z.object({
  tier: z.enum(modelTiers as [AgentConfig["tier"], ...AgentConfig["tier"][]]).optional(),
  ...Object.fromEntries(Object.entries(agentLimitBounds).map(([key, bound]) => [key, z.number().int().min(bound.min).max(bound.max).optional()])),
}).strict();
export type AgentOverride = Partial<AgentConfig>;
const docSchema = z.union([
  z.object({ title: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(MAX_KNOWLEDGE_DOC) }).strict(),
  z.object({ deleted: z.literal(true) }).strict(),
]);

/** Checks a value for its key; `null` (back to the code default) fits every key. Undefined when the key or value is invalid. */
export function cleanRepoValue(key: string, value: unknown): unknown | undefined {
  if (value === null) return null;
  const [kind, id, doc] = key.split(":");
  if (kind === "prompt") return isPromptId(id) && typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_PROMPT_LENGTH) : undefined;
  if (kind === "agent") {
    if (!isAgentKey(id) || !agentDef(id).config) return undefined;
    const parsed = configSchema.safeParse(value);
    return parsed.success && Object.keys(parsed.data).length ? parsed.data : undefined;
  }
  if (kind === "tool") return toolSpec(id) && typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, MAX_TOOL_DESCRIPTION) : undefined;
  if (kind === "knowledge") {
    if (!isAgentKey(id) || !doc || !/^[a-z0-9-]{3,60}$/.test(doc)) return undefined;
    const parsed = docSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }
  return undefined;
}

export type RepoLive = {
  prompts: PromptOverrides;
  agents: Partial<Record<AgentKey, AgentConfig>>;
  /** Effective tool descriptions, code defaults included. */
  tools: Record<string, string>;
  knowledge: Partial<Record<AgentKey, KnowledgeDoc[]>>;
};

const live = (versions: RepoVersion[] | undefined) => versions?.at(-1)?.value ?? null;

/** What a run uses: the code defaults with the newest version of every edited item on top. */
export function repoLive(file: RepoFile): RepoLive {
  const prompts: PromptOverrides = {};
  for (const id of promptIds) {
    const value = live(file.items[`prompt:${id}`]);
    if (typeof value === "string" && value.trim() && value.trim() !== defaultPrompts[id]) prompts[id] = value;
  }
  const agents: RepoLive["agents"] = {};
  for (const agent of agentDefs) {
    if (!agent.config) continue;
    const value = live(file.items[`agent:${agent.key}`]) as AgentOverride | null;
    agents[agent.key] = { ...agent.config, ...(value ?? {}) };
  }
  const tools = Object.fromEntries(toolSpecs.map((tool) => {
    const value = live(file.items[`tool:${tool.name}`]);
    return [tool.name, typeof value === "string" && value ? value : tool.description];
  }));
  const knowledge: RepoLive["knowledge"] = {};
  for (const agent of agentDefs) {
    const docs = new Map((defaultKnowledge[agent.key] ?? []).map((doc) => [doc.id, doc]));
    const prefix = `knowledge:${agent.key}:`;
    for (const [key, versions] of Object.entries(file.items)) {
      if (!key.startsWith(prefix)) continue;
      const id = key.slice(prefix.length);
      const value = live(versions) as { title: string; text: string } | { deleted: true } | null;
      if (value === null) {
        const code = (defaultKnowledge[agent.key] ?? []).find((doc) => doc.id === id);
        if (code) docs.set(id, code);
        else docs.delete(id);
      } else if ("deleted" in value) docs.delete(id);
      else docs.set(id, { id, title: value.title, text: value.text });
    }
    if (docs.size) knowledge[agent.key] = [...docs.values()];
  }
  return { prompts, agents, tools, knowledge };
}

/** The repo next to the prompts file of earlier versions, or `FINANZBLICK_AGENT_REPO`. */
export function agentRepoPath(env: Record<string, string | undefined> = process.env): string {
  const configured = env.FINANZBLICK_AGENT_REPO?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("FINANZBLICK_AGENT_REPO must be absolute.");
    return configured;
  }
  return join(dirname(legacyPromptsPath(env)), "agent-repo.json");
}

/** Where earlier versions kept the edited prompts: `FINANZBLICK_AGENT_PROMPTS`, next to the database in production, else config/. */
export function legacyPromptsPath(env: Record<string, string | undefined> = process.env): string {
  const configured = env.FINANZBLICK_AGENT_PROMPTS?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("FINANZBLICK_AGENT_PROMPTS must be absolute.");
    return configured;
  }
  const database = env.FINANZBLICK_DATABASE_PATH?.trim();
  return env.NODE_ENV === "production" && database && isAbsolute(database)
    ? join(dirname(database), "agent-prompts.json")
    : resolve(/* turbopackIgnore: true */ process.cwd(), "config", "agent-prompts.json");
}

async function readJson(path: string): Promise<unknown | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new AgentRepoFileError();
  }
}

const emptyRepo = (): RepoFile => ({ format: REPO_FORMAT, version: 1, items: {} });
/** The code defaults alone, e.g. for the gold eval. */
export const codeRepo = (): RepoLive => repoLive(emptyRepo());

/**
 * Takes over the prompts file of earlier versions once: its edits become the first versions. The supervisor's planning and
 * writing prompts were merged into the orchestrator's; their text no longer fits, so only what the review agent had learned
 * there (sentences of active changes that are in the old text) moves to the orchestrator's prompt.
 */
async function migrate(path: string, rulesPath: string, now: string): Promise<RepoFile | undefined> {
  const legacy = join(dirname(path), "agent-prompts.json");
  if (basename(path) === basename(legacy)) return undefined;
  const value = await readJson(legacy).catch(() => undefined) as { format?: unknown; prompts?: Record<string, unknown> } | undefined;
  if (value?.format !== "finanzblick-agent-prompts" || !value.prompts || typeof value.prompts !== "object") return undefined;
  const file = emptyRepo();
  const merged: string[] = [];
  for (const [id, text] of Object.entries(value.prompts)) {
    if (typeof text !== "string" || !text.trim()) continue;
    if (id === "supervisor" || id === "synthesis") {
      merged.push(text);
      continue;
    }
    const current = currentPromptId(id);
    if (current && text.trim() !== defaultPrompts[current]) file.items[`prompt:${current}`] = [{ v: 1, at: now, by: "Migration", note: "aus agent-prompts.json übernommen", value: text.trim() }];
  }
  if (merged.length) {
    const learned = (await readRules(rulesPath).catch(() => []))
      .filter((rule) => rule.status === "active" && rule.kind === "prompt" && rule.prompt?.id === "agent.orchestrator" && merged.some((text) => text.includes(rule.prompt!.after)));
    let text = defaultPrompts["agent.orchestrator"];
    for (const rule of learned) text = applyEdit(text, { ...rule.prompt!, mode: "append" }) ?? text;
    if (learned.length) file.items["prompt:agent.orchestrator"] = [{ v: 1, at: now, by: "Prüfungs-Agent", note: "gelernte Sätze aus der Planung übernommen", value: text }];
  }
  return file;
}

async function load(path: string, rulesPath?: string): Promise<{ file: RepoFile; migrated: boolean }> {
  const value = await readJson(path);
  if (value === undefined) {
    const migrated = await migrate(path, rulesPath ?? rulesFilePath(), new Date().toISOString());
    return { file: migrated ?? emptyRepo(), migrated: !!migrated };
  }
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) throw new AgentRepoFileError();
  return { file: parsed.data as RepoFile, migrated: false };
}

/** The whole repo with every version; a missing file is empty (or taken over from the prompts file of earlier versions). */
export async function readRepo(path = agentRepoPath(), rulesPath?: string): Promise<RepoFile> {
  return (await load(path, rulesPath)).file;
}

async function writeRepo(path: string, file: RepoFile) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("The agent repo directory must not be a symlink.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

let queue: Promise<unknown> = Promise.resolve();
let cached: { path: string; mtimeMs: number; size: number; live: RepoLive } | undefined;

export type SaveMeta = { by: string; note?: string; at?: Date };
export type RepoChange = { key: RepoKey; value: unknown };

/**
 * Saves new versions, one change at a time: a value equal to the live one adds nothing. Invalid keys or values throw a
 * RangeError, so a route can answer 400.
 */
export function saveRepo(changes: RepoChange[], meta: SaveMeta, path = agentRepoPath(), rulesPath?: string): Promise<RepoFile> {
  const next = queue.catch(() => undefined).then(async () => {
    const { file } = await load(path, rulesPath);
    const at = (meta.at ?? new Date()).toISOString();
    for (const change of changes) {
      const value = cleanRepoValue(change.key, change.value);
      if (value === undefined) throw new RangeError(`Ungültiger Eintrag: ${change.key}`);
      const versions = file.items[change.key] ?? [];
      if (JSON.stringify(live(versions)) === JSON.stringify(value) && (versions.length || value === null)) continue;
      file.items[change.key] = [...versions, { v: (versions.at(-1)?.v ?? 0) + 1, at, by: meta.by.slice(0, 60),
        ...(meta.note ? { note: meta.note.slice(0, 200) } : {}), value }].slice(-MAX_VERSIONS);
    }
    await writeRepo(path, file);
    cached = undefined;
    return file;
  });
  queue = next;
  return next;
}

/** Every key that belongs to an agent: its prompts, its model and limits, its tools' descriptions and its knowledge. */
export function agentRepoKeys(agent: AgentKey, file: RepoFile): RepoKey[] {
  return [
    ...promptMeta.filter((meta) => meta.agent === agent).map((meta): RepoKey => `prompt:${meta.id}`),
    ...(agentDef(agent).config ? [`agent:${agent}` as RepoKey] : []),
    ...agentToolSpecs(agent).map((tool): RepoKey => `tool:${tool.name}`),
    ...Object.keys(file.items).filter((key): key is RepoKey => key.startsWith(`knowledge:${agent}:`)),
  ];
}

/** "Alles auf Code zurücksetzen": a `null` version for every edited key of the agent; the history stays. */
export async function resetAgent(agent: AgentKey, meta: SaveMeta, path = agentRepoPath()): Promise<RepoFile> {
  const file = await readRepo(path);
  const keys = agentRepoKeys(agent, file).filter((key) => live(file.items[key]) !== null);
  return saveRepo(keys.map((key) => ({ key, value: null })), { ...meta, note: meta.note ?? "Auf Code zurückgesetzt" }, path);
}

/**
 * What the next run uses, read on every agent request; the file is parsed again only when it changed. Missing or damaged:
 * the code defaults (or what migration finds), so the assistant keeps working.
 */
export async function activeRepo(path = agentRepoPath()): Promise<RepoLive> {
  try {
    const info = await stat(path).catch(() => undefined);
    if (info && cached && cached.path === path && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.live;
    const { file, migrated } = await load(path);
    // A migration is written once, so later edits build on it.
    if (migrated) await saveRepo([], { by: "Migration" }, path);
    const value = repoLive(file);
    const written = await stat(path).catch(() => undefined);
    if (written) cached = { path, mtimeMs: written.mtimeMs, size: written.size, live: value };
    return value;
  } catch {
    return repoLive(emptyRepo());
  }
}

/** The config of an agent with limits (llm and background agents); the code default without one saved. */
export const liveConfig = (repo: RepoLive, agent: AgentKey): AgentConfig | undefined => repo.agents[agent] ?? agentDef(agent).config;

