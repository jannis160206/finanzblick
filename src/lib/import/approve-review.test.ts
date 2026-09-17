import { afterEach, describe, expect, it, vi } from "vitest";
import * as calc from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import {
  appStateSchema,
  type AppState,
  type ReviewItem,
  type Transaction,
} from "@/lib/types";
import { approveReviewedBooking } from "./approve-review";
import { statementFingerprint } from "./identity";
import * as merchantRules from "./merchant-rules";
import { commitStatementImport, queueLedgerReview } from "./review";

const booking = (id: string, overrides: Partial<Transaction> = {}): Transaction => ({
  id,
  date: "2026-09-03",
  bank: "Raiffeisen",
  pocket: "Testkonto",
  description: "Testladen Nordlicht",
  amount: -24,
  category: "Prüfen",
  includeInPlan: true,
  ...overrides,
});

const pending = (draft: Transaction): ReviewItem => ({
  kind: "booking",
  id: draft.id,
  draft,
  message: "Kategorie noch offen oder widersprüchlich.",
});

function fixture(transactions: Transaction[] = [], overrides: Partial<AppState> = {}): AppState {
  return queueLedgerReview(appStateSchema.parse({
    ...createSeed(),
    transactions,
    merchantRules: [],
    fixedReceipts: [],
    fixedAmountDecisions: [],
    ignoredStatementKeys: [],
    pocketSnapshots: [],
    accountSnapshots: [],
    reviewQueue: [],
    holidayRanges: [],
    ...overrides,
  }));
}

function choose(state: AppState, id: string, category: Transaction["category"] = "Shopping"): Transaction {
  const item = state.reviewQueue?.find((item) => item.kind === "booking" && item.draft.id === id);
  if (!item || item.kind !== "booking" || item.draft.amount === null)
    throw new Error(`Expected complete booking review: ${id}`);
  return { ...item.draft, amount: item.draft.amount, category, categoryOverride: true, includeInPlan: true };
}

function reference(state: AppState, selected: Transaction) {
  const result = commitStatementImport(state, [selected]);
  return { ...result, state: queueLedgerReview(result.state) };
}

function expectEquivalent(state: AppState, selected: Transaction, required = true) {
  const before = structuredClone(state);
  const expected = reference(state, selected);
  const actual = approveReviewedBooking(state, selected);
  expect(state).toEqual(before);
  if (required) expect(actual).toBeDefined();
  if (actual) expect(actual).toEqual(expected);
  return actual;
}

function approve(state: AppState, selected: Transaction) {
  const result = expectEquivalent(state, selected);
  if (!result) throw new Error("Ordinary category approval must use the fast path");
  return result;
}

afterEach(() => vi.restoreAllMocks());

