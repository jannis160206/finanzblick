import { describe, expect, it } from "vitest";
import { bankAccountTarget, parseBankSync, type BankSyncFile } from "@/lib/import/bank-sync";
import { matchPockets } from "./pocket-match";

const row = (pocket: string, date: string, amount: number, bankReference?: string) => ({ bank: "Revolut", pocket, date, amount, bankReference });
const turnover = (booking_date: string, amount: number) => ({ booking_date, amount });

describe("bank account pocket matching", () => {
  const existing = [
    row("Lebensmittel", "2026-11-05", -22.68), row("Lebensmittel", "2026-11-06", -10), row("Lebensmittel", "2026-11-01", -5.5),
    row("Sparen", "2026-11-06", 1), row("Sparen", "2026-11-04", 250), row("Sparen", "2026-11-02", -10),
    row("Mittagessen", "2026-11-06", -10),
    row("Lebensmittel", "2026-11-03", -99, "xs2a:abc"),
  ];

  it("assigns each account the CSV pocket whose bookings match by amount and date", () => {
    const result = matchPockets([
      { id: "groceries", bank: "Revolut", turnovers: [turnover("2026-11-06", -22.68), turnover("2026-11-06", -10), turnover("2026-11-02", -5.5)] },
      { id: "savings", bank: "Revolut", turnovers: [turnover("2026-11-06", 1), turnover("2026-11-04", 250), turnover("2026-11-02", -10)] },
      { id: "empty", bank: "Revolut", turnovers: [] },
      { id: "unknown", bank: "Revolut", turnovers: [turnover("2026-11-06", -777), turnover("2026-11-03", -99)] },
    ], existing);
    expect(result.get("groceries")).toEqual({ pocket: "Lebensmittel", hits: 3, total: 3 });
    expect(result.get("savings")).toEqual({ pocket: "Sparen", hits: 3, total: 3 });
    expect(result.has("empty")).toBe(false);
    expect(result.has("unknown")).toBe(false);
  });

  it("never gives one pocket to two accounts and ignores other banks", () => {
    const turnovers = [turnover("2026-11-05", -22.68), turnover("2026-11-06", -10)];
    const result = matchPockets([
      { id: "a", bank: "Revolut", turnovers },
      { id: "b", bank: "Revolut", turnovers: turnovers.slice(0, 2) },
      { id: "c", bank: "Raiffeisen", turnovers },
    ], existing);
    expect([...result.values()].filter((match) => match.pocket === "Lebensmittel")).toHaveLength(1);
    expect(result.has("c")).toBe(false);
  });

  it("books synced rows into the assigned pocket", () => {
    expect(bankAccountTarget({ bankName: "Revolut", bic: null, description: "Jannis Brühl", iban: null, pocket: "Sparen" })).toEqual({ bank: "Revolut", pocket: "Sparen" });
    const file: BankSyncFile = {
      format: "finanzblick-bank-sync", version: 1, provider: "enablebanking", fetchedAt: "2026-11-07T00:00:00Z",
      accounts: [{ id: "v1", bankName: "Revolut", description: "Jannis Brühl", type: "SVGS", pocket: "Urlaub 2026",
        turnovers: [{ booking_date: "2026-11-07", amount: -12.5, purpose: ["Bar"], transaction_id: "t1" }] }],
    };
    const parsed = parseBankSync(new TextEncoder().encode(JSON.stringify(file)), "x.bank.json");
    expect(parsed.rows[0]).toMatchObject({ bank: "Revolut", pocket: "Urlaub 2026", amount: -12.5 });
  });
});
