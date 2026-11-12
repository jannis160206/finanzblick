import { z } from "zod";
import { appStateSchema, type AppState } from "@/lib/types";
import { financeSnapshotSchema } from "@/lib/account-schema";
import { FinanceStorageError, financeStorageMessage } from "@/lib/finance-storage";
import { parseFinanceBackup } from "@/lib/finance-backup";
import { mergeFinanceStates, sameFinanceData, type FinanceMergeBaseline } from "@/lib/account-finance-merge";

// Booking facts use additive/protected merging, not a third full browser copy.
const baseStateSchema = appStateSchema.omit({ transactions: true, fixedReceipts: true, reviewQueue: true });
const cacheSchema = z.object({
  revision: z.number().int().nonnegative(),
  pending: z.boolean(),
  reconcileRequired: z.literal(true).optional(),
  baseState: baseStateSchema.nullable().optional(),
  state: appStateSchema,
});
type Cache = z.infer<typeof cacheSchema>;
export const accountStorageKey = (id: string) => `finanzblick.account.${id}.v1`;
export const accountConflictKey = (id: string) => `${accountStorageKey(id)}.conflict-backup`;
export const ACCOUNT_CONFLICT_EVENT = "finanzblick-account-conflict";

function parseCache(raw: string): Cache {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new FinanceStorageError("Die lokale Kontosicherung ist unlesbar und bleibt unverändert.");
  }
  const parsed = cacheSchema.safeParse(value);
  if (!parsed.success) throw new FinanceStorageError("Die lokale Kontosicherung ist ungültig und bleibt unverändert.");
  return parsed.data;
}

export function parseAccountCache(raw: string): Cache {
  return parseCache(raw);
}

export function parseAccountCacheState(raw: string): AppState {
  return parseAccountCache(raw).state;
}

export function parseAccountConflictBackup(raw: string, accountId: string): AppState {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new FinanceStorageError("Die Konfliktsicherung ist unlesbar und bleibt unverändert. Das Original kann trotzdem heruntergeladen werden.");
  }
  if (value && typeof value === "object" && "pending" in value && !("format" in value)) {
    const parsed = cacheSchema.strict().safeParse(value);
    if (!parsed.success) throw new FinanceStorageError("Die Konfliktsicherung ist ungültig und bleibt unverändert. Das Original kann trotzdem heruntergeladen werden.");
    return parsed.data.state;
  }
  return parseFinanceBackup(raw, accountId);
}

export function assertAccountConflictUnchanged(accountId: string, expectedRaw: string | null) {
  if (localStorage.getItem(accountConflictKey(accountId)) !== expectedRaw)
    throw new FinanceStorageError("Die Konfliktsicherung wurde zwischenzeitlich geändert. Bitte erneut prüfen; die neue Sicherung bleibt erhalten.");
}

export function discardAccountConflictBackup(accountId: string, expectedRaw: string | null) {
  assertAccountConflictUnchanged(accountId, expectedRaw);
  localStorage.removeItem(accountConflictKey(accountId));
  window.dispatchEvent(new Event(ACCOUNT_CONFLICT_EVENT));
}

function isQuotaError(error: unknown) {
  return error instanceof DOMException && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED");
}
function withoutBaseState(cache: Cache): Cache {
  // Drop only the baseline copy.
  const { baseState, ...rest } = cache;
  return rest;
}

export class AccountSessionError extends FinanceStorageError {}
export class AccountRevisionConflictError extends FinanceStorageError {}
export class AccountTransportError extends FinanceStorageError {}
export class AccountWorkingChangeError extends FinanceStorageError {}
export class AccountTabChangeError extends AccountWorkingChangeError {}
export function canAutomaticallyReconcile(error: unknown): boolean {
  return error instanceof AccountRevisionConflictError || error instanceof AccountTransportError ||
    error instanceof AccountWorkingChangeError || (error instanceof AccountReconciliationError && error.retryable);
}
export class AccountReconciliationError extends FinanceStorageError {
  constructor(readonly pendingState: AppState, message: string, readonly retryable = false) { super(message); }
}

export class AccountFinanceStorage {
  private cache: Cache | undefined;
  private busy = false;
  private paused = false;
  private disposed = false;
  private loaded = false;
  private loading: Promise<AppState | null> | undefined;
  private baseline: string | null | undefined;
  private confirmed: { revision: number; state: FinanceMergeBaseline | null } | undefined;
  private readonly key: string;
  private readonly headers: Record<string, string>;
  error: FinanceStorageError | null = null;

