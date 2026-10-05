import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { amexBookingKey } from "./identity";
import { needsAmexBalanceRecovery, recoverAmexBalance, type AmexBalanceRecovery } from "./amex-balance-recovery";

function fixture() {
  const seed = createSeed();
  return {
    ...seed, settings: { ...seed.settings, asOf: "2026-10-05" },
    transactions: ["Laden A", "Laden B"].map((description, index) => ({
      id: `screenshot-${index}`, date: "2026-10-02", bank: "Amex", pocket: "Amex",
      description, amount: -100, rawDetails: ["Amex-Screenshot"],
      category: "Shopping" as const, includeInPlan: false, manualCategory: true,
      merchantAlias: `Mein Einkauf ${index}`, sharedWithRaphael: true,
    })),
  };
}
const snapshot = { periodStart: "2026-09-11", date: "2026-10-05", balance: 1619.19 };
function recovery(): AmexBalanceRecovery {
  return { snapshot, bookingKeys: fixture().transactions.map((row) => amexBookingKey(row)!) };
}

describe("legacy Amex screenshot total recovery", () => {
  it("only appends the missing verified header while preserving every saved row, alias and classification", () => {
    const state = fixture();
    const before = structuredClone(state);
    expect(needsAmexBalanceRecovery(state)).toBe(true);
    const recovered = recoverAmexBalance(state, [recovery()]);
    expect(recovered.amexBalanceSnapshots).toEqual([snapshot]);
    expect(recovered.transactions).toBe(state.transactions);
    expect(recovered.financeRows).toBe(state.financeRows);
    expect(recovered.merchantRules).toBe(state.merchantRules);
    expect(state).toEqual(before);
    expect(needsAmexBalanceRecovery(recovered)).toBe(false);
    expect(recoverAmexBalance(recovered, [recovery()])).toBe(recovered);
  });

  it("requires two distinct original screenshot identities, not repeated keys or coincidentally matching PDF rows", () => {
    const state = fixture();
    const evidence = recovery();
    expect(recoverAmexBalance(state, [{ ...evidence, bookingKeys: Array(5).fill(evidence.bookingKeys[0]) }])).toBe(state);
    expect(recoverAmexBalance({ ...state, transactions: state.transactions.map((row) => ({ ...row, rawDetails: [] })) },
      [evidence]).amexBalanceSnapshots).toBeUndefined();
    expect(recoverAmexBalance({ ...state, transactions: [] }, [evidence]).amexBalanceSnapshots).toBeUndefined();
  });

  it("includes receipt-only screenshot bookings without adding ledger transactions", () => {
    const state = fixture();
    const receiptState = { ...state, transactions: [], fixedReceipts: state.transactions.map((row) => ({
      key: row.id, date: row.date, amount: row.amount, category: row.category, booking: row,
    })) };
    expect(needsAmexBalanceRecovery(receiptState)).toBe(true);
    const recovered = recoverAmexBalance(receiptState, [recovery()]);
    expect(recovered.amexBalanceSnapshots).toEqual([snapshot]);
    expect(recovered.transactions).toEqual([]);
    expect(recovered.fixedReceipts).toBe(receiptState.fixedReceipts);
  });

  it("does not replace a newer or same-date confirmed snapshot or apply a future capture", () => {
    const state = fixture();
    for (const date of ["2026-10-05", "2026-10-06"]) {
      const confirmed = { ...state, amexBalanceSnapshots: [{ ...snapshot, date, balance: 1500 }] };
      expect(recoverAmexBalance(confirmed, [recovery()])).toBe(confirmed);
    }
    const earlier = { ...state, settings: { ...state.settings, asOf: "2026-10-04" } };
    expect(recoverAmexBalance(earlier, [recovery()])).toBe(earlier);
  });
});
