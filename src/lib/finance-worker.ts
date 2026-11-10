import type { Dashboard } from "@/lib/calc";
import type { AppState } from "@/lib/types";

export type FinanceWorkerRequest =
  | { id: number; kind: "prepare"; data: AppState; reference?: AppState }
  | { id: number; kind: "autoAssign"; state: AppState }
  | { id: number; kind: "webAssign"; state: AppState; found: unknown[]; now: number }
  | { id: number; kind: "extras"; state: AppState }
  | { id: number; kind: "settle"; state: AppState };
export type FinanceWorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; message: string };
/** `unchanged`: preparing produced exactly the loaded data, so the caller keeps its own object. */
export type PreparedState = { unchanged: true; dashboard: Dashboard } | { unchanged: false; state: AppState; dashboard: Dashboard };
export type SettlePreview = { changed: false } | { changed: true; state: AppState };
export type AssignPreview = { changed: false; applied: string[] } | { changed: true; state: AppState; applied: string[] };

type Task = FinanceWorkerRequest extends infer Request ? Request extends { id: number } ? Omit<Request, "id"> : never : never;

let worker: Worker | null | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function failAll(message: string) {
  for (const { reject } of pending.values()) reject(new Error(message));
  pending.clear();
}

function financeWorker(): Worker | null {
  if (worker !== undefined) return worker;
  if (typeof window === "undefined" || typeof Worker === "undefined") return (worker = null);
  try {
    const created = new Worker(new URL("./finance-compute.worker.ts", import.meta.url), { type: "module", name: "finance-compute" });
    created.onmessage = (event: MessageEvent<FinanceWorkerResponse>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data.result);
      else entry.reject(new Error(event.data.message));
    };
    created.onerror = (event) => {
      event.preventDefault();
      // A broken worker falls back to the main thread for good.
      worker = null;
      created.terminate();
      failAll("Finance worker failed");
    };
    worker = created;
  } catch {
    worker = null;
  }
  return worker;
}

/** Runs a finance computation off the main thread; null when workers are unavailable (server, tests). */
export function runFinanceTask<T>(task: Task): Promise<T> | null {
  const target = financeWorker();
  if (!target) return null;
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    try {
      target.postMessage({ ...task, id });
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
