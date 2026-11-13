import type { AutomationStore } from "@/lib/automation/store";
import type { AppState } from "@/lib/types";
import { type LogoSweepOptions, type LogoSweepResult, sweepMissingLogos } from "./logo-sweep";

const BATCH = 5;
const PAUSE_MS = 3_000;
const RATE_LIMIT_PAUSE_MS = 60_000;
const FAILURE_PAUSE_MS = 10 * 60_000;
const MAX_BATCHES = 40;

type Sweep = (store: AutomationStore, userId: string, state: AppState, options: LogoSweepOptions) => Promise<LogoSweepResult>;

/**
 * Looks up logos for the merchants of freshly imported statements, beside the import queue: a few merchants
 * per batch, politely paced, never holding up the next statement. Accounts are swept one after another.
 */
export class ImportLogoSweep {
  private readonly pending = new Set<string>();
  private active?: Promise<void>;

  constructor(
    private readonly store: AutomationStore,
    private readonly options: { sweep?: Sweep; pauseMs?: number; sweepOptions?: Omit<LogoSweepOptions, "signal" | "limit"> } = {},
  ) {}

  /** Remembers an account whose bookings just changed and starts the sweep if none is running. */
  imported(userId: string, signal: AbortSignal) {
    this.pending.add(userId);
    this.start(signal);
  }

  get running() {
    return this.active;
  }

  private start(signal: AbortSignal) {
    if (this.active || signal.aborted) return;
    this.active = this.drain(signal).finally(() => {
      this.active = undefined;
      if (this.pending.size && !signal.aborted) this.start(signal);
    });
  }

  private async drain(signal: AbortSignal) {
    const sweep = this.options.sweep ?? sweepMissingLogos;
    const pause = (ms: number) => new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    while (this.pending.size && !signal.aborted) {
      const [userId] = this.pending;
      this.pending.delete(userId);
      for (let batch = 0; batch < MAX_BATCHES && !signal.aborted; batch++) {
        const state = this.store.accounts.getFinance(userId).state;
        if (!state) break;
        const result = await sweep(this.store, userId, state, { ...this.options.sweepOptions, limit: BATCH, signal }).catch((error: unknown) => {
          if (!signal.aborted) console.error("Logo search after import failed:", error instanceof Error ? error.name : "unknown error");
          return undefined;
        });
        if (!result) {
          if (!signal.aborted) await pause(FAILURE_PAUSE_MS);
          break;
        }
        if (!result.remaining || (!result.checked && !result.rateLimited)) break;
        await pause(result.rateLimited ? RATE_LIMIT_PAUSE_MS : (this.options.pauseMs ?? PAUSE_MS));
      }
    }
  }
}
