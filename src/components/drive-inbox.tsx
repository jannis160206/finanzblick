"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAccountWorkspace } from "@/components/account-context";
import { useFinance } from "@/components/finance-provider";
import { usePayslipUpload, type PayslipBatchResult } from "@/components/payslip-upload";
import { useSecurityMode } from "@/components/security-mode-provider";
import { accountRequest } from "@/lib/account-request";
import type { DriveInboxItem } from "@/lib/drive/inbox";

export const DRIVE_INBOX_EVENT = "finanzblick:drive-inbox";
const POLL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 24;
const MAX_ROUNDS = 10;

/** Asks the app to read new Drive payslips now, e.g. right after "Jetzt prüfen". */
export function requestDriveInbox() {
  window.dispatchEvent(new Event(DRIVE_INBOX_EVENT));
}

const pdfName = (name: string) => (/\.pdf$/i.test(name) ? name : `${name}.pdf`);

/**
 * Reads payslips that the server fetched from the Drive folder "Abrechnungen" with the regular payslip import
 * (stored password first, password dialog only when needed) and reports each result back to the server.
 */
export function DriveInbox() {
  const workspace = useAccountWorkspace();
  const account = workspace?.user.id ?? null;
  const { ready, storageError } = useFinance();
  const security = useSecurityMode();
  const { readFiles } = usePayslipUpload();
  const read = useRef(readFiles);
  useEffect(() => { read.current = readFiles; });
  const active = !!account && ready && !storageError && !security.locked;

  useEffect(() => {
    if (!active || !account) return;
    const user = account;
    let cancelled = false;
    let running = false;
    const report = (id: string, outcome: "imported" | "skipped" | "failed", note?: string) =>
      accountRequest(`/api/drive/inbox/${encodeURIComponent(id)}`, user, { method: "POST", json: { outcome, ...(note ? { note } : {}) } }).catch(() => null);

    async function round(): Promise<boolean> {
      const { items } = await accountRequest<{ items: DriveInboxItem[] }>("/api/drive/inbox", user);
      const batch = items.slice(0, BATCH_SIZE);
      if (!batch.length || cancelled) return false;
      const files: File[] = [];
      const ids: string[] = [];
      for (const item of batch) {
        const response = await fetch(`/api/drive/inbox/${encodeURIComponent(item.id)}`, {
          credentials: "same-origin", cache: "no-store", headers: { "X-Finanzblick-Account": user },
        });
        if (cancelled) return false;
        if (response.status === 404) { await report(item.id, "failed", "Datei nicht mehr vorhanden."); continue; }
        if (!response.ok) return false;
        files.push(new File([await response.blob()], pdfName(item.name), { type: "application/pdf" }));
        ids.push(item.id);
      }
      if (!files.length) return items.length > batch.length;
      const result = await new Promise<PayslipBatchResult>((resolve) =>
        read.current(files, { source: "Google Drive", background: true, onSettled: resolve }));
      if (result.busy) return false;
      await Promise.all(result.files.map((file, index) => report(ids[index], file.outcome, file.note)));
      const failed = result.files.filter((file) => file.outcome === "failed").length;
      if (failed) toast.error(`Google Drive: ${failed} Abrechnung(en) nicht übernommen`, { description: result.message });
      return items.length > batch.length;
    }

    async function run() {
      if (running || cancelled || document.visibilityState === "hidden") return;
      running = true;
      try {
        let rounds = 0;
        while (rounds++ < MAX_ROUNDS && !cancelled && await round()) { /* more items are waiting */ }
      } catch {
        // Status and errors are shown in the settings; the next poll tries again.
      } finally {
        running = false;
      }
    }

    void run();
    const timer = window.setInterval(() => { void run(); }, POLL_MS);
    const wake = () => { void run(); };
    const visible = () => { if (document.visibilityState === "visible") void run(); };
    window.addEventListener(DRIVE_INBOX_EVENT, wake);
    document.addEventListener("visibilitychange", visible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(DRIVE_INBOX_EVENT, wake);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, account]);

  return null;
}