  get cachedState() { return this.cache?.state; }
  get revision() { return this.cache?.revision ?? 0; }
  get synchronizing() { return this.busy; }

  constructor(
    readonly userId: string,
    private readonly onSaved: (state: AppState) => void,
    private readonly onError: (error: FinanceStorageError) => void,
  ) {
    this.key = accountStorageKey(userId);
    this.headers = { "X-Finanzblick-Account": userId };
  }

  private readCache(): Cache | undefined {
    const raw = localStorage.getItem(this.key);
    this.baseline = raw;
    if (raw === null) return;
    return parseCache(raw);
  }

  private writeCache(cache: Cache) {
    const current = localStorage.getItem(this.key);
    if (this.baseline !== undefined && current !== this.baseline) {
      throw new AccountTabChangeError("Ein anderer Tab hat diesen Kontostand geändert. Beide Stände werden automatisch zusammengeführt.");
    }
    let compact = cache.baseState === undefined || cache.baseState === null
      ? cache : { ...cache, baseState: baseStateSchema.parse(cache.baseState) };
    let raw = JSON.stringify(compact);
    try {
      localStorage.setItem(this.key, raw);
    } catch (error) {
      if (!isQuotaError(error) || compact.baseState === undefined || compact.baseState === null) throw error;
      // Large ledgers cannot hold a second copy; the merge baseline stays in memory instead.
      compact = withoutBaseState(compact);
      raw = JSON.stringify(compact);
      localStorage.setItem(this.key, raw);
    }
    this.baseline = raw;
    this.cache = compact;
  }

