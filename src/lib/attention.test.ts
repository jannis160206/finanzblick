import { describe, expect, it } from "vitest";
import { attentionItems, type AttentionInput } from "./attention";

const now = Date.parse("2026-11-08T12:00:00Z");
const connection = (id: string, bankName: string, extra: Partial<NonNullable<AttentionInput["bank"]>["connections"][number]> = {}) => ({
  id, bankName, bic: null, syncActive: true, message: null, consentValidUntil: "2027-05-06T00:00:00Z", lastSynced: null, testmode: null, country: "AT", ...extra,
});
const account = (bank: string, connectionId: string, syncError: string | null = null) => ({
  id: `${bank}-acc`, connectionId, bank, pocket: null, label: bank, iban: null, balance: 1, available: null, balanceDate: null,
  syncedAt: null, fetchedRows: null, balanceOk: null, syncError,
});
const base: AttentionInput = { now, today: "2026-11-08", openReviews: 0, lastBackup: "2026-11-01" };

describe("attention items", () => {
  it("is empty when everything is fine", () => {
    expect(attentionItems({ ...base, bank: { connections: [connection("r", "Raiffeisen")], accounts: [account("Raiffeisen", "r")], lastSync: now - 3_600_000, lastError: null } }))
      .toEqual([]);
  });

  it("puts expired bank access first and links to the bank settings", () => {
    const items = attentionItems({ ...base, openReviews: 3, bank: {
      connections: [connection("t", "Trade Republic", { syncActive: false, message: "Freigabe abgelaufen" }), connection("r", "Raiffeisen")],
      accounts: [account("Trade Republic", "t", "Freigabe abgelaufen"), account("Raiffeisen", "r")], lastSync: now - 3_600_000, lastError: null } });
    expect(items.map((item) => item.id)).toEqual(["bank-expired-t", "reviews"]);
    expect(items[0]).toMatchObject({ tone: "bad", title: "Trade Republic: Freigabe abgelaufen", href: "/einstellungen#bankverbindung" });
    expect(items[1]).toMatchObject({ title: "3 Buchungen prüfen", href: "/umsaetze?pruefen=1" });
  });

  it("warns before access expires and when fetching is stuck", () => {
    const items = attentionItems({ ...base, bank: {
      connections: [connection("p", "PayPal", { consentValidUntil: "2026-11-15T12:00:00Z" })], accounts: [], lastSync: now - 3 * 86_400_000, lastError: null } });
    expect(items.map((item) => item.title)).toEqual(["PayPal: Freigabe endet in 7 Tagen", "Bankabruf hängt"]);
    expect(items[1].detail).toContain("vor 3 Tagen");
  });

  it("names connections without shared accounts and single failing accounts", () => {
    const items = attentionItems({ ...base, bank: {
      connections: [connection("t", "Trade Republic", { message: "Keine Konten freigegeben." }), connection("r", "Revolut")],
      accounts: [account("Revolut", "r", "Konto gesperrt")], lastSync: now, lastError: null } });
    expect(items.map((item) => item.title)).toEqual(["Trade Republic: Abruf unvollständig", "1 Konto nicht abgerufen"]);
  });

  it("ignores daily bank limits that clear up on their own", () => {
    expect(attentionItems({ ...base, bank: {
      connections: [connection("r", "Raiffeisen", { message: "Tageslimit der Bank erreicht (PSD2 erlaubt nur wenige automatische Abrufe pro Tag)." })],
      accounts: [account("Raiffeisen", "r", "Tageslimit der Bank erreicht")], lastSync: now, lastError: null } })).toEqual([]);
  });

  it("reminds of Amex top-up, data sync and old backups", () => {
    const items = attentionItems({ ...base, amexToTransfer: 415.83, lastBackup: "2026-09-01", syncNeedsAttention: true });
    expect(items.map((item) => item.id)).toEqual(["cloud-sync", "amex", "backup"]);
    expect(items[2].title).toBe("Excel-Backup ist 68 Tage alt");
    expect(attentionItems({ ...base, lastBackup: null })[0].title).toBe("Noch kein Excel-Backup");
  });
});
