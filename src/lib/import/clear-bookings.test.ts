import { expect, it } from "vitest";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema } from "@/lib/types";
import { clearAllBookings } from "./clear-bookings";

it("removes bookings and derived statement data but keeps rules and plan", () => {
  const row = transactionSchema.parse({ id: "a", date: "2026-09-05", bank: "Revolut", pocket: null,
    description: "Synthetic", amount: -10, category: "Shopping", includeInPlan: true });
  const base = blankTestState();
  const state = { ...base, transactions: [row], merchantRules: [{ key: "k", category: "Shopping" as const }],
    reviewQueue: [{ kind: "booking" as const, id: "a", draft: row, message: "x" }],
    ignoredStatementKeys: ["x"], importStatus: { imported: 1, issues: [] } };
  const cleared = clearAllBookings(state);
  expect(cleared.transactions).toEqual([]);
  expect(cleared.reviewQueue).toEqual([]);
  expect(cleared.ignoredStatementKeys).toBeUndefined();
  expect(cleared.importStatus).toBeUndefined();
  expect(cleared.merchantRules).toEqual(state.merchantRules);
  expect(cleared.financeRows).toEqual(base.financeRows);
});
