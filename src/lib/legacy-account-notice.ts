import { accountStorageKey } from "./account-finance-storage";
import { FINANCE_BACKUP_KEY, FINANCE_STORAGE_KEY } from "./finance-storage";

export const legacyNoticeKey = (id: string) => `${accountStorageKey(id)}.legacy-notice`;
const noticeEvent = "finanzblick:legacy-notice";
export type LegacyNoticeStatus = "available" | "missing" | "handled" | "unavailable" | "unsaved";

export function subscribeLegacyNotice(listener: () => void) {
  window.addEventListener("storage", listener);
  window.addEventListener(noticeEvent, listener);
  return () => {
    window.removeEventListener("storage", listener);
    window.removeEventListener(noticeEvent, listener);
  };
}

export class LegacyAccountNotice {
  private shown = false;
  private unsaved = false;

  constructor(private readonly accountId: string | null, private readonly manual: boolean) {}

  getSnapshot = (): LegacyNoticeStatus => {
    if (!this.accountId) return "missing";
    try {
      const marker = localStorage.getItem(legacyNoticeKey(this.accountId));
      if (!this.manual && (marker === "handled" || (marker === "seen" && !this.shown))) return "handled";
      if (localStorage.getItem(FINANCE_STORAGE_KEY) === null && localStorage.getItem(FINANCE_BACKUP_KEY) === null) return "missing";
      return this.unsaved ? "unsaved" : "available";
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      return "unavailable";
    }
  };

  markShown() {
    if (!this.accountId || this.manual || this.shown) return;
    try {
      const marker = localStorage.getItem(legacyNoticeKey(this.accountId));
      if (marker !== "seen" && marker !== "handled") {
        // Keep this visit's controls usable; only later mounts suppress the notice.
        this.shown = true;
        localStorage.setItem(legacyNoticeKey(this.accountId), "seen");
      }
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      this.unsaved = true;
    }
    window.dispatchEvent(new Event(noticeEvent));
  }

  markHandled() {
    if (!this.accountId) throw new Error("Legacy migration requires an administrator account.");
    localStorage.setItem(legacyNoticeKey(this.accountId), "handled");
    this.unsaved = false;
    window.dispatchEvent(new Event(noticeEvent));
  }
}
