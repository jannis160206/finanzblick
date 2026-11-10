"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useAccountWorkspace } from "@/components/account-context";
import { useFinance } from "@/components/finance-provider";
import { usePayslipUpload, type PayslipBatchResult } from "@/components/payslip-upload";
import { useSecurityMode } from "@/components/security-mode-provider";
import { accountRequest } from "@/lib/account-request";
import { navigate } from "@/lib/browser-navigation";
import type { DriveInboxItem } from "@/lib/drive/inbox";

export const DRIVE_INBOX_EVENT = "finanzblick:drive-inbox";
const POLL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 24;
const MAX_ROUNDS = 10;
/** The statement worker imports new payslips within minutes; older ones mean it is not running. */
const WORKER_GRACE_MS = 20 * 60 * 1000;

/** Asks the app to read new Drive payslips now, e.g. right after "Jetzt prüfen". */
export function requestDriveInbox() {
  window.dispatchEvent(new Event(DRIVE_INBOX_EVENT));
}

const pdfName = (name: string) => (/\.pdf$/i.test(name) ? name : `${name}.pdf`);
const EXPIRED_NOTICE_KEY = "finanzblick.drive-expired-notice";

/** Once per browser session: Google ended the approval, so nothing new arrives until the user reconnects. */
function noticeExpired() {
  try {
    if (sessionStorage.getItem(EXPIRED_NOTICE_KEY)) return;
    sessionStorage.setItem(EXPIRED_NOTICE_KEY, "1");
  } catch {
    // Without session storage the notice may repeat; that is acceptable.
  }
  toast.warning("Google-Drive-Freigabe abgelaufen", {
    description: "Neue Abrechnungen werden erst nach erneutem Verbinden gelesen.",
    action: { label: "Verbinden", onClick: () => navigate("/einstellungen?bereich=verbindungen#google-drive") },
  });
}

/** Items the browser should read now: those that need the user, those the worker left behind, or all on request. */
export function browserInboxItems(items: DriveInboxItem[], everything: boolean, now = Date.now()) {
  return everything ? items : items.filter((item) => item.waiting || now - item.addedAt > WORKER_GRACE_MS);
}

/**
 * Payslips from the Drive folder "Abrechnungen" are imported in the background by the statement worker. The app reads
 * the ones that need the user (no stored password fits, stored values would be replaced) with the regular payslip
 * import – password dialog, replacement confirmation – and reports each result back to the server.
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

    async function round(everything: boolean): Promise<boolean> {
      const listed = await accountRequest<{ items: DriveInboxItem[]; expired?: boolean }>("/api/drive/inbox", user);
      if (listed.expired) noticeExpired();
      const items = browserInboxItems(listed.items, everything);
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

    async function run(everything = false) {
      if (running || cancelled || document.visibilityState === "hidden") return;
      running = true;
      try {
        let rounds = 0;
        while (rounds++ < MAX_ROUNDS && !cancelled && await round(everything)) { /* more items are waiting */ }
      } catch {
        // Status and errors are shown in the settings; the next poll tries again.
      } finally {
        running = false;
      }
    }

    void run();
    const timer = window.setInterval(() => { void run(); }, POLL_MS);
    const wake = () => { void run(true); };
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
