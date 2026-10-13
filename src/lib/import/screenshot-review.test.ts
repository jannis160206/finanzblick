import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { appStateSchema, transactionSchema, type AppState, type ReviewItem, type Transaction } from "@/lib/types";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "./review";
import { merchantRuleKey } from "./merchant-rules";
import type { StatementDraft, StatementResult } from "./statements";

const message = "Amex-Screenshot: Händler, Datum oder Eurobetrag nicht eindeutig lesbar – bitte mit dem Bild abgleichen.";
const merchant = "McDonalds 42 McDonalds Teststadt";
const dateLine = "20 Sep 2026 - RAPHAEL PIBER";

function booking(id: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    id, bank: "Amex", pocket: "AMEX Raphael", date: "2026-09-20",
    description: merchant, amount: -3.3, category: "Restaurants", includeInPlan: true,
    rawDetails: ["Amex-Screenshot", merchant, dateLine, "€ 3,30"],
    ...overrides,
  };
}

function oldDraft(id = "old", overrides: Partial<StatementDraft> = {}): StatementDraft {
  return {
    ...booking(id), date: "", pocket: "Amex", description: `${merchant} ${dateLine}`,
    category: "Prüfen", ...overrides,
  };
}

const review = (draft: StatementDraft, reason = message): ReviewItem =>
  ({ kind: "booking", id: draft.id, draft, message: reason });

function fixture(reviewQueue: ReviewItem[] = [], transactions: Transaction[] = []): AppState {
  return appStateSchema.parse({
    ...createSeed(), reviewQueue, transactions, merchantRules: [],
    fixedReceipts: [], fixedAmountDecisions: [], ignoredStatementKeys: [],
    accountSnapshots: [], pocketSnapshots: [], holidayRanges: [],
  });
}

function screenshot(rows: Transaction[] = [], drafts: StatementDraft[] = [], file = "synthetic.png"): StatementResult {
  return { source: "Amex", file, rows, skipped: drafts.length,
    issues: drafts.map((draft, index) => ({ file, line: index + 1, message, draft })) };
}

function redrop(state: AppState, results: StatementResult[]) {
  const prepared = prepareStatementImport(results, state);
  const committed = commitStatementImport(state, prepared.automatic, [], prepared.metadata);
  return { prepared, committed, state: queueLedgerReview(committed.state) };
}

function croppedOrder(id = "cropped"): StatementDraft {
  const description = "AMZN MKTP DE*TESTORDER9 AMZN.COM/BILL";
  return oldDraft(id, { description, amount: -100.84, pocket: "Amex",
    rawDetails: ["Amex-Screenshot", "AMZN MKTP DE*TESTORDER9", "AMZN.COM/BILL", "€ 100,84"] });
}

const ids = (state: AppState) => state.reviewQueue?.map((item) => item.id);

