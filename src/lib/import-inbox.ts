export type ImportKind = "statement" | "payslip";

export const IMPORT_INBOX_EVENT = "finanzblick:import-inbox";
const inbox = new Map<ImportKind, File[]>();

// Hands files from the central import dialog to the page that knows how to read them.
export function deliverImport(kind: ImportKind, files: readonly File[]) {
  if (!files.length) return;
  inbox.set(kind, [...(inbox.get(kind) ?? []), ...files]);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<ImportKind>(IMPORT_INBOX_EVENT, { detail: kind }));
}

export function takeImport(kind: ImportKind): File[] {
  const files = inbox.get(kind) ?? [];
  inbox.delete(kind);
  return files;
}

export function pendingImport(kind: ImportKind) {
  return inbox.get(kind)?.length ?? 0;
}

const payslipName = /(lohn|gehalt|entgelt|abrechnung|bezüge|bezuege|payslip|verdienst)/i;
const statementName = /(amex|american|kontoauszug|umsatz|umsätze|statement|activity|paypal|trade.?republic|depot)/i;

// Decides by file type first; for ambiguous PDFs the caller can probe the content.
export function guessImportKind(file: Pick<File, "name" | "type">): ImportKind | "pdf" {
  const name = file.name.toLowerCase();
  if (!/\.pdf$/.test(name) && file.type !== "application/pdf") return "statement";
  if (statementName.test(name)) return "statement";
  if (payslipName.test(name)) return "payslip";
  return "pdf";
}
