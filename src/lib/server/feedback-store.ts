import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { feedbackFile, isFeedbackFile, readFeedbackFile, upsertFeedback, type FeedbackFile, type StoredFeedback } from "@/lib/assistant/feedback";

/** The file exists but is no readable feedback file (edited by hand, or the path points at another file); it is left untouched. */
export class FeedbackFileError extends Error {
  constructor() {
    super("The feedback file is damaged or belongs to something else; it is not overwritten.");
    this.name = "FeedbackFileError";
  }
}

/**
 * Where the feedback file lives: `FINANZBLICK_FEEDBACK_FILE` (absolute) when set; in production next to the account
 * database, because the app directory is read-only there; otherwise `data/assistant-feedback.json` in the project.
 */
export function feedbackFilePath(env: Record<string, string | undefined> = process.env): string {
  const configured = env.FINANZBLICK_FEEDBACK_FILE?.trim();
  if (configured && !isAbsolute(configured)) throw new Error("FINANZBLICK_FEEDBACK_FILE must be absolute.");
  const database = env.FINANZBLICK_DATABASE_PATH?.trim();
  const path = configured || (env.NODE_ENV === "production" && database && isAbsolute(database)
    ? join(dirname(database), "assistant-feedback.json")
    : resolve(/* turbopackIgnore: true */ process.cwd(), "data", "assistant-feedback.json"));
  const inPublic = relative(resolve(/* turbopackIgnore: true */ process.cwd(), "public"), path);
  if (!inPublic.startsWith(`..${sep}`) && inPublic !== ".." && !isAbsolute(inPublic)) throw new Error("The feedback file must not be inside public.");
  return path;
}

/** The path as shown in the app: relative to the project when it lies inside it. */
export function feedbackDisplayPath(path = feedbackFilePath()): string {
  const inside = relative(/* turbopackIgnore: true */ process.cwd(), path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside.split(sep).join("/") : path;
}

let queue: Promise<unknown> = Promise.resolve();
// One write at a time, so two quick ratings never lose each other.
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(task);
  queue = next;
  return next;
}

/** All stored entries, oldest first. A missing or empty file has none; a damaged or foreign one throws, so it is never replaced. */
export async function readFeedback(path = feedbackFilePath()): Promise<StoredFeedback[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  // Editors on Windows may add a byte order mark.
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.trim()) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new FeedbackFileError();
  }
  if (!isFeedbackFile(value)) throw new FeedbackFileError();
  return readFeedbackFile(value);
}

async function writeFile(path: string, content: FeedbackFile) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if ((await lstat(dirname(path))).isSymbolicLink()) throw new Error("The feedback directory must not be a symlink.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    // Indented, so the file stays readable when it is opened or handed to Copilot.
    await file.writeFile(`${JSON.stringify(content, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600).catch(() => undefined);
}

/** Adds the entry to the file (or updates it, when a comment follows the rating) and returns the new counts. */
export function recordFeedback(entry: StoredFeedback, path = feedbackFilePath()): Promise<FeedbackFile["count"]> {
  return serialized(async () => {
    const next = feedbackFile(upsertFeedback(await readFeedback(path), entry));
    await writeFile(path, next);
    return next.count;
  });
}

/** The current file, as it is downloaded. */
export async function feedbackDocument(path = feedbackFilePath()): Promise<FeedbackFile> {
  return feedbackFile(await readFeedback(path));
}