describe("incremental booking review approval", () => {
  it("updates every stored booking of the merchant, without crossing bank boundaries", () => {
    const state = fixture([
      booking("first"),
      booking("second", { date: "2026-09-04", amount: -31 }),
      booking("other-bank", { bank: "Revolut" }),
      booking("other-merchant", { description: "Testladen Südlicht" }),
    ]);
    const original = [...state.transactions];
    const result = approve(state, choose(state, "first"));

    expect(result).toMatchObject({ added: 0, duplicates: 0, changes: [] });
    expect(result.state.transactions).toHaveLength(4);
    expect(result.state.transactions.slice(0, 2)).toEqual([
      expect.objectContaining({ id: "first", category: "Shopping", categoryOverride: true }),
      expect.objectContaining({ id: "second", category: "Shopping", categoryOverride: true }),
    ]);
    expect(result.state.transactions[2]).toBe(original[2]);
    expect(result.state.transactions[3]).toBe(original[3]);
    expect(result.state.financeRows).toBe(state.financeRows);
    expect(result.state.settings).toBe(state.settings);
    expect(result.state.reviewQueue?.map((item) => item.id)).toEqual(["other-bank", "other-merchant"]);
    expect(result.state.merchantRules).toEqual([
      { key: merchantRules.merchantRuleKey(original[0]), category: "Shopping" },
    ]);
  });

  it("changes only the category of current ledger facts when the selected draft is stale", () => {
    const latest = booking("current", {
      date: "2026-09-07",
      time: "18:20:00",
      amount: -73.25,
      pocket: "Aktuelles Testkonto",
      bankReference: "synthetic-current-reference",
      rawDescription: "Testladen Nordlicht aktuelle Buchungsdaten",
      rawDetails: ["Aktuelle synthetische Zusatzinformation"],
      afterBaseline: true,
      occurrence: 2,
    });
    const state = fixture([latest]);
    const selected = {
      ...choose(state, "current"),
      date: "2026-09-01",
      time: "08:00:00",
      amount: -1,
      pocket: "Veraltetes Testkonto",
      bankReference: "synthetic-stale-reference",
      rawDescription: "Veraltete synthetische Buchungsdaten",
      rawDetails: ["Veraltet"],
      afterBaseline: false,
      occurrence: 1,
    };
    const result = approve(state, selected);

    expect(result.added).toBe(0);
    expect(result.state.transactions).toEqual([
      { ...state.transactions[0], category: "Shopping", categoryOverride: true, includeInPlan: true },
    ]);
  });

  it("appends a known pending unknown booking exactly once and updates import counts", () => {
    const draft = booking("pending");
    const state = fixture([], {
      reviewQueue: [pending(draft)],
      importStatus: { imported: 9, issues: ["synthetic.csv: Unvollständige andere Zeile"] },
    });
    const selected = choose(state, draft.id);
    const result = approve(state, selected);

    expect(result).toMatchObject({ added: 1, duplicates: 0, changes: [] });
    expect(result.state.transactions).toEqual([
      expect.objectContaining({ id: draft.id, amount: draft.amount, category: "Shopping", occurrence: 1 }),
    ]);
    expect(result.state.reviewQueue).toEqual([]);
    expect(result.state.importStatus).toEqual({ imported: 10, issues: state.importStatus!.issues });
    expect(approveReviewedBooking(result.state, selected)).toBeUndefined();
  });

  it("appends all pending bookings for one merchant without repeating the selected row", () => {
    const first = booking("pending-first");
    const second = booking("pending-second", { date: "2026-09-04", amount: -32 });
    const third = booking("pending-third", { date: "2026-09-05", amount: -41 });
    const other = booking("pending-other", { description: "Testladen Südlicht" });
    const state = fixture([], { reviewQueue: [first, second, third, other].map(pending) });
    const result = approve(state, choose(state, second.id));

    expect(result.added).toBe(3);
    expect(new Set(result.state.transactions.map((row) => row.id))).toEqual(new Set([first.id, second.id, third.id]));
    expect(new Set(result.state.transactions.map(statementFingerprint)).size).toBe(3);
    expect(result.state.transactions.every((row) => row.category === "Shopping")).toBe(true);
    expect(result.state.reviewQueue).toEqual([state.reviewQueue![3]]);
  });

  it("resolves both existing and pending bookings for the selected merchant", () => {
    const stored = booking("stored");
    const imported = booking("imported", { date: "2026-09-05", amount: -48 });
    const state = fixture([stored], { reviewQueue: [pending(imported)] });
    const result = approve(state, choose(state, stored.id));

    expect(result.added).toBe(1);
    expect(result.state.transactions.map((row) => row.id)).toEqual([stored.id, imported.id]);
    expect(result.state.transactions.every((row) => row.category === "Shopping")).toBe(true);
    expect(result.state.reviewQueue).toEqual([]);
  });

  it("retains distinct same-day pending purchases with explicit occurrence numbers", () => {
    const first = booking("first", { occurrence: 1 });
    const second = booking("second", { occurrence: 2 });
    const state = fixture([], { reviewQueue: [pending(first), pending(second)] });
    const result = approve(state, choose(state, first.id));

    expect(result.added).toBe(2);
    expect(result.state.transactions.map((row) => row.occurrence)).toEqual([1, 2]);
    expect(new Set(result.state.transactions.map(statementFingerprint)).size).toBe(2);
  });

  it.each([
    ["unnumbered", "first", undefined],
    ["unnumbered", "second", undefined],
    ["same bank reference", "first", "synthetic-duplicate-reference"],
    ["same bank reference", "second", "synthetic-duplicate-reference"],
  ] as const)("deduplicates %s pending drafts when selecting %s", (_label, selectedId, bankReference) => {
    const first = booking("first", { bankReference });
    const second = booking("second", { bankReference });
    const state = fixture([], { reviewQueue: [pending(first), pending(second)] });
    expect(state.reviewQueue).toHaveLength(2);
    const result = approve(state, choose(state, selectedId));

    expect(result).toMatchObject({ added: 1, duplicates: 0, changes: [] });
    expect(result.state.transactions).toEqual([
      expect.objectContaining({ id: second.id, occurrence: 1, amount: first.amount }),
    ]);
    expect(result.state.reviewQueue).toEqual([]);
  });

  it("declines an already completed ledger review instead of learning a stale second choice", () => {
    const state = fixture([booking("reviewed")]);
    const selected = choose(state, "reviewed");
    const approved = approve(state, selected).state;

    expect(approveReviewedBooking(approved, selected)).toBeUndefined();
    expect(approveReviewedBooking(approved, { ...selected, category: "Ausgehen" })).toBeUndefined();
    expect(approved.merchantRules?.[0].category).toBe("Shopping");
  });

  it("replaces a conflicting explicit merchant rule rather than retaining an inferred choice", () => {
    const first = booking("first", { category: "Sonstiges", categoryOverride: true });
    const second = booking("second", { category: "Sonstiges", categoryOverride: true, date: "2026-09-04" });
    const key = merchantRules.merchantRuleKey(first);
    const state = fixture([first, second], { merchantRules: [{ key, category: "Ausgehen" }] });
    const result = approve(state, choose(state, first.id));

    expect(result.state.merchantRules).toEqual([{ key, category: "Shopping" }]);
    expect(result.state.transactions.every((row) => row.category === "Shopping")).toBe(true);
    expect(result.state.reviewQueue).toEqual([]);
  });

  it("retains explicit rule precedence over inferred choices for unrelated merchants", () => {
    const inferred = booking("inferred", {
      description: "Testladen Südlicht",
      category: "Sonstiges",
      categoryOverride: true,
    });
    const other = booking("explicit", { description: inferred.description, date: "2026-09-04" });
    const key = merchantRules.merchantRuleKey(inferred);
    const state = fixture([booking("selected"), inferred, other], {
      merchantRules: [{ key, category: "Ausgehen" }],
    });
    expect(state.transactions[2].category).toBe("Restaurants");
    const result = approve(state, choose(state, "selected"));

    expect(result.state.transactions[1]).toBe(state.transactions[1]);
    expect(result.state.transactions[2]).toBe(state.transactions[2]);
    expect(result.state.merchantRules).toContainEqual({ key, category: "Restaurants" });
  });

  it("keeps a review open when mandatory merchant classification contradicts the chosen rule", () => {
    const row = booking("mandatory", { description: "Amazon" });
    const key = merchantRules.merchantRuleKey(row);
    const state = fixture([row], { merchantRules: [{ key, category: "Ausgehen" }] });
    const result = approve(state, choose(state, row.id, "Lebensmittel"));

    expect(result.state.transactions[0]).toMatchObject({ category: "Shopping", includeInPlan: false });
    expect(result.state.merchantRules).toEqual([{ key, category: "Lebensmittel" }]);
    expect(result.state.reviewQueue).toEqual([
      expect.objectContaining({
        id: row.id,
        message: "Widersprüchliche Händlerregel: Zuordnung prüfen.",
        draft: expect.objectContaining({ category: "Shopping" }),
      }),
    ]);
  });

  it("never mutates another state's ledger through a cached merchant index", () => {
    const original = fixture([booking("first"), booking("second", { description: "Testladen Südlicht" })]);
    const first = approve(original, choose(original, "first")).state;
    const changed = fixture(first.transactions.map((row) =>
      row.id === "second" ? { ...row, amount: -87, bankReference: "synthetic-new-state" } : row),
    { merchantRules: first.merchantRules });
    const result = approve(changed, choose(changed, "second", "Restaurants"));

    expect(result.state.transactions[1]).toMatchObject({ amount: -87, bankReference: "synthetic-new-state", category: "Restaurants" });
    expect(first.transactions[1].category).toBe("Prüfen");
    expect(original.transactions.every((row) => row.category === "Prüfen")).toBe(true);
  });

  it("includes newly queued merchant twins when a warmed state shares the same transaction array", () => {
    const state = fixture([
      booking("first"),
      booking("second", { description: "Testladen Südlicht" }),
    ]);
    const warmed = approve(state, choose(state, "first")).state;
    const imported = booking("pending-twin", { description: "Testladen Südlicht", date: "2026-09-04" });
    const normalized = queueLedgerReview({
      ...warmed,
      reviewQueue: [...warmed.reviewQueue!, pending(imported)],
    });
    const changed = { ...normalized, transactions: warmed.transactions };
    expect(changed.reviewQueue).not.toBe(warmed.reviewQueue);
    const result = approve(changed, choose(changed, "second"));

    expect(result.added).toBe(1);
    expect(result.state.transactions.map((row) => row.id)).toEqual(["first", "second", imported.id]);
    expect(result.state.reviewQueue).toEqual([]);
    expect(warmed.transactions).toHaveLength(2);
  });

  it("does not revive removed pending twins from a warmed cache sharing the transaction array", () => {
    const imported = booking("removed", { description: "Testladen Südlicht", date: "2026-09-04" });
    const state = fixture([
      booking("first"),
      booking("second", { description: "Testladen Südlicht" }),
    ], { reviewQueue: [pending(imported)] });
    const warmed = approve(state, choose(state, "first")).state;
    const changed = {
      ...warmed,
      reviewQueue: warmed.reviewQueue!.filter((item) => item.id !== imported.id),
    };
    expect(changed.transactions).toBe(warmed.transactions);
    const result = approve(changed, choose(changed, "second"));

    expect(result.added).toBe(0);
    expect(result.state.transactions.map((row) => row.id)).toEqual(["first", "second"]);
    expect(result.state.reviewQueue).toEqual([]);
  });

  it("preserves new explicit rules when a warmed cache shares the transaction array", () => {
    const state = fixture([
      booking("first"),
      booking("second", { description: "Testladen Südlicht" }),
    ]);
    const warmed = approve(state, choose(state, "first")).state;
    const addedRule = { key: "raiffeisen|testladen westlicht", category: "Restaurants" as const };
    const changed = { ...warmed, merchantRules: [...warmed.merchantRules!, addedRule] };
    expect(changed.transactions).toBe(warmed.transactions);
    expect(changed.reviewQueue).toBe(warmed.reviewQueue);
    const result = approve(changed, choose(changed, "second"));

    expect(result.state.merchantRules).toContainEqual(addedRule);
    expect(warmed.merchantRules).not.toContainEqual(addedRule);
  });

  it("bounds merchant-key and classification work after warming the immutable state index", () => {
    const state = fixture(Array.from({ length: 350 }, (_, index) =>
      booking(`row-${index}`, { description: `Synthetischer Testladen ${index}` })));
    const keys = vi.spyOn(merchantRules, "merchantRuleKey");
    const classifications = vi.spyOn(calc, "classify");
    const first = approveReviewedBooking(state, choose(state, "row-0"));
    expect(first).toBeDefined();
    if (!first) throw new Error("First ordinary approval must succeed");
    keys.mockClear();
    classifications.mockClear();

    const selected = choose(first.state, "row-1", "Restaurants");
    const second = approveReviewedBooking(first.state, selected);
    expect(second).toBeDefined();
    expect(keys.mock.calls.length).toBeLessThan(40);
    expect(classifications.mock.calls.length).toBeLessThan(40);
    keys.mockRestore();
    classifications.mockRestore();

    expect(second).toEqual(reference(first.state, selected));
    expect(second?.state.transactions[200]).toBe(state.transactions[200]);
    expect(first.state.transactions[1]).toBe(state.transactions[1]);
  });
});

