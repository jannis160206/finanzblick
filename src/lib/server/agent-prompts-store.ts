import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { defaultPrompts, isPromptId, MAX_PROMPT_LENGTH, type PromptId, type PromptOverrides } from "@/lib/ai/agent-prompts";

/** The file exists but is no readable prompts file; it is left untouched. */
export class AgentPromptsFileError extends Error {
  constructor() {
    super("The agent prompts file is damaged or belongs to something else; it is not overwritten.");
    this.name = "AgentPromptsFileError";
  }
}

const FORMAT = "finanzblick-agent-prompts";
const fileSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(1),
  prompts: z.record(z.string(), z.string().max(MAX_PROMPT_LENGTH)),
});

/**
 * `FINANZBLICK_AGENT_PROMPTS`, or next to the account database in production (the only writable place there), else
 * config/agent-prompts.json in the project.
 */
export function agentPromptsPath(env: Record<string, string | undefined> = process.env): string {
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

/** The admin's prompts. A missing or empty file has none; a damaged one throws, so it is never replaced. Unknown ids are skipped. */
export async function readPromptOverrides(path = agentPromptsPath()): Promise<PromptOverrides> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AgentPromptsFileError();
  }
  const parsed = fileSchema.safeParse(value);
  if (!parsed.success) throw new AgentPromptsFileError();
  return Object.fromEntries(Object.entries(parsed.data.prompts).filter(([id, prompt]) => isPromptId(id) && prompt.trim()));
}

async function writePrompts(path: string, prompts: PromptOverrides) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("The prompts directory must not be a symlink.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify({ format: FORMAT, version: 1, prompts }, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

let queue: Promise<unknown> = Promise.resolve();
let cached: { path: string; mtimeMs: number; size: number; prompts: PromptOverrides } | undefined;

/** Saves one prompt, or drops it with `undefined` (or the unchanged default), one change at a time. */
export function savePrompt(id: PromptId, text: string | undefined, path = agentPromptsPath()): Promise<PromptOverrides> {
  const next = queue.catch(() => undefined).then(async () => {
    const prompts = { ...await readPromptOverrides(path) };
    const value = text?.trim();
    if (!value || value === defaultPrompts[id]) delete prompts[id];
    else prompts[id] = value.slice(0, MAX_PROMPT_LENGTH);
    await writePrompts(path, prompts);
    cached = undefined;
    return prompts;
  });
  queue = next;
  return next;
}

/**
 * The prompts for the next chat run, read on every assistant request; the file is parsed again only when it changed.
 * Missing or damaged: the defaults in the code, the assistant works as before.
 */
export async function activePrompts(path = agentPromptsPath()): Promise<PromptOverrides> {
  try {
    const info = await stat(path);
    if (cached && cached.path === path && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.prompts;
    const prompts = await readPromptOverrides(path);
    cached = { path, mtimeMs: info.mtimeMs, size: info.size, prompts };
    return prompts;
  } catch {
    return {};
  }
}
