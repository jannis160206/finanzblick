import { expect, it } from "vitest";
import { transactionSchema } from "@/lib/types";
import { blankTestState } from "@/lib/server/test-support";
import { classify } from "@/lib/calc";
import { bookingReviewReason, openReviewCount, queueLedgerReview, reconcileLedgerReviewQueue } from "@/lib/import/review";
import { MerchantIndex, seedMerchants } from "./merchants";
import { backfillBatch, enrichTransaction } from "./pipeline";
import { parseOsmMerchants } from "./merchant-import";
import { statementFingerprint } from "@/lib/import/identity";
import { activeMerchantRules, createMerchantRuleApplier, isAutomaticMerchantAssignment, merchantRuleKey } from "@/lib/import/merchant-rules";
import { createAccountMerchantResolver } from "./aliases";

const index = new MerchantIndex(seedMerchants);
const row = (description: string) =>
  transactionSchema.parse({
    id: "purpose",
    description,
    amount: -42,
    date: "2026-10-08",
    bank: "Amex",
    pocket: "Amex",
    category: "Prüfen",
    includeInPlan: true,
  });

const untypedBipa = parseOsmMerchants({
  version: 0.6,
  osm3s: { copyright: "OpenStreetMap contributors" },
  elements: [{ type: "node", id: 101, tags: { name: "BIPA", shop: "unmapped" } }],
}).merchants[0];
const nullCategoryIndex = new MerchantIndex([...seedMerchants, untypedBipa]);

it("reconciles receipt review aliases without accepting ready pending imports or changing financial facts", () => {
  const accepted = { ...row("Kontoführungsgebühr"), id: "receipt-source", category: "Bankgebühren" as const,
    categoryOverride: true, requires_manual_review: false,
    automaticCategoryEvidence: { method: "purpose" as const, category: "Bankgebühren" as const } };
  const pending = { ...row("Independent pending purchase"), id: "pending-human",
    category: "Geschenke & Spenden" as const, manualCategory: true, categoryOverride: true };
  const state = { ...blankTestState(), transactions: [],
    fixedReceipts: [{ key: statementFingerprint(accepted), booking: accepted, category: accepted.category,
      amount: accepted.amount, date: accepted.date }],
    reviewQueue: [
      { kind: "booking" as const, id: accepted.id, draft: { ...accepted, requires_manual_review: true },
        message: "Stale receipt alias" },
      { kind: "booking" as const, id: pending.id, draft: pending, message: "Pending approval" },
    ] };
  const original = structuredClone(state);
  expect(reconcileLedgerReviewQueue(state)).toEqual([state.reviewQueue[1]]);
  expect(state).toEqual(original);
  const filled = backfillBatch(state, new Set([accepted.id, pending.id]), index);
  expect(filled.transactions).toEqual([]);
  expect(filled.reviewQueue).toEqual([state.reviewQueue[1]]);
  expect(filled.settings).toEqual(original.settings);
  expect(filled.fixedReceipts?.map(({ key, amount, date }) => ({ key, amount, date })))
    .toEqual(original.fixedReceipts.map(({ key, amount, date }) => ({ key, amount, date })));
  expect(filled.fixedReceipts?.[0].booking?.automaticCategoryEvidence).toEqual(accepted.automaticCategoryEvidence);
});

