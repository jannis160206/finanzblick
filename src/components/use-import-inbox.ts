"use client";

import { useEffect, useRef } from "react";
import { IMPORT_INBOX_EVENT, takeImport, type ImportKind } from "@/lib/import-inbox";

// Reads files handed over by the central import dialog once this importer is mounted and ready.
export function useImportInbox(kind: ImportKind, ready: boolean, handle: (files: File[]) => void) {
  const latest = useRef(handle);
  useEffect(() => { latest.current = handle; });
  useEffect(() => {
    if (!ready) return;
    const consume = () => {
      const files = takeImport(kind);
      if (files.length) latest.current(files);
    };
    consume();
    const listener = (event: Event) => { if ((event as CustomEvent<ImportKind>).detail === kind) consume(); };
    window.addEventListener(IMPORT_INBOX_EVENT, listener);
    return () => window.removeEventListener(IMPORT_INBOX_EVENT, listener);
  }, [kind, ready]);
}
