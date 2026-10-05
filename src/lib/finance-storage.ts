import { appStateSchema, type AppState } from "./types";

export const FINANCE_STORAGE_KEY = "finanzdashboard.v1";
export const FINANCE_BACKUP_KEY = `${FINANCE_STORAGE_KEY}.backup`;
export const FINANCE_RECOVERY_KEY = `${FINANCE_STORAGE_KEY}.unreadable`;

export class FinanceStorageError extends Error {}

function decode(raw: string | null): AppState | undefined {
  if (raw === null) return;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return;
  }
  const parsed = appStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function financeStorageMessage(error: unknown): string {
  if (error instanceof FinanceStorageError) return error.message;
  if (error instanceof DOMException) {
    return "Browserspeicher voll oder gesperrt. Änderungen sind nicht vollständig gesichert. Bitte eine Excel-Sicherung herunterladen.";
  }
  throw error;
}

export class FinanceStorage {
  private baseline: string | null | undefined;
  private unreadable: string | null = null;

  load(fallback: AppState): { data: AppState; recovered: boolean } {
    const raw = localStorage.getItem(FINANCE_STORAGE_KEY);
    const data = decode(raw);
    this.baseline = raw;
    this.unreadable = raw !== null && !data ? raw : null;
    if (data) return { data, recovered: false };

    const backup = localStorage.getItem(FINANCE_BACKUP_KEY);
    const recovered = decode(backup);
    if (recovered) return { data: recovered, recovered: true };
    if (raw !== null || backup !== null) {
      throw new FinanceStorageError(
        "Lokale Daten sind nicht lesbar und bleiben unverändert. Bitte eine Excel-Sicherung wiederherstellen.",
      );
    }
    return { data: fallback, recovered: false };
  }

  changedElsewhere(): boolean {
    return localStorage.getItem(FINANCE_STORAGE_KEY) !== this.baseline;
  }

  prepareReplacement(): void {
    const raw = localStorage.getItem(FINANCE_STORAGE_KEY);
    this.baseline = raw;
    this.unreadable = raw !== null && !decode(raw) ? raw : null;
  }

  save(data: AppState): void {
    if (this.baseline === undefined) {
      throw new FinanceStorageError("Lokale Daten müssen vor dem Speichern geladen werden.");
    }
    const raw = JSON.stringify(data);
    const current = localStorage.getItem(FINANCE_STORAGE_KEY);
    if (current !== this.baseline && current !== raw) {
      throw new FinanceStorageError(
        "Ein anderer Tab hat die gespeicherten Daten geändert. Dieser Stand bleibt erhalten. Bitte Änderungen als Excel sichern und neu laden.",
      );
    }
    // Keep unparseable originals intact when recovering or explicitly importing a backup.
    if (this.unreadable !== null) {
      const preserved = localStorage.getItem(FINANCE_RECOVERY_KEY);
      if (preserved !== null && preserved !== this.unreadable) {
        throw new FinanceStorageError("Eine ältere unlesbare Sicherung ist noch vorhanden. Originaldaten werden nicht überschrieben.");
      }
      localStorage.setItem(FINANCE_RECOVERY_KEY, this.unreadable);
    }
    if (current !== raw) localStorage.setItem(FINANCE_STORAGE_KEY, raw);
    this.baseline = raw;
    this.unreadable = null;
    // A separate copy survives a missing or damaged primary entry. Report either write failure.
    if (localStorage.getItem(FINANCE_BACKUP_KEY) !== raw) {
      localStorage.setItem(FINANCE_BACKUP_KEY, raw);
    }
  }
}