it("does not learn proof-only automatic purposes as manual choices but retains real human authority", () => {
  const automatic = enrichTransaction(row("Nova Supermarket"), index);
  expect(automatic.merchantId).toBeUndefined();
  expect(automatic.merchantMatch).toBeUndefined();
  expect(isAutomaticMerchantAssignment(automatic)).toBe(true);
  const future = { ...row("Nova Supermarket"), id: "future", date: "2026-10-09" };
  expect(createMerchantRuleApplier({ ...blankTestState(), transactions: [automatic] })(future))
    .toEqual(future);
  const chosen = { ...automatic, category: "Geschenke & Spenden" as const, manualCategory: true };
  expect(isAutomaticMerchantAssignment(chosen)).toBe(false);
  expect(createMerchantRuleApplier({ ...blankTestState(), transactions: [chosen] })(future))
    .toMatchObject({ category: "Geschenke & Spenden", categoryOverride: true });
  const guessed = { ...automatic, id: "guess", category: "Geschenke & Spenden" as const,
    merchantId: "legacy-guess", merchantMatch: "alias" as const };
  const rule = { key: merchantRuleKey(automatic), category: "Geschenke & Spenden" as const };
  expect(activeMerchantRules({ ...blankTestState(), transactions: [automatic, guessed], merchantRules: [rule] }))
    .toEqual([]);
  expect(activeMerchantRules({ ...blankTestState(), transactions: [chosen, guessed], merchantRules: [rule] }))
    .toEqual([rule]);
  const resolver = createAccountMerchantResolver({ ...blankTestState(), transactions: [chosen] });
  expect(enrichTransaction(chosen, index, resolver)).toEqual({ ...chosen, is_locked: true });
  for (const patch of [
    { reviewed: true, categoryOverride: true },
    { is_locked: true },
    { merchantAlias: "Legacy Human Alias" },
    { merchantAlias: "Confirmed Name", merchantNameConfirmed: true },
  ])
    expect(isAutomaticMerchantAssignment({ ...automatic, ...patch })).toBe(false);
  const nameRule = { key: merchantRuleKey(automatic), category: "Prüfen" as const,
    merchantAlias: "Confirmed Name", identityOnly: true };
  expect(activeMerchantRules({ ...blankTestState(), transactions: [automatic], merchantRules: [nameRule] }))
    .toEqual([nameRule]);
  const unnamed = { ...row("Mensa"), requires_manual_review: true };
  const unnamedGuess = { ...unnamed, id: "unnamed-guess", category: "Restaurants" as const,
    merchantMatch: "rule" as const };
  const conflicting = { key: merchantRuleKey(unnamed), category: "Restaurants" as const };
  const unresolved = { ...blankTestState(), transactions: [unnamed, unnamedGuess], merchantRules: [conflicting] };
  expect(activeMerchantRules(unresolved)).toEqual([conflicting]);
  expect(enrichTransaction(unnamed, index, createAccountMerchantResolver(unresolved))
    .requires_manual_review).toBe(true);
});

it.each([
  ["2026-10-08", "Mittagessen"],
  ["2026-10-10", "Drogerie"],
])("uses independently evidenced recurring purpose on %s despite an unknown same-name shop type", (date, category) => {
  const original = { ...row("BIPA"), date, category: "Shopping" as const,
    merchantId: "at-bipa", merchantAlias: "BIPA", merchantMatch: "alias" as const,
    requires_manual_review: true };
  expect(nullCategoryIndex.match(original.description)).toEqual({
    method: "exact", requiresManualReview: true,
  });
  expect(nullCategoryIndex.categoryConsensus(original.description)).toBeUndefined();
  expect(nullCategoryIndex.categoryConsensus(original.description, undefined, "Shopping")).toBeUndefined();
  const result = enrichTransaction(original, nullCategoryIndex);
  expect(result).toMatchObject({
    category, categoryOverride: true, requires_manual_review: false,
    automaticCategoryEvidence: { method: "purpose", category },
    amount: original.amount, date: original.date, description: original.description,
    merchantLogo: false,
  });
  expect(result.merchantId).toBeUndefined();
  expect(result.merchantAlias).toBeUndefined();
  expect(result.merchantMatch).toBeUndefined();
  expect(classify(result).category).toBe(category);
  expect(enrichTransaction(result, nullCategoryIndex)).toEqual(result);
});

it.each([
  { rawDetails: ["MCC: 5541"] },
  { rawDetails: ["MCC: 5411"] },
  { rawDetails: ["MCC: 5812"] },
  { rawDetails: ["MCC: invalid"] },
  { sourceCategory: "Amazon" },
  { sourceCategory: "Shopping" },
])("retains opposing purchase evidence despite recurring purpose: %j", (patch) => {
  expect(enrichTransaction({ ...row("BIPA"), ...patch }, nullCategoryIndex)
    .requires_manual_review).toBe(true);
});

it("does not use a recurring name to hide a different business, opposing purpose or missing catalogue purpose", () => {
  const variants = [
    new MerchantIndex([...seedMerchants, { ...untypedBipa, canonicalName: "Nova Shop", aliases: ["BIPA"] }]),
    new MerchantIndex([...seedMerchants, { ...untypedBipa, defaultCategory: "Shopping" }]),
    new MerchantIndex([untypedBipa, { ...untypedBipa, id: "another-untyped-bipa" }]),
  ];
  for (const catalogue of variants)
    expect(enrichTransaction(row("BIPA"), catalogue).requires_manual_review).toBe(true);
  expect(enrichTransaction(row("BIPAA"), nullCategoryIndex).requires_manual_review).toBe(true);
  expect(enrichTransaction({ ...row("BIPA"), date: "" }, nullCategoryIndex)
    .requires_manual_review).toBe(true);
});

