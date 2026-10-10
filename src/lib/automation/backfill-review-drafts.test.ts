import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { transactionSchema, type AppState } from "@/lib/types";
import { queueLedgerReview } from "@/lib/import/review";
import { MerchantIndex, seedMerchants } from "./merchants";
import { backfillBatch } from "./pipeline";
import { AutomationStore } from "./store";

const booking = (id: string, description = "BILLA") =>
  transactionSchema.parse({
    id,
    description,
    date: "2026-10-10",
    bank: "Amex",
    pocket: "Amex",
    amount: -10,
    category: "Prüfen",
    includeInPlan: true,
  });
const index = new MerchantIndex(seedMerchants);

it("freezes the tenant's ledger, receipt and all pending review IDs once without duplicates", async () => {
  const directory = createTestDirectory();
  const accounts = new AccountDatabase(
    join(directory, "review-backfill.sqlite"),
  );
  try {
    const state: AppState = {
      ...blankTestState(),
      transactions: [booking("ledger")],
      fixedReceipts: [
        {
          key: "receipt",
          date: "2026-10-10",
          category: "Prüfen",
          amount: -10,
          booking: booking("receipt"),
        },
      ],
      reviewQueue: [
        {
          kind: "booking",
          id: "ledger-review",
          draft: booking("ledger"),
          message: "Review",
        },
        {
          kind: "booking",
          id: "pending-review",
          draft: booking("pending"),
          message: "Import",
        },
        {
          kind: "fixed",
          id: "fixed-review",
          change: {
            id: "change",
            category: "Prüfen",
            month: "2026-10",
            previous: 0,
            amount: 10,
            bookings: [booking("fixed-only"), booking("receipt")],
          },
        },
      ],
    };
    const user = (await accounts.register("alice", "SyntheticPassword123!"))
      .user;
    const other = (await accounts.register("bob", "SyntheticPassword456!"))
      .user;
    accounts.putFinance(user.id, state, 0);
    accounts.putFinance(
      other.id,
      {
        ...blankTestState(),
        transactions: [booking("foreign")],
      },
      0,
    );
    const store = new AutomationStore(accounts);
    const job = store.enqueueBackfill(user.id, Date.now(), {
      onceVersion: "review-drafts-v1",
    });
    expect(job.total).toBe(4);
    expect(
      accounts
        .read((db) =>
          db
            .prepare(
              "SELECT transaction_id FROM automation_backfill_items WHERE job_id = ? ORDER BY transaction_id",
            )
            .all(job.id),
        )
        .map((row) => row.transaction_id),
    ).toEqual(["fixed-only", "ledger", "pending", "receipt"]);
    accounts.putFinance(
      user.id,
      {
        ...state,
        transactions: [...state.transactions, booking("later")],
      },
      1,
    );
    expect(
      store.enqueueBackfill(user.id, Date.now(), {
        onceVersion: "review-drafts-v1",
      }).id,
    ).toBe(job.id);
    expect(
      store.enqueueBackfill(user.id, Date.now(), {
        onceVersion: "review-drafts-v1",
      }).total,
    ).toBe(4);
  } finally {
    accounts.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("suggests known merchants for pending imports without accepting them or discarding import issues", () => {
  const draft = booking(randomUUID());
  const state: AppState = {
    ...blankTestState(),
    reviewQueue: [
      {
        kind: "booking",
        id: "pending-entry",
        draft,
        message: "Original import requires confirmation",
        importIssues: ["Original issue"],
      },
    ],
  };
  const next = backfillBatch(state, new Set([draft.id]), index);
  expect(next.transactions).toEqual([]);
  expect(next.reviewQueue).toHaveLength(1);
  expect(next.reviewQueue?.[0]).toMatchObject({
    id: "pending-entry",
    message: "Original import requires confirmation",
    importIssues: ["Original issue"],
    draft: {
      id: draft.id,
      category: "Lebensmittel",
      merchantAlias: "BILLA",
      requires_manual_review: true,
    },
  });
  const hydrated = queueLedgerReview(next);
  expect(hydrated.transactions).toEqual([]);
  expect(hydrated.reviewQueue).toEqual(next.reviewQueue);
});

it("leaves incomplete, manually assigned and fuzzy pending drafts in review without fabricated fields", () => {
  const rows = [
    { ...booking("missing-amount"), amount: null },
    { ...booking("zero-amount"), amount: 0 },
    { ...booking("manual"), is_locked: true, category: "Shopping" as const },
    booking("fuzzy", "Muelller"),
  ];
  const state: AppState = {
    ...blankTestState(),
    reviewQueue: rows.map((draft) => ({
      kind: "booking",
      id: draft.id,
      draft,
      message: "Keep in review",
    })),
  };
  const next = backfillBatch(state, new Set(rows.map((row) => row.id)), index);
  expect(next.transactions).toEqual([]);
  expect(next.reviewQueue?.slice(0, 3)).toEqual(state.reviewQueue?.slice(0, 3));
  expect(next.reviewQueue?.[3]).toMatchObject({
    draft: { requires_manual_review: true, category: "Prüfen" },
  });
  expect(
    next.reviewQueue?.[3].kind === "booking" &&
      next.reviewQueue[3].draft.merchantId,
  ).toBeUndefined();
});

it("updates only selected unprotected fixed-proposal bookings and preserves the proposal itself", () => {
  const locked = { ...booking("locked"), is_locked: true };
  const state: AppState = {
    ...blankTestState(),
    reviewQueue: [
      {
        kind: "fixed",
        id: "proposal",
        change: {
          id: "change",
          category: "Prüfen",
          month: "2026-10",
          previous: 10,
          amount: 20,
          bookings: [booking("selected"), locked, booking("unselected")],
        },
      },
    ],
  };
  const next = backfillBatch(state, new Set(["selected", "locked"]), index);
  expect(next.transactions).toEqual([]);
  const item = next.reviewQueue?.[0];
  expect(item).toMatchObject({
    kind: "fixed",
    id: "proposal",
    change: { category: "Prüfen", previous: 10, amount: 20 },
  });
  if (item?.kind !== "fixed") throw new Error("Fixed review proposal was lost");
  expect(item.change.bookings[0]).toMatchObject({ merchantAlias: "BILLA" });
  expect(item.change.bookings[1]).toEqual(locked);
  expect(item.change.bookings[2]).toEqual(booking("unselected"));
});

it("keeps independent manual draft edits and does not duplicate differently keyed review entries", () => {
  const source = booking("uncertain", "Unknown Public Shop");
  const draft = {
    ...source,
    merchantAlias: "My confirmed shop",
    merchantNameConfirmed: true,
  };
  const state: AppState = {
    ...blankTestState(),
    transactions: [source],
    reviewQueue: [
      {
        kind: "booking",
        id: "distinct-review-key",
        draft,
        message: "Manual review",
      },
    ],
  };
  const next = backfillBatch(state, new Set([source.id]), index);
  expect(next.reviewQueue).toEqual(state.reviewQueue);
  expect(next.transactions[0]).toMatchObject({ requires_manual_review: true });
});
