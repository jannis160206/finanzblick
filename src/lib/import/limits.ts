export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_STATEMENT_ROWS = 100_000;

export function assertImportSize(size: number): void {
  if (size > MAX_IMPORT_BYTES)
    throw new Error("Die Datei darf höchstens 20 MB groß sein.");
}