it("clears only proven ledger reviews while retaining manual choices, fixed proposals and pending import approvals", () => {
  const resolved = row("BIPA");
  const unknown = { ...row("Unknown Entity"), id: "unknown", category: "Shopping" as const };
  const chosen = { ...row("BIPA"), id: "manual", category: "Geschenke & Spenden" as const,
    manualCategory: true };
  const named = { ...row("BIPA"), id: "named", merchantAlias: "BIPA",
    merchantNameConfirmed: true };
  const planned = { ...row("Planned Contract"), id: "planned",
    category: "Telefon & Internet" as const, manualCategory: true, fixedCost: true };
  const pending = { ...row("BIPA"), id: "pending", date: "2026-10-09", requires_manual_review: true };
  const incomplete = { ...row("BIPA"), id: "incomplete", amount: null };
  const state = { ...blankTestState(), transactions: [resolved, unknown, chosen, named, planned],
    fixedReceipts: [{ key: statementFingerprint(planned), booking: planned, date: planned.date,
      amount: planned.amount, category: planned.category }],
    reviewQueue: [
      { kind: "booking" as const, id: resolved.id, draft: resolved, message: "Category review" },
      { kind: "booking" as const, id: unknown.id, draft: unknown, message: "Unknown purpose" },
      { kind: "booking" as const, id: named.id, draft: named, message: "Name only" },
      { kind: "booking" as const, id: pending.id, draft: pending, message: "Import approval",
        importIssues: ["Check source image"], importUploadId: "synthetic-upload" },
      { kind: "booking" as const, id: incomplete.id, draft: incomplete, message: "Missing amount" },
      { kind: "fixed" as const, id: "fixed-proposal", change: { id: "fixed-proposal",
        category: planned.category, month: "2026-10", previous: 30, amount: 42, bookings: [planned] } },
    ] };
  const result = queueLedgerReview(backfillBatch(state,
    new Set([resolved.id, unknown.id, chosen.id, named.id, planned.id, pending.id, incomplete.id]), nullCategoryIndex));
  expect(result.transactions.map(({ amount, date, description }) => ({ amount, date, description })))
    .toEqual(state.transactions.map(({ amount, date, description }) => ({ amount, date, description })));
  expect(result.settings).toEqual(state.settings);
  expect(result.transactions.find((booking) => booking.id === chosen.id))
    .toEqual({ ...chosen, is_locked: true });
  expect(result.transactions.find((booking) => booking.id === named.id))
    .toEqual({ ...named, is_locked: true });
  expect(bookingReviewReason(result, result.transactions[0])).toBeUndefined();
  expect(result.reviewQueue?.some((item) => item.id === resolved.id)).toBe(false);
  expect(result.reviewQueue?.find((item) => item.id === pending.id)).toMatchObject({
    message: "Import approval", importIssues: ["Check source image"], importUploadId: "synthetic-upload",
    draft: { category: "Mittagessen", requires_manual_review: true },
  });
  expect(result.reviewQueue?.find((item) => item.id === incomplete.id)).toEqual(state.reviewQueue[4]);
  expect(result.reviewQueue?.find((item) => item.id === "fixed-proposal")).toEqual(state.reviewQueue[5]);
  expect(result.fixedReceipts).toEqual(state.fixedReceipts.map((receipt) =>
    ({ ...receipt, booking: { ...planned, is_locked: true } })));
  expect(result.transactions.some((booking) => booking.id === pending.id)).toBe(false);
  // A confirmed name with a concrete category no longer waits for a second confirmation.
  expect(result.reviewQueue?.some((item) => item.id === named.id)).toBe(false);
  expect(openReviewCount(result.reviewQueue ?? [])).toBe(4);
  expect(queueLedgerReview(result).reviewQueue).toEqual(result.reviewQueue);
});

it("uses unanimously corroborated public shop types without guessing a duplicate outlet identity", () => {
  const imported = parseOsmMerchants({
    version: 0.6,
    osm3s: { copyright: "OpenStreetMap contributors" },
    elements: [
      { type: "node", id: 1, tags: { name: "BIPA", shop: "chemist" } },
      { type: "node", id: 2, tags: { name: "BIPA", shop: "chemist" } },
    ],
  }).merchants;
  const corroborated = new MerchantIndex([...seedMerchants, ...imported]);
  expect(corroborated.match("BIPA").requiresManualReview).toBe(true);
  const result = enrichTransaction(row("BIPA"), corroborated);
  expect(result).toMatchObject({
    category: "Mittagessen",
    requires_manual_review: false,
  });
  expect(result.merchantId).toBeUndefined();
  expect(result.merchantAlias).toBeUndefined();
  expect(
    enrichTransaction(
      { ...row("BIPA"), rawDetails: ["MCC: 5541"] },
      corroborated,
    ).requires_manual_review,
  ).toBe(true);
  expect(
    enrichTransaction(row("BIPAA"), corroborated).requires_manual_review,
  ).toBe(true);
  const contradictory = new MerchantIndex([
    ...seedMerchants,
    { ...imported[0], defaultCategory: "Shopping" },
  ]);
  expect(
    enrichTransaction(row("BIPA"), contradictory).requires_manual_review,
  ).toBe(true);
});

