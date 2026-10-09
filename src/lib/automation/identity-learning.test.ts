import { expect, it } from "vitest";
import { appStateSchema, transactionSchema } from "@/lib/types";
import { blankTestState } from "@/lib/server/test-support";
import { merchantAliasAssignment } from "@/lib/merchant-identity";
import {
  merchantAliasSourceKey,
  merchantRuleKey,
  rememberMerchants,
  applyMerchantRules,
} from "@/lib/import/merchant-rules";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { queueLedgerReview } from "@/lib/import/review";
import { createAccountMerchantResolver } from "./aliases";
import { enrichTransaction, backfillBatch } from "./pipeline";
import { MerchantIndex, seedMerchants } from "./merchants";

const index = new MerchantIndex(seedMerchants);
const original = transactionSchema.parse({
  id: "source",
  date: "2026-10-08",
  bank: "Amex",
  pocket: "Amex",
  description: "POS Nordlicht Laden Terminal 1234 Ref: OLD123",
  amount: -42,
  category: "Prüfen",
  includeInPlan: true,
});
const future = {
  ...original,
  id: "future",
  description: "POS Nordlicht Laden Terminal 9876 Ref: NEW999",
};
const confirm = (alias: string) => ({
  ...original,
  ...merchantAliasAssignment(original, alias),
});

it("learns a confirmed merchant without requiring or inventing a category", () => {
  const selected = confirm("Nordlicht");
  const state = rememberMerchants(
    { ...blankTestState(), transactions: [selected] },
    [selected],
  );
  expect(state.merchantRules).toEqual([
    {
      key: merchantAliasSourceKey(original),
      merchantAlias: "Nordlicht",
      category: "Prüfen",
      identityOnly: true,
    },
  ]);
  const result = enrichTransaction(
    future,
    index,
    createAccountMerchantResolver(state),
  );
  expect(result).toMatchObject({
    merchantAlias: "Nordlicht",
    merchantMatch: "rule",
    category: "Prüfen",
    requires_manual_review: true,
  });
  expect(result.merchantNameConfirmed).toBeUndefined();
  expect(result.categoryOverride).not.toBe(true);
  expect(
    enrichTransaction(
      future,
      index,
      createAccountMerchantResolver(blankTestState()),
    ).merchantAlias,
  ).toBeUndefined();
  expect(
    rememberMerchants({ ...state, transactions: [result] }, [result])
      .merchantRules,
  ).toEqual(state.merchantRules);
});

it("uses independent safe directory evidence after a name-only confirmation", () => {
  const selected = confirm("BILLA");
  const state = rememberMerchants(
    { ...blankTestState(), transactions: [selected] },
    [selected],
  );
  expect(
    enrichTransaction(future, index, createAccountMerchantResolver(state)),
  ).toMatchObject({
    merchantAlias: "BILLA",
    merchantId: "at-billa",
    category: "Lebensmittel",
    requires_manual_review: false,
    merchantMatch: "rule",
  });
  const marketplace = confirm("Amazon");
  const marketState = rememberMerchants(
    { ...blankTestState(), transactions: [marketplace] },
    [marketplace],
  );
  expect(
    enrichTransaction(
      future,
      index,
      createAccountMerchantResolver(marketState),
    ),
  ).toMatchObject({
    merchantAlias: "Amazon",
    category: "Prüfen",
    requires_manual_review: true,
  });
});

it("does not promote an inherited automatic category when only its name is confirmed", () => {
  const selected = {
    ...original,
    category: "Shopping" as const,
    categoryOverride: true,
    merchantId: "at-billa",
    merchantMatch: "alias" as const,
    ...merchantAliasAssignment({ merchantAlias: "BILLA" }, "BILLA"),
  };
  const state = rememberMerchants(
    {
      ...blankTestState(),
      transactions: [selected],
      merchantRules: [
        {
          key: merchantAliasSourceKey(original)!,
          merchantAlias: "BILLA",
          category: "Shopping",
        },
      ],
    },
    [selected],
  );
  expect(state.merchantRules).toEqual([
    {
      key: merchantAliasSourceKey(original),
      merchantAlias: "BILLA",
      category: "Prüfen",
      identityOnly: true,
    },
  ]);
  expect(
    enrichTransaction(future, index, createAccountMerchantResolver(state))
      .category,
  ).toBe("Lebensmittel");
  const item = queueLedgerReview(state).reviewQueue?.[0];
  expect(item?.kind).toBe("booking");
  if (item?.kind === "booking") expect(item.message).toContain("Kategorie");
});