  private async request(method: "GET" | "PUT", cache?: Cache) {
    let response: Response;
    try {
      response = await fetch("/api/finance", {
        method,
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.timeout(30_000),
        headers: { ...this.headers, ...(method === "PUT" ? { "Content-Type": "application/json" } : {}) },
        ...(cache ? { body: JSON.stringify({ state: cache.state, revision: cache.revision }) } : {}),
      });
    } catch (error) {
      if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError"))
        throw new AccountTransportError("Die Verbindung dauert länger. Änderungen bleiben auf diesem Gerät.");
      if (!(error instanceof TypeError)) throw error;
      throw new AccountTransportError("Server nicht erreichbar. Änderungen bleiben auf diesem Gerät.");
    }
    if (response.status === 401) throw new AccountSessionError("Die Anmeldung ist abgelaufen oder das Konto wurde gewechselt. Bitte erneut anmelden.");
    if (response.status === 409) throw new AccountRevisionConflictError("Auf einem anderen Gerät gibt es neuere Änderungen. Dein Stand bleibt erhalten. Bitte zuerst sichern und dann die Datenstände abgleichen.");
    if (response.status >= 500 || response.status === 429) throw new AccountTransportError("Der Server ist vorübergehend nicht erreichbar. Änderungen bleiben auf diesem Gerät.");
    if (!response.ok) throw new FinanceStorageError("Die Finanzdaten konnten nicht übertragen werden.");
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      if (error instanceof TypeError)
        throw new AccountTransportError("Die Serverantwort ist unlesbar. Dein gespeicherter Stand bleibt erhalten.");
      if (!(error instanceof SyntaxError)) throw error;
      throw new FinanceStorageError("Die Serverantwort ist unlesbar. Dein gespeicherter Stand bleibt erhalten.");
    }
    const result = financeSnapshotSchema.safeParse(value);
    if (!result.success) throw new FinanceStorageError("Die Serverantwort enthält ungültige Finanzdaten.");
    return result.data;
  }

  /** `initial` is the server-rendered snapshot; it replaces the first request, the merge rules stay the same. */
  load(initial?: z.infer<typeof financeSnapshotSchema>): Promise<AppState | null> {
    if (this.loading) return this.loading;
    const promise = this.loadInitial(initial);
    this.loading = promise;
    void promise.then(() => { this.loading = undefined; }, () => { this.loading = undefined; });
    return promise;
  }

  private async loadInitial(initial?: z.infer<typeof financeSnapshotSchema>): Promise<AppState | null> {
    if (this.busy) throw new FinanceStorageError("Die Synchronisierung läuft bereits.");
    this.busy = true;
    try {
      this.cache = undefined;
      let local = this.readCache();
      this.cache = local;
      this.confirmed = local?.baseState !== undefined
        ? { revision: local.revision, state: local.baseState } : undefined;
      let remote: z.infer<typeof financeSnapshotSchema>;
      try {
        remote = initial ?? await this.request("GET");
      } catch (error) {
        local = this.cache;
        if (!(error instanceof FinanceStorageError) || error instanceof AccountSessionError || !local) throw error;
        this.error = error;
        this.loaded = true;
        this.paused = true;
        return local.state;
      }
      if (this.disposed) return this.cache?.state ?? null;
      local = this.cache;
      if (!local?.pending || local.revision === remote.revision)
        this.confirmed = { revision: remote.revision, state: remote.state };
      if (local?.pending && remote.state && JSON.stringify(local.state) === JSON.stringify(remote.state)) {
        this.writeCache({ ...remote, state: remote.state, pending: false });
        this.loaded = true;
        this.paused = false;
        this.error = null;
        this.confirmed = { revision: remote.revision, state: remote.state };
        return remote.state;
      }
      if (local?.pending && local.revision !== remote.revision) {
        this.cache = local;
        this.loaded = true;
        this.paused = true;
        this.error = new AccountRevisionConflictError("Neuere Serverdaten werden mit den Geräteänderungen abgeglichen.");
        return local.state;
      }
      if (local?.pending && local.reconcileRequired) {
        this.loaded = true;
        this.paused = true;
        this.error = new AccountRevisionConflictError("Der datenerhaltende Abgleich ist noch nicht abgeschlossen.");
        return local.state;
      }
      this.loaded = true;
      this.paused = false;
      this.error = null;
      if (local?.pending) {
        this.cache = local;
        return local.state;
      }
      if (remote.state) this.writeCache({ ...remote, state: remote.state, pending: false });
      else this.cache = undefined;
      return remote.state;
    } finally {
      this.busy = false;
    }
  }

  save(state: AppState): void {
    if (!this.loaded) throw new FinanceStorageError("Die Kontodaten müssen vor dem Speichern geladen werden.");
    if (this.cache && !this.cache.pending && JSON.stringify(state) === JSON.stringify(this.cache.state)) {
      if (!this.paused) this.onSaved(state);
      return;
    }
    const preserved = this.cache?.reconcileRequired ? mergeFinanceStates(state, this.cache.state,
      this.confirmed?.revision === this.cache.revision ? this.confirmed.state : undefined) : state;
    this.writeCache({ state: preserved, revision: this.cache?.revision ?? 0, pending: true,
      ...(this.confirmed ? { baseState: this.confirmed.state } : {}),
      ...(this.cache?.reconcileRequired ? { reconcileRequired: true } : {}) });
    if (!this.paused) void this.flush();
  }

  private async flush() {
    if (this.busy || this.disposed || this.paused) return;
    this.busy = true;
    try {
      while (this.cache?.pending && !this.disposed) {
        const sent = this.cache;
        const remote = await this.request("PUT", sent);
        if (!remote.state) throw new FinanceStorageError("Der Server hat die Speicherung nicht bestätigt.");
        if (this.disposed) return;
        const current = this.cache;
        const pending = !sameFinanceData(current.state, sent.state);
        this.writeCache({ state: pending ? current.state : remote.state, revision: remote.revision, pending,
          ...(pending ? { baseState: remote.state } : {}) });
        this.confirmed = { revision: remote.revision, state: remote.state };
        if (!pending) this.onSaved(current.state);
      }
    } catch (error) {
      if (this.disposed) return;
      this.paused = true;
      if (error instanceof DOMException) this.error = new FinanceStorageError("Browserspeicher voll oder gesperrt. Bitte deine Änderungen als Sicherung herunterladen.");
      else if (error instanceof FinanceStorageError) this.error = error;
      else {
        throw error;
      }
      this.onError(this.error);
    } finally {
      this.busy = false;
    }
  }

  async poll(): Promise<AppState | undefined> {
    if (!this.loaded || this.busy || this.paused || this.cache?.pending) return;
    this.busy = true;
    try {
      const remote = await this.request("GET");
      if (this.disposed || this.cache?.pending) return;
      if (remote.state && remote.revision !== this.cache?.revision) {
        this.writeCache({ ...remote, state: remote.state, pending: false });
        this.confirmed = { revision: remote.revision, state: remote.state };
        return remote.state;
      }
    } catch (error) {
      this.paused = true;
      throw error;
    } finally {
      this.busy = false;
      if (this.cache?.pending && !this.paused) void this.flush();
    }
  }

  async retry(state?: AppState): Promise<AppState | null> {
    if (this.busy) throw new FinanceStorageError("Die Synchronisierung läuft bereits.");
    if (this.loaded && state) {
      this.paused = true;
      this.save(state);
    }
    return this.load();
  }

  /** Returns a conflict backup that keeps everything of the older one, or undefined if none is safe. */
  private supersedingConflictBackup(conflictRaw: string, selected: Cache | undefined): string | undefined {
    if (!selected) return;
    try {
      const older = parseAccountConflictBackup(conflictRaw, this.userId);
      // A reconciled device stand already contains the older backup's data.
      const state = selected.reconcileRequired ? selected.state : mergeFinanceStates(selected.state, older);
      return JSON.stringify({ ...withoutBaseState(selected), state });
    } catch (error) {
      if (error instanceof FinanceStorageError) return;
      throw error;
    }
  }

  /** Drops the backup this reconciliation wrote, but only once the confirmed server state holds every one of its values. */
  private releaseCoveredConflictBackup(confirmed: AppState, createdRaw: string | undefined) {
    const conflictKey = accountConflictKey(this.userId);
    const raw = localStorage.getItem(conflictKey);
    if (raw === null || raw !== createdRaw) return;
    try {
      const older = parseAccountConflictBackup(raw, this.userId);
      // The backup goes first so its own choices and notes would surface as a difference.
      if (!sameFinanceData(mergeFinanceStates(older, confirmed), confirmed)) return;
    } catch {
      return;
    }
    localStorage.removeItem(conflictKey);
    window.dispatchEvent(new Event(ACCOUNT_CONFLICT_EVENT));
  }

  async useServer(): Promise<AppState | null> {
    if (this.busy) throw new FinanceStorageError("Bitte warten, bis die laufende Synchronisierung beendet ist.");
    const selected = this.cache;
    const selectedRaw = localStorage.getItem(this.key);
    if (this.baseline !== undefined && selectedRaw !== this.baseline)
      throw new FinanceStorageError("Ein anderer Tab hat diesen Kontostand geändert. Bitte deinen Stand sichern und die Seite neu laden, bevor du den Serverstand bestätigst.");
    const conflictKey = accountConflictKey(this.userId);
    const conflictRaw = localStorage.getItem(conflictKey);
    this.busy = true;
    try {
      const remote = await this.request("GET");
      if (this.disposed) throw new AccountSessionError("Das Konto wurde gewechselt. Der Gerätestand bleibt erhalten.");
      if (!sameFinanceData(selected, this.cache)) throw new FinanceStorageError("Während des Ladens wurden neue Änderungen vorgenommen. Dein Stand bleibt erhalten; bitte erneut sichern und bestätigen.");
      if (localStorage.getItem(this.key) !== selectedRaw)
        throw new FinanceStorageError("Ein anderer Tab hat diesen Kontostand während des Ladens geändert. Bitte erneut prüfen.");
      assertAccountConflictUnchanged(this.userId, conflictRaw);
      const recoveryRaw = selected?.pending || !selected ? selectedRaw : null;
      if (recoveryRaw !== null) {
        const replacement = conflictRaw === null || conflictRaw === recoveryRaw
          ? conflictRaw === null ? recoveryRaw : null
          : this.supersedingConflictBackup(conflictRaw, selected);
        if (replacement === undefined)
          throw new FinanceStorageError("Eine ältere Konfliktsicherung ist noch vorhanden. Bitte zuerst wiederherstellen oder sichern und ausdrücklich verwerfen; sie wird nicht überschrieben.");
        if (replacement !== null) {
          localStorage.setItem(conflictKey, replacement);
          window.dispatchEvent(new Event(ACCOUNT_CONFLICT_EVENT));
        }
      }
      this.baseline = selectedRaw;
      if (remote.state) this.writeCache({ ...remote, state: remote.state, pending: false });
      else {
        localStorage.removeItem(this.key);
        this.baseline = null;
        this.cache = undefined;
      }
      this.loaded = true;
      this.paused = false;
      this.error = null;
      this.confirmed = { revision: remote.revision, state: remote.state };
      return remote.state;
    } finally {
      this.busy = false;
    }
  }

  /** Takes over a stand another tab wrote meanwhile, keeping both tabs' edits. */
  private adoptOtherTab(state: AppState): AppState {
    const raw = localStorage.getItem(this.key);
    if (this.baseline === undefined || raw === this.baseline || raw === null) return state;
    const other = parseCache(raw);
    const base = this.confirmed?.revision === this.cache?.revision ? this.confirmed?.state : undefined;
    const combined = mergeFinanceStates(state, other.state, base);
    this.baseline = raw;
    this.cache = other;
    this.confirmed = !other.pending ? { revision: other.revision, state: other.state }
      : other.baseState !== undefined ? { revision: other.revision, state: other.baseState } : undefined;
    return combined;
  }

  async reconcileServer(state: AppState, isCurrent: () => boolean = () => true): Promise<AppState> {
    if (this.busy) throw new FinanceStorageError("Bitte warten, bis die laufende Synchronisierung beendet ist.");
    if (!this.loaded || !this.cache) throw new FinanceStorageError("Der Gerätestand konnte nicht gelesen werden. Bitte zuerst das Original sichern.");
    this.paused = true;
    state = this.adoptOtherTab(state);
    this.save(state);
    this.busy = true;
    let rebased = false;
    let createdBackup: string | undefined;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const selected: Cache = this.cache;
        const selectedRaw = localStorage.getItem(this.key);
        const remote = await this.request("GET");
        if (this.disposed) throw new AccountSessionError("Das Konto wurde gewechselt. Der Gerätestand bleibt erhalten.");
        if (!isCurrent()) throw new AccountWorkingChangeError("Neue Geräteänderungen werden beim nächsten Abgleich berücksichtigt.");
        if (!sameFinanceData(selected, this.cache) || selectedRaw !== localStorage.getItem(this.key) || selectedRaw !== this.baseline)
          throw new AccountWorkingChangeError("Der Gerätestand wurde aktualisiert. Die Änderungen bleiben erhalten.");
        const combined = remote.state ? mergeFinanceStates(selected.state, remote.state,
          this.confirmed?.revision === selected.revision ? this.confirmed.state : undefined) : selected.state;
        const conflictKey = accountConflictKey(this.userId);
        if (selectedRaw !== null && localStorage.getItem(conflictKey) === null) {
          createdBackup = selected.baseState === undefined || selected.baseState === null
            ? selectedRaw : JSON.stringify(withoutBaseState(selected));
          localStorage.setItem(conflictKey, createdBackup);
          window.dispatchEvent(new Event(ACCOUNT_CONFLICT_EVENT));
        }
        this.writeCache({ state: combined, revision: remote.revision, pending: true, reconcileRequired: true, baseState: remote.state });
        this.confirmed = { revision: remote.revision, state: remote.state };
        rebased = true;
        const sent: Cache = this.cache;
        let saved: z.infer<typeof financeSnapshotSchema>;
        try { saved = await this.request("PUT", sent); }
        catch (error) {
          if (!(error instanceof AccountRevisionConflictError) || attempt === 2) throw error;
          continue;
        }
        if (!saved.state) throw new FinanceStorageError("Der Server hat den gemeinsamen Datenstand nicht bestätigt. Die lokale Kopie bleibt erhalten.");
        if (this.disposed) throw new AccountSessionError("Das Konto wurde gewechselt. Die lokale Kopie bleibt erhalten.");
        if (!sameFinanceData(sent, this.cache) || localStorage.getItem(this.key) !== this.baseline)
          throw new AccountWorkingChangeError("Neue Geräteänderungen bleiben erhalten und werden erneut abgeglichen.");
        if (!isCurrent()) {
          this.writeCache({ state: saved.state, revision: saved.revision, pending: true, reconcileRequired: true, baseState: saved.state });
          this.confirmed = { revision: saved.revision, state: saved.state };
          throw new AccountWorkingChangeError("Neue Geräteänderungen bleiben erhalten und werden erneut abgeglichen.");
        }
        this.writeCache({ state: saved.state, revision: saved.revision, pending: false });
        this.paused = false;
        this.error = null;
        this.confirmed = { revision: saved.revision, state: saved.state };
        this.releaseCoveredConflictBackup(saved.state, createdBackup);
        return saved.state;
      }
      throw new FinanceStorageError("Der Serverstand ändert sich weiterhin. Beide Datenstände bleiben erhalten; bitte erneut abgleichen.");
    } catch (error) {
      if (rebased && this.cache && !(error instanceof AccountSessionError) &&
        (error instanceof FinanceStorageError || error instanceof DOMException))
        throw new AccountReconciliationError(this.cache.state, financeStorageMessage(error), canAutomaticallyReconcile(error));
      throw error;
    } finally {
      this.busy = false;
    }
  }

  dispose() {
    this.disposed = true;
  }

  activate() {
    this.disposed = false;
  }
}