it("uses a clear dining purpose across compatible restaurant/cafe types but not conflicting bank MCCs", () => {
  const imported = parseOsmMerchants({
    version: 0.6,
    osm3s: { copyright: "OpenStreetMap contributors" },
    elements: [
      { type: "node", id: 3, tags: { name: "McDonalds", amenity: "cafe" } },
    ],
  }).merchants;
  const compatible = new MerchantIndex([...seedMerchants, ...imported]);
  expect(compatible.match("McDonalds Villach").merchant).toBeUndefined();
  const result = enrichTransaction(row("McDonalds Villach"), compatible);
  expect(result).toMatchObject({
    category: "Restaurants",
    requires_manual_review: false,
  });
  expect(result.merchantId).toBeUndefined();
  expect(
    enrichTransaction(
      { ...row("McDonalds Villach"), rawDetails: ["MCC: 5541"] },
      compatible,
    ).requires_manual_review,
  ).toBe(true);
});

it("assigns a clear purpose without inventing a merchant identity and clears the review queue", () => {
  const original = row("Nova Supermarket");
  const state = blankTestState();
  state.transactions = [original];
  state.reviewQueue = [
    {
      kind: "booking",
      id: original.id,
      draft: original,
      message: "Händler fehlt",
    },
  ];
  const result = backfillBatch(state, new Set([original.id]), index);
  expect(result.transactions[0]).toMatchObject({
    category: "Lebensmittel",
    requires_manual_review: false,
    automaticCategoryEvidence: { method: "purpose", category: "Lebensmittel" },
  });
  expect(result.transactions[0].merchantId).toBeUndefined();
  expect(result.transactions[0].merchantAlias).toBeUndefined();
  expect(result.reviewQueue).toHaveLength(0);
  expect(bookingReviewReason(result, result.transactions[0])).toBeUndefined();
});

it("uses explicit bank MCC for previously unknown merchants", () => {
  const result = enrichTransaction(
    { ...row("Nova Outlet"), rawDetails: ["MCC: 5411"] },
    index,
  );
  expect(result).toMatchObject({
    category: "Lebensmittel",
    requires_manual_review: false,
  });
  expect(result.automaticCategoryEvidence).toEqual({
    method: "mcc",
    category: "Lebensmittel",
    mcc: "5411",
  });
});

it.each([
  { ...row("Nova Pharmacy"), rawDetails: ["MCC: 5411"] },
  { ...row("BILLA"), rawDetails: ["MCC: 5812"] },
  row("Unknown Entity"),
])(
  "keeps unresolved or contradictory evidence for manual review",
  (original) => {
    expect(enrichTransaction(original, index).requires_manual_review).toBe(
      true,
    );
  },
);

it.each([
  "Cyprus Duty Free",
  "Heinemann Duty Free Frankfurt",
  "Airport Duty-Free",
])(
  "displays %s as Shopping, not Urlaub, and retains holiday budget exclusions",
  (description) => {
    const original = {
      ...row(description),
      category: "Urlaub" as const,
      sourceCategory: "Urlaub",
      holidayRange: "2026-10-01..2026-10-12",
    };
    const result = enrichTransaction(original, index);
    expect(result).toMatchObject({
      category: "Shopping",
      requires_manual_review: false,
    });
    expect(classify(result)).toMatchObject({
      category: "Shopping",
      includeInPlan: false,
    });
  },
);

it("never overwrites a manually chosen duty-free category", () => {
  const original = {
    ...row("Cyprus Duty Free"),
    category: "Geschenke & Spenden" as const,
    manualCategory: true,
  };
  expect(enrichTransaction(original, index)).toEqual({
    ...original,
    is_locked: true,
  });
  expect(classify(original).category).toBe("Geschenke & Spenden");
});

it.each([
  ["Cyprus Duty Free", -42],
  ["Airport Duty-Free", -42],
  ["Cyprus Duty Free", 42],
  ["Airport Duty-Free", 42],
])(
  "retains holiday budget exclusion across repeated enrichment: %s %s",
  (description, amount) => {
    const original = {
      ...row(description),
      amount,
      category: "Urlaub" as const,
    };
    expect(classify(original).includeInPlan).toBe(false);
    const result = enrichTransaction(original, index);
    expect(result.automaticCategoryEvidence?.budgetExcluded).toBe(true);
    const expected = amount < 0 ? "Shopping" : "Rückerstattungen";
    expect(classify(result)).toMatchObject({
      category: expected,
      includeInPlan: false,
    });
    expect(classify(enrichTransaction(result, index))).toMatchObject({
      category: expected,
      includeInPlan: false,
    });
  },
);
