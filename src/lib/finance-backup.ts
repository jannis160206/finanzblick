import { z } from "zod";
import { appStateSchema, type AppState } from "@/lib/types";
import { FinanceStorageError } from "@/lib/finance-storage";
import { MAX_IMPORT_BYTES } from "@/lib/import/limits";

const backupSchema = z.object({
  format: z.literal("finanzblick-backup"),
  version: z.literal(1),
  createdAt: z.string().datetime(),
  accountId: z.string().min(1).max(100).nullable(),
  state: appStateSchema,
}).strict();

export function serializeFinanceBackup(state: AppState, accountId: string | null = null): string {
  const parsed = backupSchema.safeParse({
    format: "finanzblick-backup", version: 1,
    createdAt: new Date().toISOString(), accountId, state,
  });
  if (!parsed.success) throw new FinanceStorageError(
    `Die Sicherung konnte nicht erstellt werden: ${parsed.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`,
  );
  const raw = JSON.stringify(parsed.data, null, 2);
  if (new TextEncoder().encode(raw).byteLength > MAX_IMPORT_BYTES)
    throw new FinanceStorageError("Die JSON-Sicherung überschreitet 20 MB und wurde nicht als wiederherstellbare Datei ausgegeben.");
  return raw;
}

export function parseFinanceBackup(raw: string, accountId: string | null = null): AppState {
  if (new TextEncoder().encode(raw).byteLength > MAX_IMPORT_BYTES)
    throw new FinanceStorageError("Die Sicherung darf höchstens 20 MB groß sein.");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new FinanceStorageError("Die JSON-Sicherung ist unlesbar. Vorhandene Daten bleiben unverändert.");
  }
  if (typeof value === "object" && value !== null && "format" in value) {
    const parsed = backupSchema.safeParse(value);
    if (!parsed.success) throw new FinanceStorageError("Die Sicherung ist ungültig oder ihre Version wird nicht unterstützt.");
    if (parsed.data.accountId !== accountId)
      throw new FinanceStorageError("Diese Sicherung gehört zu einem anderen Konto oder Browsermodus. Bitte im ursprünglichen Arbeitsbereich wiederherstellen.");
    return parsed.data.state;
  }
  // Previously downloaded conflict files contain an unwrapped version-1 AppState.
  const parsed = appStateSchema.safeParse(value);
  if (!parsed.success) throw new FinanceStorageError(
    `Ungültige JSON-Sicherung: ${parsed.error.issues.slice(0, 3).map((issue) => issue.message).join("; ")}`,
  );
  return parsed.data;
}

export function downloadFinanceBackup(state: AppState, name: string, accountId: string | null = null): void {
  const raw = serializeFinanceBackup(state, accountId);
  const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
