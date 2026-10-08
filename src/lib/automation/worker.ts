import { readFile, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createEmptyAccountState } from "@/lib/account-state";
import {
  commitStatementImport,
  prepareStatementImport,
  queueLedgerReview,
} from "@/lib/import/review";
import { refreshPlanning } from "@/lib/planning";
import { AccountError } from "@/lib/server/errors";
import { appStateSchema } from "@/lib/types";
import { MerchantIndex } from "./merchants";
import { parseServerStatement } from "./parse";
import {
  backfillBatch,
  enrichTransaction,
  retainLockedAssignments,
} from "./pipeline";
import { AutomationStore, type ClaimedJob } from "./store";

export class AutomationWorker {
  constructor(
    readonly store: AutomationStore,
    readonly owner: string,
    readonly index: MerchantIndex,
  ) {}

  async process(job: ClaimedJob): Promise<void> {
    if (job.kind === "backfill") {
      const batch = this.store.batch(job);
      this.store.accounts.transformFinance(
        job.userId,
        (state) =>
          backfillBatch(
            state ?? createEmptyAccountState(),
            batch.ids,
            this.index,
          ),
        (db) =>
          this.store.checkpoint(
            db,
            this.owner,
            job,
            batch.cursor,
            batch.cursor >= job.total,
          ),
      );
      return;
    }
    this.store.progress(this.owner, job, 5);
    const bytes = await readFile(this.store.filePath(job.id));
    if (bytes.byteLength !== job.bytes) throw new Error("Upload size mismatch");
    const result = await parseServerStatement(bytes, job.name);
    this.store.progress(this.owner, job, 40);
    for (let offset = 0; offset < result.rows.length; offset += 200) {
      for (let i = offset; i < Math.min(offset + 200, result.rows.length); i++)
        result.rows[i] = enrichTransaction(result.rows[i], this.index);
      this.store.progress(
        this.owner,
        job,
        40 +
          (40 * Math.min(offset + 200, result.rows.length)) /
            Math.max(1, result.rows.length),
      );
      await delay(0);
    }
    this.store.progress(this.owner, job, 90);
    this.store.accounts.transformFinance(
      job.userId,
      (stored) => {
        const state = stored ?? createEmptyAccountState();
        const prepared = prepareStatementImport([result], state);
        const committed = commitStatementImport(
          state,
          prepared.automatic,
          [],
          prepared.metadata,
        );
        return appStateSchema.parse(
          retainLockedAssignments(
            state,
            refreshPlanning(queueLedgerReview(committed.state)),
          ),
        );
      },
      (db) =>
        this.store.checkpoint(db, this.owner, job, result.rows.length, true),
    );
  }

  async cleanup(): Promise<void> {
    for (const id of this.store.cleanupCandidates()) {
      try {
        await unlink(this.store.filePath(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.store.cleaned(id);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!this.store.acquire(this.owner))
      throw new Error("Another worker is already running");
    let leaseError: unknown;
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat(this.owner);
      } catch (error) {
        leaseError = error;
      }
    }, 10_000);
    try {
      while (!signal.aborted) {
        if (leaseError) throw leaseError;
        await this.cleanup();
        const job = this.store.claim(this.owner);
        if (!job) {
          await delay(500);
          continue;
        }
        try {
          await this.process(job);
        } catch (error) {
          // Logs and persisted messages must never contain statement text or SQL parameters.
          console.error(
            "Automation job failed:",
            job.id,
            error instanceof Error ? error.name : "UnknownError",
          );
          this.store.fail(
            this.owner,
            job,
            error instanceof AccountError
              ? error.message
              : "Auszug konnte nicht verarbeitet werden. Erneuter Versuch erfolgt automatisch; nach fünf Fehlern bitte Datei prüfen.",
          );
        }
      }
    } finally {
      clearInterval(heartbeat);
      this.store.release(this.owner, signal.aborted && !leaseError);
      await this.cleanup();
    }
  }
}
