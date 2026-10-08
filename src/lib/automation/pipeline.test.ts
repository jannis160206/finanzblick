import { expect, it } from "vitest";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema } from "@/lib/types";
import { MerchantIndex, seedMerchants } from "./merchants";
import {
  backfillBatch,
  enrichTransaction,
  retainLockedAssignments,
} from "./pipeline";
import { lockManualAssignments } from "./locks";

const index = new MerchantIndex(seedMerchants);
const booking = (description: string) =>
  transactionSchema.parse({
    id: "test",
    description,
    bank: "Amex",
    pocket: "Amex",
    date: "2026-10-08",
    amount: -42,
    category: "Prüfen",
    includeInPlan: true,
  });

it("assigns Müller, reviews unresolved providers/conflicts and does not guess on fuzzy hits", () => {
  expect(enrichTransaction(booking("Müller Filiale 47"), index)).toMatchObject({
    merchantAlias: "Müller",
    category: "Drogerie",
    requires_manual_review: false,
  });
  expect(
    enrichTransaction(booking("PayPal * BILLA 1234"), index),
  ).toMatchObject({ merchantAlias: "BILLA" });
  for (const text of ["PayPal 123456", "BILLA PENNY", "Muelller"])
    expect(enrichTransaction(booking(text), index)).toMatchObject({
      requires_manual_review: true,
    });
});

it("persists manual locks and never overwrites their merchant/category during automated reconciliation", () => {
  const row = {
    ...booking("BILLA"),
    category: "Shopping" as const,
    merchantAlias: "Mein Laden",
    manualCategory: true,
  };
  const state = lockManualAssignments({
    ...blankTestState(),
    transactions: [row],
  });
  expect(state.transactions[0].is_locked).toBe(true);
  expect(enrichTransaction(state.transactions[0], index)).toEqual(
    state.transactions[0],
  );
  const reconciled = retainLockedAssignments(state, {
    ...state,
    transactions: [
      {
        ...state.transactions[0],
        merchantAlias: "BILLA",
        category: "Lebensmittel",
      },
    ],
  });
  expect(reconciled.transactions[0]).toEqual(state.transactions[0]);
});

it("protects legacy manual aliases before applying a conflicting learned rule", () => {
  const row = {
    ...booking("BILLA"),
    category: "Shopping" as const,
    merchantAlias: "Mein Laden",
  };
  const state = {
    ...blankTestState(),
    transactions: [row],
    merchantRules: [
      { key: "amex|mein laden", category: "Lebensmittel" as const },
    ],
  };
  const updated = backfillBatch(state, new Set([row.id]), index);
  expect(updated.transactions[0]).toMatchObject({
    merchantAlias: "Mein Laden",
    category: "Shopping",
    is_locked: true,
  });
});

it("keeps deliberately reopened locked bookings in the review queue during backfill", () => {
  const row = { ...booking("BILLA"), manualCategory: true, is_locked: true };
  const state = {
    ...blankTestState(),
    transactions: [row],
    reviewQueue: [
      {
        kind: "booking" as const,
        id: row.id,
        draft: row,
        message: "Bewusst erneut prüfen",
      },
    ],
  };
  const updated = backfillBatch(state, new Set([row.id]), index);
  expect(updated.transactions[0].category).toBe("Prüfen");
  expect(updated.reviewQueue?.[0]).toEqual(state.reviewQueue[0]);
});

it("round-trips worker merchant IDs, locks and review flags through Excel without turning automatic aliases into manual ones", async () => {
  const row = {
    ...enrichTransaction(booking("Müller"), index),
    is_locked: false,
  };
  const state = { ...blankTestState(), transactions: [row] };
  const restored = await parseWorkbook(await exportWorkbook(state));
  expect(restored.state.transactions[0]).toMatchObject({
    merchantId: row.merchantId,
    merchantAlias: row.merchantAlias,
    is_locked: false,
    requires_manual_review: false,
  });
});
