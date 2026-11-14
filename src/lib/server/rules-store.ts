import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { activeRules, rulesFile, rulesFileSchema, type FeedbackRule, type RuleText } from "@/lib/assistant/feedback-rules";
import { feedbackFilePath } from "./feedback-store";

/** The file exists but is no readable rules file; it is left untouched. */
export class RulesFileError extends Error {
  constructor() {
    super("The rules file is damaged or belongs to something else; it is not overwritten.");
    this.name = "RulesFileError";
  }
}

/** Next to the feedback file (data/ in development, next to the account database in production), or `FINANZBLICK_RULES_FILE`. */
export function rulesFilePath(env: Record<string, string | undefined> = process.env): string {
  const configured = env.FINANZBLICK_RULES_FILE?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("FINANZBLICK_RULES_FILE must be absolute.");
    return configured;
  }
  return join(dirname(feedbackFilePath(env)), "assistant-rules.json");
}

/** All rules, oldest first. A missing or empty file has none; a damaged one throws, so it is never replaced. */
export async function readRules(path = rulesFilePath()): Promise<FeedbackRule[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RulesFileError();
  }
  const parsed = rulesFileSchema.safeParse(value);
  if (!parsed.success) throw new RulesFileError();
  return parsed.data.rules;
}

async function writeRules(path: string, rules: FeedbackRule[]) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("The rules directory must not be a symlink.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(rulesFile(rules), null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

let queue: Promise<unknown> = Promise.resolve();
/** Reads, changes and writes the file, one change at a time. */
export function changeRules(change: (rules: FeedbackRule[]) => FeedbackRule[], path = rulesFilePath()): Promise<FeedbackRule[]> {
  const next = queue.catch(() => undefined).then(async () => {
    const rules = change(await readRules(path));
    await writeRules(path, rules);
    return rules;
  });
  queue = next;
  return next;
}

let cached: { path: string; mtimeMs: number; size: number; rules: RuleText[] } | undefined;
/**
 * The active rules for the prompts, read on every assistant request; the file is parsed again only when it changed.
 * Missing or damaged: no learned rules, the assistant works as before.
 */
export async function promptRules(path = rulesFilePath()): Promise<RuleText[]> {
  try {
    const info = await stat(path);
    if (cached && cached.path === path && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.rules;
    const rules = activeRules(await readRules(path));
    cached = { path, mtimeMs: info.mtimeMs, size: info.size, rules };
    return rules;
  } catch {
    return [];
  }
}
