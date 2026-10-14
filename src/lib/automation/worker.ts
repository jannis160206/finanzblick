import { unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createEmptyAccountState } from "@/lib/account-state";
import {
  commitStatementImport,
  prepareStatementImport,
  queueLedgerReview,
} from "@/lib/import/review";
import { refreshPlanning } from "@/lib/planning";
import { isAccountError } from "@/lib/server/errors";
import { appStateSchema } from "@/lib/types";
import { MerchantIndex } from "./merchants";
import { PARSER_BUDGET_MS, parseStatementInChild, type ParserRuntimeOptions } from "./parser-runtime";
import { automationFailure, ParserFailure } from "./errors";
import type { ImportResult } from "@/lib/import/result-schema";
import {
  backfillBatch,
  enrichTransaction,
  retainLockedAssignments,
} from "./pipeline";
import { AutomationStore, WorkerLeaseError, type ClaimedJob } from "./store";
import { createAccountMerchantResolver, createHistoryResolver } from "./aliases";

export class AutomationWorker {
  private nextMetadataCleanupAt = 0;

  constructor(
    readonly store: AutomationStore,
    readonly owner: string,
    public index: MerchantIndex,
    readonly parserOptions: Omit<ParserRuntimeOptions, "signal"> = {},
    private readonly maintainCatalogue?: (signal: AbortSignal, owner: string) => Promise<MerchantIndex | undefined>,
  ) {}

  async process(job: ClaimedJob, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.parserOptions.budgetMs ?? PARSER_BUDGET_MS);
    const checkCancellation = () => {
      if (signal?.aborted) throw new ParserFailure("WORKER_ABORTED");
      if (Date.now() >= deadline) throw new ParserFailure("PARSE_TIMEOUT");
    };
    checkCancellation();
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
        (db) => {
          checkCancellation();
          this.store.checkpoint(
            db,
            this.owner,
            job,
            batch.cursor,
            batch.cursor >= job.total,
          );
        },
      );
      return;
    }
    this.store.progress(this.owner, job, 5);
    const result = await parseStatementInChild(
      this.store.filePath(job.id), job.name, job.bytes,
      { ...this.parserOptions, budgetMs: Math.max(1, deadline - Date.now()), signal },
    );
    checkCancellation();
    this.store.progress(this.owner, job, 40);
    const snapshot = this.store.accounts.getFinance(job.userId);
    const knownState = snapshot.state ?? createEmptyAccountState();
    const resolveAccount = createAccountMerchantResolver(knownState);
    const resolveHistory = createHistoryResolver(knownState);
    const rows: typeof result.rows = [];
    for (let offset = 0; offset < result.rows.length; offset += 200) {
      checkCancellation();
      for (let i = offset; i < Math.min(offset + 200, result.rows.length); i++)
        rows.push(
          enrichTransaction(result.rows[i], this.index, resolveAccount, resolveHistory),
        );
      this.store.progress(
        this.owner,
        job,
        40 + (40 * rows.length) / Math.max(1, result.rows.length),
      );
      await delay(0);
    }
    checkCancellation();
    this.store.progress(this.owner, job, 90);
    let outcome: ImportResult | undefined;
    this.store.accounts.transformFinance(
      job.userId,
      (stored) => {
        checkCancellation();
        const state = stored ?? createEmptyAccountState();
        const revision = this.store.accounts.read((db) =>
          Number(
            db
              .prepare("SELECT revision FROM finance WHERE user_id = ?")
              .get(job.userId)?.revision ?? 0,
          ),
        );
        const currentRules =
          revision !== snapshot.revision
            ? { account: createAccountMerchantResolver(state), history: createHistoryResolver(state) }
            : null;
        const enriched = {
          ...result,
          uploadId: job.id,
          rows: currentRules
            ? result.rows.map((row) =>
                enrichTransaction(row, this.index, currentRules.account, currentRules.history),
              )
            : rows,
        };
        const prepared = prepareStatementImport([enriched], state);
        const committed = commitStatementImport(
          state,
          prepared.automatic,
          [],
          prepared.metadata,
        );
        const next = appStateSchema.parse(
          retainLockedAssignments(
            state,
            refreshPlanning(queueLedgerReview(committed.state)),
          ),
        );
        outcome = next.importResults?.find((item) => item.uploadId === job.id);
        if (!outcome) throw new Error("Statement outcome missing");
        checkCancellation();
        return next;
      },
      (db) => {
        checkCancellation();
        this.store.checkpoint(db, this.owner, job, result.rows.length, true, outcome);
      },
    );
  }

  async cleanup(): Promise<void> {
    for (const id of this.store.cleanupCandidates()) {
      try {
        await unlink(this.store.filePath(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error("Automation cleanup deferred:", id, "UploadCleanupError");
          continue;
        }
      }
      this.store.cleaned(id);
    }
    const now = Date.now();
    if (now >= this.nextMetadataCleanupAt) {
      this.store.pruneCompletedStatements(now);
      this.nextMetadataCleanupAt = now + 60_000;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!this.store.acquire(this.owner))
      throw new Error("Another worker is already running");
    let leaseError: unknown;
    let running = new AbortController();
    const abort = () => running.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat(this.owner);
      } catch (error) {
        leaseError = error;
        running.abort();
      }
    }, 10_000);
    try {
      while (!signal.aborted) {
        let job: ClaimedJob | null;
        try {
          if (leaseError) throw leaseError;
          await this.cleanup();
          job = this.store.claim(this.owner);
          if (!job) {
            const refreshed = await this.maintainCatalogue?.(signal, this.owner);
            if (refreshed) this.index = refreshed;
          }
        } catch (error) {
          // Recover only an idle lease; never reclaim one lost during parsing.
          if (!(error instanceof WorkerLeaseError) || signal.aborted || !this.store.acquire(this.owner))
            throw error;
          leaseError = undefined;
          running = new AbortController();
          console.info("Statement worker resumed after an idle lease interruption.");
          continue;
        }
        if (!job) {
          await delay(500, undefined, { signal: running.signal }).catch(() => {});
          continue;
        }
        try {
          await this.process(job, running.signal);
        } catch (error) {
          if (leaseError) throw leaseError;
          if (!this.store.holds(this.owner, job)) continue;
          if (signal.aborted || (error instanceof ParserFailure && error.code === "WORKER_ABORTED")) {
            this.store.cancel(this.owner, job);
            break;
          }
          // Logs and persisted messages must never contain statement text or SQL parameters.
          console.error(
            "Automation job failed:",
            job.id,
            error instanceof ParserFailure ? error.code : "JobInfrastructureError",
          );
          this.store.fail(
            this.owner,
            job,
            error instanceof ParserFailure
              ? automationFailure(error.code)
              : isAccountError(error) && error.status === 409
                ? automationFailure("COMMIT_CONFLICT")
                : isAccountError(error)
                  ? { ...automationFailure("PARSE_RESOURCE_LIMIT"), message: error.message }
                  : automationFailure("PARSE_INFRASTRUCTURE"),
          );
        }
      }
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener("abort", abort);
      this.store.release(this.owner, signal.aborted && !leaseError);
      await this.cleanup();
    }
  }
}
