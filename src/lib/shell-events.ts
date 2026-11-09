export const OPEN_IMPORT_EVENT = "finanzblick:open-import";

export function openImportDialog() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OPEN_IMPORT_EVENT));
}
