import { z } from "zod";
import { appStateSchema, type AppState } from "@/lib/types";
import { financeSnapshotSchema } from "@/lib/account-schema";
import { FinanceStorageError } from "@/lib/finance-storage";

const cacheSchema = z.object({
  revision: z.number().int().nonnegative(),
  pending: z.boolean(),
  state: appStateSchema,
});
type Cache = z.infer<typeof cacheSchema>;
export const accountStorageKey = (id: string) => `finanzblick.account.${id}.v1`;

export class AccountSessionError extends FinanceStorageError {}

export class AccountFinanceStorage {
  private cache: Cache | undefined;
  private busy = false;
  private paused = false;
  private disposed = false;
  private loaded = false;
  private loading: Promise<AppState | null> | undefined;
  private baseline: string | null | undefined;
  private readonly key: string;
  private readonly headers: Record<string, string>;
  error: FinanceStorageError | null = null;

  get cachedState() { return this.cache?.state; }

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
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new FinanceStorageError("Die lokale Kontosicherung ist unlesbar und bleibt unverändert.");
    }
    const parsed = cacheSchema.safeParse(value);
    if (!parsed.success) throw new FinanceStorageError("Die lokale Kontosicherung ist ungültig und bleibt unverändert.");
    return parsed.data;
  }

  private writeCache(cache: Cache) {
    const current = localStorage.getItem(this.key);
    if (this.baseline !== undefined && current !== this.baseline) {
      throw new FinanceStorageError("Ein anderer Tab hat diesen Kontostand geändert. Bitte deinen Stand sichern und den Serverstand laden.");
    }
    const raw = JSON.stringify(cache);
    localStorage.setItem(this.key, raw);
    this.baseline = raw;
    this.cache = cache;
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
        throw new FinanceStorageError("Die Synchronisierung hat zu lange gedauert. Änderungen bleiben auf diesem Gerät; bitte erneut versuchen.");
      if (!(error instanceof TypeError)) throw error;
      throw new FinanceStorageError("Server nicht erreichbar. Änderungen bleiben auf diesem Gerät; bitte erneut synchronisieren.");
    }
    if (response.status === 401) throw new AccountSessionError("Die Anmeldung ist abgelaufen oder das Konto wurde gewechselt. Bitte erneut anmelden.");
    if (response.status === 409) throw new FinanceStorageError("Auf einem anderen Gerät gibt es neuere Änderungen. Dein Stand bleibt erhalten. Bitte zuerst sichern und dann den Serverstand laden.");
    if (!response.ok) throw new FinanceStorageError("Der Server konnte die Finanzdaten nicht speichern oder laden. Bitte erneut versuchen.");
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
      throw new FinanceStorageError("Die Serverantwort ist unlesbar. Dein gespeicherter Stand bleibt erhalten.");
    }
    const result = financeSnapshotSchema.safeParse(value);
    if (!result.success) throw new FinanceStorageError("Die Serverantwort enthält ungültige Finanzdaten.");
    return result.data;
  }

  load(): Promise<AppState | null> {
    if (this.loading) return this.loading;
    const promise = this.loadInitial();
    this.loading = promise;
    void promise.then(() => { this.loading = undefined; }, () => { this.loading = undefined; });
    return promise;
  }

  private async loadInitial(): Promise<AppState | null> {
    if (this.busy) throw new FinanceStorageError("Die Synchronisierung läuft bereits.");
    this.busy = true;
    try {
      let local = this.readCache();
      this.cache = local;
      let remote: z.infer<typeof financeSnapshotSchema>;
      try {
        remote = await this.request("GET");
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
      if (local?.pending && remote.state && JSON.stringify(local.state) === JSON.stringify(remote.state)) {
        this.writeCache({ ...remote, state: remote.state, pending: false });
        this.loaded = true;
        this.paused = false;
        this.error = null;
        return remote.state;
      }
      if (local?.pending && local.revision !== remote.revision) {
        this.cache = local;
        this.loaded = true;
        this.paused = true;
        this.error = new FinanceStorageError("Neuere Daten sind auf dem Server vorhanden. Ungesicherte Änderungen bleiben auf diesem Gerät. Bitte zuerst sichern und den Serverstand laden.");
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
    this.writeCache({ state, revision: this.cache?.revision ?? 0, pending: true });
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
        const pending = current.state !== sent.state;
        this.writeCache({ state: pending ? current.state : remote.state, revision: remote.revision, pending });
        if (!pending) this.onSaved(sent.state);
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

  async useServer(): Promise<AppState | null> {
    if (this.busy) throw new FinanceStorageError("Bitte warten, bis die laufende Synchronisierung beendet ist.");
    const selected = this.cache;
    this.busy = true;
    try {
      const remote = await this.request("GET");
      if (selected !== this.cache) throw new FinanceStorageError("Während des Ladens wurden neue Änderungen vorgenommen. Dein Stand bleibt erhalten; bitte erneut sichern und bestätigen.");
      if (this.cache?.pending) localStorage.setItem(`${this.key}.conflict-backup`, JSON.stringify(this.cache));
      this.baseline = localStorage.getItem(this.key);
      if (remote.state) this.writeCache({ ...remote, state: remote.state, pending: false });
      else {
        localStorage.removeItem(this.key);
        this.baseline = null;
        this.cache = undefined;
      }
      this.loaded = true;
      this.paused = false;
      this.error = null;
      return remote.state;
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