describe("conservative booking review fallbacks", () => {
  it("declines mixed complete and amount-missing pending drafts", () => {
    const complete = booking("complete");
    const incomplete: ReviewItem = {
      kind: "booking",
      id: "incomplete",
      draft: { ...booking("incomplete"), amount: null },
      message: "Betrag fehlt",
    };
    const state = fixture([], { reviewQueue: [pending(complete), incomplete] });

    expect(approveReviewedBooking(state, choose(state, complete.id))).toBeUndefined();
    expect(state.transactions).toEqual([]);
    expect(state.reviewQueue).toHaveLength(2);
  });

  it("requires a complete booking review belonging to the current state", () => {
    const row = booking("missing");
    const selected = { ...row, category: "Shopping" as const, categoryOverride: true };
    expect(approveReviewedBooking(fixture(), selected)).toBeUndefined();
    expect(approveReviewedBooking({ ...fixture([row]), reviewQueue: [] }, selected)).toBeUndefined();
    const incomplete = fixture([], {
      reviewQueue: [{ kind: "booking", id: row.id, draft: { ...row, amount: null }, message: "Betrag fehlt" }],
    });
    expect(approveReviewedBooking(incomplete, selected)).toBeUndefined();
  });

  it("does not treat fixed-cost reviews as ordinary booking reviews", () => {
    const row = booking("fixed");
    const state = fixture([], {
      reviewQueue: [{
        kind: "fixed",
        id: row.id,
        change: {
          id: row.id,
          category: "Abonnements",
          month: "2026-09",
          previous: 20,
          amount: 24,
          bookings: [row],
        },
      }],
    });

    expect(approveReviewedBooking(state, { ...row, category: "Shopping", categoryOverride: true })).toBeUndefined();
  });

  it.each([
    "Prüfen", "Transfer", "Transfer intern", "Gehalt", "Einkommen", "Abonnements", "Leasing", "Urlaub",
    "Miete", "Energie & Nebenkosten", "Unterkunft", "Flugreisen",
  ] as const)("declines the complex or unresolved target category %s", (category) => {
    const state = fixture([booking("selected")]);
    expect(approveReviewedBooking(state, choose(state, "selected", category))).toBeUndefined();
  });

  it("requires an explicit valid category override", () => {
    const state = fixture([booking("selected")]);
    const selected = choose(state, "selected");
    expect(approveReviewedBooking(state, { ...selected, categoryOverride: false })).toBeUndefined();
    expect(approveReviewedBooking(state, { ...selected, categoryOverride: undefined })).toBeUndefined();
    expect(approveReviewedBooking(state, { ...selected, category: "Keine echte Kategorie" as Transaction["category"] })).toBeUndefined();
  });

  it.each([
    { description: "POS 24,00 AT D1 03.09. 18:00" },
    { description: "Verwendungszweck: BILLA", rawDetails: ["Verwendungszweck: SPAR"] },
    { description: "PayPal" },
  ])("declines incomplete or ambiguous merchant evidence: $description", (fields) => {
    const state = fixture([booking("selected", fields)]);
    expect(approveReviewedBooking(state, choose(state, "selected"))).toBeUndefined();
  });

  it("declines a merchant whose affected rows include a detected internal transfer", () => {
    const state = fixture([
      booking("selected"),
      booking("transfer", { date: "2026-09-04", sourceCategory: "Transfer intern" }),
    ]);
    expect(approveReviewedBooking(state, choose(state, "selected"))).toBeUndefined();
  });

  it("declines a merchant whose affected rows include fixed-cost assignments", () => {
    const selected = booking("selected");
    const state = fixture([
      selected,
      booking("contract", { date: "2026-09-04", category: "Abonnements", categoryOverride: true }),
    ], {
      merchantRules: [{ key: merchantRules.merchantRuleKey(selected), category: "Ausgehen" }],
    });
    expect(approveReviewedBooking(state, choose(state, "contract"))).toBeUndefined();
  });

  it("declines matching manual fixed receipts without overwriting their categories", () => {
    const row = booking("selected", { category: "Sonstiges", categoryOverride: true });
    const state = fixture([row], {
      merchantRules: [{ key: merchantRules.merchantRuleKey(row), category: "Ausgehen" }],
      fixedReceipts: [{
        key: "synthetic-manual-receipt",
        merchantKey: merchantRules.merchantRuleKey(row),
        date: "2026-08-03",
        category: "Abonnements",
        amount: -24,
      }],
    });
    const before = structuredClone(state);

    expect(approveReviewedBooking(state, choose(state, row.id))).toBeUndefined();
    expect(state).toEqual(before);
  });

  it.each([
    ["identical", "Shopping", "raiffeisen|testladen südlicht"],
    ["conflicting", "Ausgehen", "raiffeisen|testladen südlicht"],
    ["normalized conflicting", "Ausgehen", "Raiffeisen|Testladen Südlicht"],
  ] as const)("declines %s duplicate rules for an unrelated merchant", (_label, category, duplicateKey) => {
    const state = fixture([booking("selected")], {
      merchantRules: [
        { key: "raiffeisen|testladen südlicht", category: "Shopping" },
        { key: duplicateKey, category },
      ],
    });
    const before = structuredClone(state);

    expect(approveReviewedBooking(state, choose(state, "selected"))).toBeUndefined();
    expect(state).toEqual(before);
  });

  it("invalidates a warmed index when matching fixed receipts change but transactions do not", () => {
    const state = fixture([
      booking("first"),
      booking("second", { description: "Testladen Südlicht" }),
    ]);
    const warmed = approve(state, choose(state, "first")).state;
    const selected = choose(warmed, "second");
    const changed: AppState = {
      ...warmed,
      fixedReceipts: [{
        key: "synthetic-new-receipt",
        merchantKey: merchantRules.merchantRuleKey(selected),
        date: "2026-08-03",
        category: "Abonnements",
        amount: -24,
      }],
    };

    expect(changed.transactions).toBe(warmed.transactions);
    expect(approveReviewedBooking(changed, selected)).toBeUndefined();
  });

  it("declines newly conflicting rules even when a warmed cache shares the transaction array", () => {
    const state = fixture([
      booking("first"),
      booking("second", { description: "Testladen Südlicht" }),
    ]);
    const warmed = approve(state, choose(state, "first")).state;
    const changed = {
      ...warmed,
      merchantRules: [
        ...warmed.merchantRules!,
        { key: merchantRules.merchantRuleKey(warmed.transactions[0]), category: "Ausgehen" as const },
      ],
    };
    const before = structuredClone(changed);

    expect(changed.transactions).toBe(warmed.transactions);
    expect(approveReviewedBooking(changed, choose(changed, "second"))).toBeUndefined();
    expect(changed).toEqual(before);
  });

  it("either handles matching positive refunds equivalently or declines them", () => {
    const state = fixture([
      booking("debit"),
      booking("refund", { date: "2026-09-04", amount: 12 }),
    ]);
    expectEquivalent(state, choose(state, "debit"), false);
  });

  it("either preserves holiday recurrence and derived categories or falls back", () => {
    const state = fixture([
      booking("home", { date: "2026-08-20" }),
      booking("trip", { date: "2026-09-03" }),
      booking("foreign", { description: "Testladen Küstenlicht", date: "2026-09-04" }),
    ], { holidayRanges: [{ from: "2026-09-01", to: "2026-09-05" }] });
    const actual = expectEquivalent(state, choose(state, "home"), false);
    if (actual) expect(calc.actualBookings(actual.state)).toEqual(calc.actualBookings(reference(state, choose(state, "home")).state));
  });

  it.each([
    { from: "2026-08-01", to: "2026-08-05" },
    { from: "2026-10-01", to: "2026-10-05" },
  ])("declines pending bookings outside any configured holiday range: $from", (range) => {
    const draft = booking("pending", { date: "2026-09-06" });
    const state = fixture([], { reviewQueue: [pending(draft)], holidayRanges: [range] });

    expect(approveReviewedBooking(state, choose(state, draft.id))).toBeUndefined();
    expect(state.transactions).toEqual([]);
  });

  it("falls back when a new home merchant can reclassify an existing holiday purchase", () => {
    const history = booking("holiday", { date: "2026-08-03" });
    const draft = booking("home", { date: "2026-09-06" });
    const state = fixture([history], {
      reviewQueue: [pending(draft)],
      holidayRanges: [{ from: "2026-08-01", to: "2026-08-05" }],
    });
    expect(calc.actualBookings(state)[0].holidayRange).toBe(true);
    const selected = choose(state, draft.id);

    expect(approveReviewedBooking(state, selected)).toBeUndefined();
    const expected = reference(state, selected);
    expect(calc.actualBookings(expected.state)[0].holidayRange).toBeUndefined();
    expect(calc.actualBookings(expected.state)[0].category).toBe("Shopping");
  });

  it.each(["selected", "shared"])("either preserves shared accounting when choosing %s or falls back", (selectedId) => {
    const state = fixture([
      booking("selected"),
      booking("shared", { date: "2026-09-04", amount: -100, sharedWithRaphael: true }),
      booking("reimbursement", { description: "Raphael Piber", date: "2026-09-05", amount: 50 }),
    ]);
    const actual = expectEquivalent(state, choose(state, selectedId), false);
    if (actual) {
      expect(actual.state.transactions.find((row) => row.id === "shared")).toMatchObject({ amount: -100, sharedWithRaphael: true });
      expect(calc.actualBookings(actual.state)).toEqual(calc.actualBookings(reference(state, choose(state, selectedId)).state));
    }
  });

  it("either deduplicates a pending reimport of a stored booking or falls back", () => {
    const stored = booking("stored");
    const imported = { ...stored, id: "reimport" };
    const state = fixture([stored], { reviewQueue: [pending(imported)] });
    const result = expectEquivalent(state, choose(state, stored.id), false);
    if (result) expect(result.state.transactions).toHaveLength(1);
  });
});