it("keeps manually confirmed names locked and propagates no human label through legacy rule repair", () => {
  const selected = confirm("Nordlicht");
  const state = rememberMerchants(
    { ...blankTestState(), transactions: [selected] },
    [selected],
  );
  expect(
    backfillBatch(state, new Set([selected.id]), index).transactions[0],
  ).toMatchObject({
    merchantAlias: "Nordlicht",
    merchantNameConfirmed: true,
    is_locked: true,
    category: "Prüfen",
  });
  const reapplied = applyMerchantRules(state, [
    { ...original, id: "legacy-future" },
  ])[0];
  expect(reapplied).toMatchObject({
    merchantAlias: "Nordlicht",
    merchantMatch: "rule",
    requires_manual_review: true,
    category: "Prüfen",
  });
  expect(reapplied.merchantNameConfirmed).toBeUndefined();
});

it("does not turn a receipt wrapper's inherited category into a name-only rule's category", () => {
  const selected = confirm("Nordlicht");
  const state = rememberMerchants(
    {
      ...blankTestState(),
      transactions: [],
      fixedReceipts: [
        {
          key: "receipt",
          merchantKey: merchantRuleKey(selected),
          category: "Shopping",
          booking: selected,
          date: selected.date,
          amount: selected.amount,
        },
      ],
    },
    [selected],
  );
  expect(
    applyMerchantRules(state, [{ ...original, id: "later" }])[0],
  ).toMatchObject({
    merchantAlias: "Nordlicht",
    category: "Prüfen",
    requires_manual_review: true,
  });
});

it("round-trips explicit confirmations and identity-only rules through JSON and Excel", async () => {
  const selected = confirm("Nordlicht");
  const state = rememberMerchants(
    { ...blankTestState(), transactions: [selected] },
    [selected],
  );
  for (const restored of [
    appStateSchema.parse(JSON.parse(JSON.stringify(state))),
    (await parseWorkbook(await exportWorkbook(state))).state,
  ]) {
    expect(restored.transactions[0].merchantNameConfirmed).toBe(true);
    expect(restored.merchantRules).toEqual(state.merchantRules);
    expect(
      enrichTransaction(future, index, createAccountMerchantResolver(restored))
        .merchantAlias,
    ).toBe("Nordlicht");
  }
});

it("upgrades a separately confirmed name after a category decision without requiring a second name edit", () => {
  const selected = confirm("Nordlicht");
  const state = rememberMerchants(
    { ...blankTestState(), transactions: [selected] },
    [selected],
  );
  const reviewed = {
    ...selected,
    category: "Shopping" as const,
    manualCategory: true,
    categoryOverride: true,
    reviewed: true,
  };
  const updated = rememberMerchants({ ...state, transactions: [reviewed] }, [
    reviewed,
  ]);
  expect(
    updated.merchantRules?.find(
      (rule) => rule.key === merchantAliasSourceKey(original),
    ),
  ).toMatchObject({ merchantAlias: "Nordlicht", category: "Shopping" });
  expect(updated.merchantRules?.some((rule) => rule.identityOnly)).toBe(false);
  expect(
    enrichTransaction(future, index, createAccountMerchantResolver(updated)),
  ).toMatchObject({
    merchantAlias: "Nordlicht",
    category: "Shopping",
    requires_manual_review: false,
  });
});

it("does not learn blanket provider names, transfers or salary senders", () => {
  for (const row of [
    {
      ...original,
      description: "PayPal",
      ...merchantAliasAssignment(original, "Nordlicht"),
    },
    {
      ...original,
      description: "SEPA Überweisung an Nordlicht",
      category: "Transfer" as const,
      ...merchantAliasAssignment(original, "Nordlicht"),
    },
    {
      ...original,
      amount: 42,
      ...merchantAliasAssignment(original, "Nordlicht"),
    },
  ]) {
    const state = rememberMerchants(
      { ...blankTestState(), transactions: [row] },
      [row],
    );
    expect(state.merchantRules?.length ?? 0).toBe(0);
  }
});
