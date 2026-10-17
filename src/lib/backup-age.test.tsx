// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupAge } from "@/components/backup-age";
import { BACKUP_STALE_AFTER_DAYS, backupAgeText, backupStatus, readLastBackup, recordBackup } from "@/lib/backup-age";

vi.mock("@/components/account-context", () => ({ useAccountWorkspace: () => null }));
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("backupStatus", () => {
  it("treats a missing or malformed date as 'no backup yet'", () => {
    expect(backupStatus(null, "2026-10-12")).toEqual({ kind: "none" });
    expect(backupStatus("gestern", "2026-10-12")).toEqual({ kind: "none" });
  });
  it("counts whole calendar days, also across month and year ends", () => {
    expect(backupStatus("2026-10-12", "2026-10-12")).toEqual({ kind: "recent", days: 0 });
    expect(backupStatus("2026-09-30", "2026-10-02")).toEqual({ kind: "recent", days: 2 });
    expect(backupStatus("2025-12-31", "2026-01-02")).toEqual({ kind: "recent", days: 2 });
  });
  it("only becomes stale at the threshold", () => {
    expect(backupStatus("2026-09-13", "2026-10-12").kind).toBe("recent");
    expect(backupStatus("2026-09-12", "2026-10-12")).toEqual({ kind: "stale", days: BACKUP_STALE_AFTER_DAYS });
  });
  it("never reports negative ages for dates in the future", () => {
    expect(backupStatus("2026-10-20", "2026-10-12")).toEqual({ kind: "recent", days: 0 });
  });
  it("words the age", () => {
    expect([0, 1, 5].map(backupAgeText)).toEqual(["heute", "gestern", "vor 5 Tagen"]);
  });
});

describe("local storage", () => {
  it("stores the date per scope and only locally", () => {
    expect(recordBackup("a", "2026-10-01")).toBe(true);
    expect(readLastBackup("a")).toBe("2026-10-01");
    expect(readLastBackup("b")).toBeNull();
  });
  it("reports a refused write instead of throwing", () => {
    const refusing = { setItem: () => { throw new DOMException("quota", "QuotaExceededError"); } };
    expect(recordBackup("a", "2026-10-01", refusing)).toBe(false);
  });
  it("ignores corrupted values", () => {
    localStorage.setItem("finanzdashboard.last-excel-backup.v1:local", "{evil}");
    expect(readLastBackup("local")).toBeNull();
  });
});

describe("BackupAge", () => {
  it("shows a friendly empty state, not a warning, before the first backup", () => {
    render(<BackupAge />);
    expect(screen.getByText(/Noch keine Excel-Sicherung/)).toBeTruthy();
    expect(screen.queryByText(/Zeit für/)).toBeNull();
  });
  it("shows the age after a backup and updates live", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 12, 12) });
    render(<BackupAge />);
    act(() => { recordBackup("local", "2026-10-09"); });
    expect(screen.getByText("Letztes Excel-Backup vor 3 Tagen")).toBeTruthy();
    expect(screen.queryByText(/Zeit für/)).toBeNull();
  });
  it("adds the hint only after the threshold", () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 12, 12) });
    recordBackup("local", "2026-08-01");
    render(<BackupAge />);
    expect(screen.getByText("Letztes Excel-Backup vor 72 Tagen")).toBeTruthy();
    expect(screen.getByText(/Zeit für eine frische Sicherung/)).toBeTruthy();
  });
});