describe("conservative stale screenshot review reconciliation", () => {
  it("clears only the corrected row's warning and remembers its confirmed date across JSON/Excel and redrops", async () => {
    const results = [screenshot([], [croppedOrder()], "cropped.jpeg")];
    const initial = redrop(fixture(), results).state;
    initial.importStatus!.issues.push("other.csv: Andere Warnung");
    const before = (await parseWorkbook(await exportWorkbook(initial))).state;
    expect(before.reviewQueue).toEqual(initial.reviewQueue);
    const draft = before.reviewQueue?.find((item) => item.kind === "booking")?.draft;
    expect(draft?.date).toBe("");
    const corrected = transactionSchema.parse({
      ...draft, date: "2026-09-21", category: "Shopping", categoryOverride: true, manualCategory: true, reviewed: true,
    });
    const saved = queueLedgerReview(commitStatementImport(before, [corrected]).state);
    expect(saved.transactions).toHaveLength(1);
    expect(saved.reviewQueue).toEqual([]);
    expect(saved.importStatus?.issues).toEqual(["other.csv: Andere Warnung"]);
    const reloaded = appStateSchema.parse(JSON.parse(JSON.stringify(saved)));
    const restored = (await parseWorkbook(await exportWorkbook(reloaded))).state;
    for (const state of [reloaded, restored]) {
      const again = redrop(state, results);
      expect(again.prepared.automatic).toEqual([]);
      expect(again.prepared.review).toEqual([]);
      expect(again.prepared.issues).toEqual([]);
      expect(again.state.transactions).toEqual(state.transactions);
      expect(again.state.importStatus?.issues).toEqual(["other.csv: Andere Warnung"]);
    }
  });

  it("links all overlapping-file warnings to one existing legacy review without losing edits", () => {
    const old = croppedOrder();
    const state = fixture([review(old)]);
    state.importStatus = { imported: 0, issues: [`one.jpeg, Zeile 1: ${message}`] };
    const results = [screenshot([], [{ ...old, id: "one" }], "one.jpeg"),
      screenshot([], [{ ...old, id: "two" }], "two.jpeg")];
    const imported = redrop(state, results);
    expect(imported.prepared.review).toEqual([]);
    expect(imported.state.reviewQueue).toHaveLength(1);
    expect(imported.state.reviewQueue?.[0]).toMatchObject({ id: old.id, importIssues: [
      `one.jpeg, Zeile 1: ${message}`, `two.jpeg, Zeile 1: ${message}`,
    ] });
    const corrected = transactionSchema.parse({ ...old, date: "2026-09-21",
      category: "Shopping", manualCategory: true, categoryOverride: true, reviewed: true });
    expect(commitStatementImport(imported.state, [corrected]).state.importStatus?.issues).toEqual([]);
  });

  it("does not erase ambiguous legacy warnings belonging to other incomplete rows", () => {
    const one = croppedOrder("one");
    const two = oldDraft("two");
    const warnings = [`one.jpeg, Zeile 1: ${message}`, `two.jpeg, Zeile 2: ${message}`];
    const state = fixture([review(one), review(two)]);
    state.importStatus = { imported: 0, issues: warnings };
    const corrected = transactionSchema.parse({ ...one, date: "2026-09-21",
      category: "Shopping", manualCategory: true, categoryOverride: true, reviewed: true });
    expect(commitStatementImport(state, [corrected]).state.importStatus?.issues).toEqual(warnings);
  });

  it("clears an old unambiguous warning after the screenshot is reimported under a new filename", () => {
    const draft = croppedOrder();
    const state = fixture([review(draft)]);
    state.importStatus = { imported: 0, issues: [`old.jpeg, Zeile 1: ${message}`] };
    const imported = redrop(state, [screenshot([], [{ ...draft, id: "new" }], "renamed.jpeg")]).state;
    const corrected = transactionSchema.parse({ ...draft, date: "2026-09-21",
      category: "Shopping", manualCategory: true, categoryOverride: true, reviewed: true });
    expect(commitStatementImport(imported, [corrected]).state.importStatus?.issues).toEqual([]);
  });

  it.each([false, true])("keeps another uncertain OCR merchant and its linked warning until explicit confirmation (stored=%s)", (stored) => {
    const uncertain = (id: string, amount: number): StatementDraft => ({
      ...booking(id), pocket: "Amex", description: "SPAR Testmarkt", amount,
      rawDetails: ["Amex-Screenshot", "OCR-Händler unklar", "SPAR Testmarkt", "20 Sep 2026",
        `€ ${Math.abs(amount).toFixed(2).replace(".", ",")}`],
    });
    const first = uncertain("first", -12);
    const second = uncertain("second", -14);
    let state = redrop(fixture(), [screenshot([], [first, second])]).state;
    if (stored) state = queueLedgerReview({ ...state, transactions: [transactionSchema.parse(second)] });
    const choose = (draft: StatementDraft) => transactionSchema.parse({ ...draft,
      category: "Lebensmittel", manualCategory: true, categoryOverride: true, reviewed: true });
    state = queueLedgerReview(commitStatementImport(state, [choose(first)]).state);
    expect(state.transactions).toHaveLength(stored ? 2 : 1);
    expect(state.reviewQueue).toHaveLength(1);
    expect(state.reviewQueue?.[0]).toMatchObject({ id: second.id, importIssues: [`synthetic.png, Zeile 2: ${message}`] });
    expect(state.importStatus?.issues).toEqual([`synthetic.png, Zeile 2: ${message}`]);
    state = queueLedgerReview(commitStatementImport(state, [choose(second)]).state);
    expect(state.transactions).toHaveLength(2);
    expect(state.reviewQueue).toEqual([]);
    expect(state.importStatus?.issues).toEqual([]);
  });

  it.each([
    ["unconfirmed row", { reviewed: false }],
    ["changed amount", { amount: -101 }],
    ["different holder", { pocket: "AMEX Raphael" }],
    ["different order", { description: "AMZN MKTP DE*OTHERORDER AMZN.COM/BILL" }],
    ["different occurrence", { occurrence: 2 }],
    ["different reference", { bankReference: "other" }],
    ["uncertain merchant", { rawDetails: [...croppedOrder().rawDetails!, "OCR-Händler unklar"] }],
  ] satisfies [string, Partial<Transaction>][])("keeps the missing-date review for %s", (_, change) => {
    const corrected = transactionSchema.parse({ ...croppedOrder(), id: "saved", date: "2026-09-21",
      category: "Shopping", manualCategory: true, categoryOverride: true, reviewed: true, ...change });
    const result = redrop(fixture([], [corrected]), [screenshot([], [croppedOrder()])]);
    expect(result.prepared.review).toHaveLength(1);
    expect(result.prepared.issues).toHaveLength(1);
  });

  it("does not use an ordinary same-price purchase or conflicting confirmed dates to close a crop", () => {
    const corrected = transactionSchema.parse({ ...croppedOrder(), id: "saved", date: "2026-09-21",
      category: "Shopping", manualCategory: true, categoryOverride: true, reviewed: true });
    const conflicting = { ...corrected, id: "other-date", date: "2026-09-20" };
    expect(redrop(fixture([], [corrected, conflicting]), [screenshot([], [croppedOrder()])]).prepared.review).toHaveLength(1);
    const ordinary = { ...croppedOrder(), description: "SPAR", rawDetails: ["Amex-Screenshot", "SPAR", "€ 100,84"] };
    expect(redrop(fixture([], [{ ...corrected, ...ordinary, date: corrected.date, amount: -100.84 }]),
      [screenshot([], [ordinary])]).prepared.review).toHaveLength(1);
  });

  it("reconciles legacy date/holder and null-amount drafts without multiplying a genuinely cropped order", () => {
    const second = booking("new-second", { date: "2026-09-19", amount: -4.8,
      rawDetails: ["Amex-Screenshot", merchant, "19 Sep 2026 - RAPHAEL PIBER", "€ 4,80"] });
    const spar = booking("new-spar", { pocket: "Amex", description: "SPAR Testmarkt", date: "2026-09-15",
      amount: -9.68, category: "Lebensmittel",
      rawDetails: ["Amex-Screenshot", "SPAR Testmarkt", "15 Sep 2026", "€ 9,68"] });
    const cropped = oldDraft("cropped", { description: "AMAZON.DE*TESTORDER9", amount: -100.84,
      rawDetails: ["Amex-Screenshot", "AMAZON.DE*TESTORDER9", "€ 100,84"] });
    const repayment = oldDraft("repayment", { amount: 4043.77,
      description: "ZAHLUNG/ÜBERWEISUNG ERHALTEN BESTEN DANK WAS AS",
      rawDetails: ["Amex-Screenshot", "ZAHLUNG/ÜBERWEISUNG ERHALTEN BESTEN DANK WAS AS", "?? Sep ????", "-€ 4.043,77"] });
    const state = fixture([
      review(oldDraft()),
      review({ ...second, id: "old-second", pocket: "Amex", date: "",
        description: `${merchant} 19 Sep 2026 - RAPHAEL PIBER` }),
      review({ ...spar, id: "old-spar", amount: null }),
      review(repayment), review(cropped),
    ]);
    state.importStatus = { imported: 0, issues: ["synthetic.png, Zeile 2: Alte OCR-Warnung", "other.csv: Andere Warnung"] };
    const before = structuredClone(state);
    const results = [screenshot([booking("new"), second, spar], [{ ...cropped, id: "new-cropped" }])];
    const result = redrop(state, results);

    expect(state).toEqual(before);
    expect(result.prepared.automatic).toHaveLength(3);
    expect(result.committed.added).toBe(3);
    expect(result.state.transactions).toHaveLength(3);
    expect(ids(result.state)).toEqual(["cropped"]);
    expect(result.state.reviewQueue?.[0]).toMatchObject({ draft: { date: "", amount: -100.84 } });
    expect(result.state.importStatus).toEqual({ imported: 3,
      issues: ["synthetic.png, Zeile 2: Alte OCR-Warnung", "other.csv: Andere Warnung", `synthetic.png, Zeile 1: ${message}`] });

    const again = redrop(result.state, [screenshot(results[0].rows.map((row) => ({ ...row, id: `again-${row.id}` })),
      [{ ...cropped, id: "again-cropped" }])]);
    expect(again.committed.added).toBe(0);
    expect(again.prepared.duplicates).toBe(3);
    expect(again.state.transactions).toEqual(result.state.transactions);
    expect(ids(again.state)).toEqual(["cropped"]);
  });

  it("carries matching evidence through prepare even when a stored PDF already deduplicates every new row", () => {
    const stored = booking("stored-pdf", { bank: "American Express", rawDetails: undefined, includeInPlan: false });
    const state = fixture([review(oldDraft())], [stored]);
    const result = redrop(state, [screenshot([booking("new")])]);

    expect(result.prepared.automatic).toEqual([]);
    expect(result.prepared.duplicates).toBe(1);
    expect(result.committed.added).toBe(0);
    expect(result.state.transactions).toEqual([stored]);
    expect(ids(result.state)).toEqual([]);
  });

  it("repairs an old incomplete queue against an already stored good screenshot without deleting ledger bookings", () => {
    const good = booking("stored", { includeInPlan: false });
    const state = fixture([review(oldDraft())], [good]);
    const result = queueLedgerReview(state);
    expect(result.transactions).toEqual([good]);
    expect(ids(result)).toEqual([]);
  });

  it.each([
    ["20 Sep 2026 - RAPHAEL PIBER", "AMEX Raphael"],
    ["20 Sep 2026 • RAPHAEL PIBER", "AMEX Raphael"],
    ["20 Sep 2026 · RAPHAEL PIBER", "AMEX Raphael"],
    ["20 Sep 2026 – RAPHAEL PIBER", "AMEX Raphael"],
    ["20 Sep 2026 • JANNIS BRÜHL", "Amex"],
  ])("uses the parser's holder interpretation for %s", (date, pocket) => {
    const rawDetails = ["Amex-Screenshot", merchant, date, "€ 3,30"];
    const old = oldDraft("old", { description: `${merchant} ${date}`, rawDetails });
    const next = booking("new", { pocket, rawDetails });
    const result = redrop(fixture([review(old)]), [screenshot([next])]);
    expect(ids(result.state)).toEqual([]);
    expect(result.state.transactions).toMatchObject([{ id: "new", pocket }]);
  });

  it("replaces an incomplete draft with exactly one complete still-uncategorized review", () => {
    const unknown = booking("new-unknown", { description: "Nordlicht Testatelier", category: "Prüfen",
      rawDetails: ["Amex-Screenshot", "Nordlicht Testatelier", dateLine, "€ 3,30"] });
    const old = { ...unknown, id: "old-unknown", date: "", pocket: "Amex", description: `Nordlicht Testatelier ${dateLine}` };
    const result = redrop(fixture([review(old)]), [screenshot([unknown])]);

    expect(result.state.transactions).toEqual([]);
    expect(ids(result.state)).toEqual(["new-unknown"]);
    expect(result.state.reviewQueue?.[0]).toMatchObject({ draft: { date: "2026-09-20", pocket: "AMEX Raphael" } });
    expect(ids(redrop(result.state, [screenshot([{ ...unknown, id: "redropped" }])]).state)).toEqual(["new-unknown"]);
  });

  it.each([
    ["other bank", { bank: "Revolut" }],
    ["other holder", { pocket: "AMEX Jannis" }],
    ["unknown holder", { rawDetails: ["Amex-Screenshot", merchant, "20 Sep 2026 - UNKNOWN PERSON", "€ 3,30"] }],
    ["other date", { date: "2026-09-21", amount: null }],
    ["other signed amount", { amount: 3.3 }],
    ["other amount", { amount: -3.31 }],
    ["other merchant", { description: "Anderer Testhändler" }],
    ["only amount", { description: "", rawDetails: ["Amex-Screenshot", "€ 3,30"] }],
    ["only merchant", { amount: null, rawDetails: ["Amex-Screenshot", merchant] }],
    ["missing date", { description: merchant, rawDetails: ["Amex-Screenshot", merchant, "€ 3,30"] }],
    ["ambiguous amounts", { rawDetails: ["Amex-Screenshot", merchant, dateLine, "€ 3,30", "€ 4,30"] }],
    ["ambiguous dates", { rawDetails: ["Amex-Screenshot", merchant, dateLine, "21 Sep 2026", "€ 3,30"] }],
    ["uncertain merchant", { rawDetails: ["Amex-Screenshot", "OCR-Händler unklar", merchant, dateLine, "€ 3,30"] }],
    ["other occurrence", { occurrence: 2 }],
    ["other bank reference", { bankReference: "synthetic-other-reference" }],
    ["ordinary non-OCR review", { rawDetails: undefined }],
  ] satisfies [string, Partial<StatementDraft>][])("retains %s instead of guessing", (_, overrides) => {
    const old = oldDraft("retained", overrides);
    // Non-screenshot persisted drafts require an ordinary valid date and merchant.
    if (!old.rawDetails?.includes("Amex-Screenshot") || old.bank !== "Amex") {
      old.date = "2026-09-20";
      old.amount = null;
    }
    const result = redrop(fixture([review(old, "Kategorie noch offen oder widersprüchlich.")]), [screenshot([booking("new")])]);
    expect(ids(result.state)).toContain("retained");
    expect(result.state.transactions).toHaveLength(1);
  });

  it.each([
    { reviewed: true },
    { manualCategory: true },
    { categoryOverride: true },
    { fixedCost: false },
    { merchantAlias: "Manuell bearbeitet" },
  ] satisfies Partial<StatementDraft>[])("protects explicit user decisions %j, including edits after preparation", (choice) => {
    const state = fixture([review(oldDraft())]);
    const prepared = prepareStatementImport([screenshot([booking("new")])], state);
    const current = fixture([review(oldDraft("old", choice))]);
    const committed = commitStatementImport(current, prepared.automatic, [], prepared.metadata);
    expect(ids(queueLedgerReview(committed.state))).toContain("old");
  });

  it("rechecks the current queue facts instead of blindly applying prepared IDs", () => {
    const state = fixture([review(oldDraft())]);
    const prepared = prepareStatementImport([screenshot([booking("new")])], state);
    const current = fixture([review(oldDraft("old", { amount: -19 }))]);
    const committed = commitStatementImport(current, prepared.automatic, [], prepared.metadata);
    expect(ids(queueLedgerReview(committed.state))).toEqual(["old"]);
  });

  it("reconciles untouched drafts before the repair pass applies inherited merchant choices", () => {
    const old = oldDraft();
    const state = fixture([review(old)]);
    state.merchantRules = [{ key: merchantRuleKey(old), category: "Restaurants" }];
    const result = redrop(state, [screenshot([booking("new")])]);
    expect(ids(result.state)).toEqual([]);
    expect(result.state.transactions).toHaveLength(1);
  });

  it("keeps confirmed user-corrected bookings even if their original OCR details were incomplete", () => {
    const corrected = booking("corrected", { date: "2026-09-21", amount: -8.5,
      category: "Shopping", reviewed: true, manualCategory: true, categoryOverride: true });
    const state = fixture([review(corrected)], [corrected]);
    const result = redrop(state, [screenshot([booking("new")])]);
    expect(result.state.transactions).toContainEqual(corrected);
    expect(result.state.transactions).toHaveLength(2);
  });

  it("does not treat a different Amazon order code as matching bank evidence", () => {
    const old = oldDraft("old-order", { description: "AMAZON.DE*TESTORDER1", pocket: "Amex", date: "2026-09-20", amount: null,
      rawDetails: ["Amex-Screenshot", "AMAZON.DE*TESTORDER1", "20 Sep 2026", "€ 3,30"] });
    const next = booking("new-order", { description: "AMAZON.DE*TESTORDER2", pocket: "Amex",
      rawDetails: ["Amex-Screenshot", "AMAZON.DE*TESTORDER2", "20 Sep 2026", "€ 3,30"] });
    expect(ids(redrop(fixture([review(old)]), [screenshot([next])]).state)).toContain("old-order");
  });

  it.each([
    ["outgoing payment", -20, "€ 20,00", {}],
    ["unconfirmed sign", 20, "€ 20,00", {}],
    ["missing amount", null, "-€ 20,00", {}],
    ["manually reviewed payment", 20, "-€ 20,00", { reviewed: true }],
    ["manually categorized payment", 20, "-€ 20,00", { manualCategory: true }],
  ] satisfies [string, number | null, string, Partial<StatementDraft>][])("keeps %s rather than discarding uncertain repayments", (_, amount, rawAmount, choice) => {
    const description = "ZAHLUNG/ÜBERWEISUNG ERHALTEN BESTEN DANK";
    const old = oldDraft("payment", { description, amount, ...choice,
      rawDetails: ["Amex-Screenshot", description, "?? Sep ????", rawAmount] });
    expect(ids(redrop(fixture([review(old)]), [screenshot()]).state)).toContain("payment");
  });
});
