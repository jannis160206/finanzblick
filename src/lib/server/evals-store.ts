import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { feedbackFilePath } from "./feedback-store";

/**
 * The eval runs: every gold eval the admin starts and every one the review agent runs for a change, with score and the cases
 * that failed. One local JSON file next to the feedback file (`FINANZBLICK_EVALS_FILE`), the newest 30 runs.
 */

export const MAX_EVAL_RUNS = 30;
const caseSchema = z.object({
  group: z.string().max(20), label: z.string().max(200), ok: z.boolean(), hard: z.boolean(), got: z.string().max(240), ms: z.number().int().nonnegative(),
}).strict();
export const evalRunSchema = z.object({
  id: z.string().max(60),
  suite: z.literal("gold"),
  trigger: z.string().max(80),
  status: z.enum(["running", "done", "error"]),
  startedAt: z.string().max(40),
  finishedAt: z.string().max(40).optional(),
  model: z.string().max(80).optional(),
  score: z.object({ passed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), hard: z.number().int().nonnegative() }).strict().optional(),
  // Only the cases that failed (or touched a safety rule) are kept, besides the count.
  failed: z.array(caseSchema).max(100).optional(),
  ms: z.number().int().nonnegative().optional(),
  error: z.string().max(200).optional(),
}).strict();
export type EvalRun = z.infer<typeof evalRunSchema>;
const fileSchema = z.object({ format: z.literal("finanzblick-assistant-evals"), version: z.literal(1), runs: z.array(evalRunSchema).max(MAX_EVAL_RUNS) }).strict();

export function evalsFilePath(env: Record<string, string | undefined> = process.env): string {
  const configured = env.FINANZBLICK_EVALS_FILE?.trim();
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("FINANZBLICK_EVALS_FILE must be absolute.");
    return configured;
  }
  return join(dirname(feedbackFilePath(env)), "assistant-evals.json");
}

/** The runs, oldest first. A missing, empty or damaged file has none (the runs are only a log). */
export async function readEvals(path = evalsFilePath()): Promise<EvalRun[]> {
  try {
    const parsed = fileSchema.safeParse(JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, "")));
    return parsed.success ? parsed.data.runs : [];
  } catch {
    return [];
  }
}

async function writeEvals(path: string, runs: EvalRun[]) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("The evals directory must not be a symlink.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ format: "finanzblick-assistant-evals", version: 1, runs: runs.slice(-MAX_EVAL_RUNS) }, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

let queue: Promise<unknown> = Promise.resolve();
/** Adds a run or replaces it by id, one change at a time. */
export function saveEval(run: EvalRun, path = evalsFilePath()): Promise<EvalRun[]> {
  const next = queue.catch(() => undefined).then(async () => {
    const runs = (await readEvals(path)).filter((item) => item.id !== run.id);
    const saved = [...runs, evalRunSchema.parse(run)].slice(-MAX_EVAL_RUNS);
    await writeEvals(path, saved);
    return saved;
  });
  queue = next;
  return next;
}

export const newEvalId = () => randomUUID();
