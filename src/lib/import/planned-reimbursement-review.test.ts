import { afterEach, expect, it, vi } from "vitest";
import { createSeed } from "@/lib/seed";
import { plannedOneOffSchema, type Transaction } from "@/lib/types";
import * as shared from "@/lib/shared-holiday";
import { prepareStatementImport, queueLedgerReview } from "./review";

afterEach(() => vi.restoreAllMocks());
const fixture = () => {
  const state = createSeed();
  state.settings.asOf = "2026-10-05";
  state.transactions = [];
  state.plannedOneOffs = [plannedOneOffSchema.parse({
    id: "shared-purchase", name: "Shared purchase", amount: 400, date: "2026-10-10", sharedWithRaphael: true,
  })];
  const incoming: Transaction = {
    id: "advance", bank: "Revolut", pocket: "Persönliches Konto", date: "2026-10-05",
    description: "Raphael Piber", amount: 200, category: "Prüfen", includeInPlan: true,
  };
  return { state, incoming };
};

it("marks a planned repayment before fresh-import review instead of merely relying on Transfer classification", () => {
  const { state, incoming } = fixture();
  const prepared = prepareStatementImport([{ source: "Revolut", file: "advance.csv", rows: [incoming], skipped: 0, issues: [] }], state);
  expect(prepared.automatic).toHaveLength(1);
  expect(prepared.automatic[0]).toMatchObject({
    id: "advance", amount: 200, holidayReimbursementFor: "planned:shared-purchase:2026-10-10",
  });
  expect(prepared.review).toEqual([]);
  expect(prepared.metadata.fixedReceipts).toEqual([]);
  expect(state.transactions).toEqual([]);
});

it("supplies planned shares when reassessing queued repayments before automatic acceptance", () => {
  const { state, incoming } = fixture();
  state.reviewQueue = [{ kind: "booking", id: incoming.id, draft: incoming, message: "Kategorie offen" }];
  const reconcile = vi.spyOn(shared, "reconcileSharedHoliday");
  const accepted = queueLedgerReview(state);
  const pendingCall = reconcile.mock.calls.findIndex(([rows]) => rows.some((row) => row.id === incoming.id));
  expect(pendingCall).toBeGreaterThanOrEqual(0);
  expect(reconcile.mock.calls[pendingCall][2]).toBe(state.plannedOneOffs);
  expect(reconcile.mock.results[pendingCall].value.bookings[0].holidayReimbursementFor).toBe("planned:shared-purchase:2026-10-10");
  expect(accepted.transactions).toHaveLength(1);
  expect(accepted.transactions[0]).toMatchObject({ id: incoming.id, amount: 200 });
  expect(accepted.reviewQueue).toEqual([]);
  expect(accepted.financeRows).toEqual(state.financeRows);
});
