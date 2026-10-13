import { describe, expect, it } from "vitest";
import { appStateSchema } from "@/lib/types";
import { createEmptyAccountState } from "@/lib/account-state";
import { parseFinanceBackup, serializeFinanceBackup } from "./finance-backup";

describe("validated finance JSON backups", () => {
  it("round-trips every supported field and reads existing raw account downloads", () => {
    const state = createEmptyAccountState();
    state.merchantNameRules = [{ key: "synthetic", merchantAlias: "Testhändler" }];
    state.financeRows = [{ id: "salary", label: "Gehalt", kind: "income", values: { "2026-10": 3000 } }];
    expect(parseFinanceBackup(serializeFinanceBackup(state, "alice"), "alice")).toEqual(appStateSchema.parse(state));
    expect(parseFinanceBackup(JSON.stringify(state), "alice")).toEqual(appStateSchema.parse(state));
  });

  it("never silently moves an identified backup between accounts and browser mode", () => {
    const state = createEmptyAccountState();
    const backup = serializeFinanceBackup(state, "alice");
    expect(() => parseFinanceBackup(backup, "bob")).toThrow("anderen Konto");
    expect(() => parseFinanceBackup(backup)).toThrow("anderen Konto");
    expect(() => parseFinanceBackup(serializeFinanceBackup(state), "alice")).toThrow("anderen Konto");
  });

  it("rejects malformed, incompatible and duplicate-ID data without changing its source", () => {
    const state = createEmptyAccountState();
    state.financeRows = [
      { id: "same", label: "Einkommen A", kind: "income", values: { "2026-10": 1000 } },
      { id: "same", label: "Einkommen B", kind: "income", values: { "2026-10": 2000 } },
    ];
    const original = JSON.stringify(state);
    expect(() => parseFinanceBackup(original)).toThrow("Doppelte Finanzzeilen-ID");
    expect(JSON.stringify(state)).toBe(original);
    expect(() => serializeFinanceBackup(state)).toThrow();
    expect(() => parseFinanceBackup("{")).toThrow("unlesbar");
    expect(() => parseFinanceBackup('{"format":"finanzblick-backup","version":2}')).toThrow("Version");
  });

  it("rejects repeated transaction IDs at the shared boundary", () => {
    const state = createEmptyAccountState();
    const booking = { id: "same", date: "2026-10-01", bank: "Testbank", pocket: null,
      description: "Test", amount: -10, category: "Shopping" as const, includeInPlan: true };
    state.transactions = [booking, { ...booking, amount: -20 }];
    expect(appStateSchema.safeParse(state).success).toBe(false);
    expect(() => parseFinanceBackup(JSON.stringify(state))).toThrow("Doppelte Umsatz-ID");
  });

  it("does not issue a JSON download exceeding the restoration size limit", () => {
    const state = createEmptyAccountState();
    state.merchantNameRules = Array.from({ length: 100_000 }, (_, index) => ({
      key: `synthetic-${index}`, merchantAlias: "x".repeat(200),
    }));
    expect(() => serializeFinanceBackup(state)).toThrow("20 MB");
    expect(() => parseFinanceBackup(" ".repeat(20 * 1024 * 1024 + 1))).toThrow("20 MB");
  });
});
