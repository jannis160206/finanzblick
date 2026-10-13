import { expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "./review";
import { IMPORT_RESULT_RETENTION_MS, importResultSchema } from "./result-schema";
import { createStatementJobOutcome, reconcileImportResultReviews, retainImportResults } from "./results";
import { parseStatementCsv } from "./statements";

const first = "da6d4f78-0092-46e0-8603-0d65316bf735";
const second = "e04b01e4-3262-40f1-b3ae-572736bc744d";
const empty = (): AppState => ({ ...createSeed(), transactions: [], reviewQueue: [], fixedReceipts: [],
  financeRows: [], plannedOneOffs: [], plannedOneOffsSeeded: true });
const booking = (id = "row"): Transaction => ({ id, date: "2026-10-05", bank: "Raiffeisen",
  pocket: "Raiffeisen Giro", description: "SPAR", amount: -12, category: "Lebensmittel", includeInPlan: true });

it("records zero inserted for an unsupported technically completed parse, without a success claim", () => {
  const state = empty();
  const prepared = prepareStatementImport([{ uploadId: first, source: null, file: "unknown.pdf",
    rows: [], skipped: 1, issues: [{ file: "unknown.pdf", message: "PDF-Anbieter nicht erkannt." }] }], state);
  const saved = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
  expect(saved.importResults).toMatchObject([{ uploadId: first, status: "unsupported",
    inserted: 0, updated: 0, duplicates: 0, review: 0, skipped: 1,
    issues: [{ action: "reupload" }] }]);
});

it("persists a browser parser failure without fabricating a skipped transaction row", () => {
  const prepared = prepareStatementImport([{ uploadId: first, source: null, file: "broken.csv",
    rows: [], skipped: 0, failureCode: "PARSE_DAMAGED",
    issues: [{ file: "broken.csv", message: "Datei beschädigt." }] }], empty());
  const state = commitStatementImport(empty(), [], [], prepared.metadata).state;
  expect(state.importResults).toMatchObject([{ status: "failed", errorCode: "PARSE_DAMAGED",
    inserted: 0, updated: 0, duplicates: 0, review: 0, skipped: 0 }]);
});

it("extracts only an authoritative UUID result for a worker checkpoint and never guesses missing counts", () => {
  const prepared = prepareStatementImport([{ uploadId: first, source: "Raiffeisen", file: "worker.csv",
    rows: [booking()], skipped: 0, issues: [] }], empty());
  const state = commitStatementImport(empty(), prepared.automatic, [], prepared.metadata).state;
  expect(createStatementJobOutcome(first, state)).toEqual(state.importResults![0]);
  expect(createStatementJobOutcome(first, state)).toMatchObject({ inserted: 1, updated: 0, duplicates: 0 });
  expect(() => createStatementJobOutcome(second, state)).toThrow("Kein bestätigtes Ergebnis");
  expect(() => createStatementJobOutcome(first, empty())).toThrow("Kein bestätigtes Ergebnis");
});

it("retains non-screenshot issue.draft and requires an explicit source decision before promotion", () => {
  const state = empty();
  const prepared = prepareStatementImport([{ uploadId: first, source: "Raiffeisen", file: "repair.csv",
    rows: [], skipped: 1, issues: [{ file: "repair.csv", line: 2, message: "Betrag fehlt.",
      draft: { ...booking(), amount: null } }] }], state);
  expect(prepared.review).toHaveLength(1);
  const saved = commitStatementImport(state, [], [], prepared.metadata).state;
  const parsed = appStateSchema.parse(saved);
  expect(parsed.importResults).toEqual(saved.importResults);
  expect(parsed.reviewQueue).toEqual(saved.reviewQueue);
  const item = saved.reviewQueue![0];
  expect(item).toMatchObject({ kind: "booking", sourceRepair: true, importUploadId: first });
  expect(saved.importResults![0]).toMatchObject({ inserted: 0, review: 1, skipped: 0 });
  if (item.kind !== "booking") throw new Error("Expected repair draft");
  const filled = { ...saved, reviewQueue: [{ ...item, draft: { ...item.draft, amount: -12 } }] };
  expect(queueLedgerReview(filled).transactions).toHaveLength(0);
  const confirmed = { ...item.draft, amount: -12, category: "Lebensmittel" as const,
    manualCategory: true, categoryOverride: true, reviewed: true, includeInPlan: true };
  const repaired = commitStatementImport(saved, [confirmed]).state;
  expect(repaired.transactions).toHaveLength(1);
  expect(repaired.reviewQueue).toHaveLength(0);
  expect(repaired.importResults![0]).toMatchObject({ inserted: 1, review: 0, issues: [] });
});

it("counts a reconciled Amex source update separately from inserted and duplicates", () => {
  const original: Transaction = { ...booking(), bank: "Amex", pocket: "AMEX Jannis",
    description: "AMAZON.DE*ABC12345", amount: -12, amexSource: "screenshot", amexStatus: "pending",
    rawDetails: ["Amex-Screenshot"] };
  const state = { ...empty(), transactions: [original] };
  const incoming = { ...original, id: "pdf", amount: -13, amexSource: "pdf" as const,
    amexStatus: "posted" as const, rawDetails: ["Amex-PDF"] };
  const prepared = prepareStatementImport([{ uploadId: first, source: "Amex", file: "amex.pdf",
    rows: [incoming], skipped: 0, issues: [] }], state);
  const saved = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
  expect(saved.transactions).toHaveLength(1);
  expect(saved.transactions[0]).toMatchObject({ id: original.id, amount: -13 });
  expect(saved.importResults).toMatchObject([{ inserted: 0, updated: 1, duplicates: 0 }]);
});

it("does not clear another upload's same-filename warning when one draft is corrected or reuploaded", () => {
  let state = empty();
  const issue = { file: "same.csv", message: "Betrag fehlt.", draft: { ...booking(), amount: null } };
  for (const uploadId of [first, second]) {
    const prepared = prepareStatementImport([{ uploadId, source: "Raiffeisen", file: "same.csv",
      rows: [], skipped: 1, issues: [issue] }], state);
    state = commitStatementImport(state, [], [], prepared.metadata).state;
  }
  expect(state.reviewQueue).toHaveLength(2);
  expect(new Set(state.reviewQueue!.map((item) => item.id)).size).toBe(2);
  const original = state.reviewQueue!.find((item) => item.importUploadId === first)!;
  if (original.kind !== "booking") throw new Error("Expected repair");
  state = commitStatementImport(state, [{ ...original.draft, amount: -12,
    manualCategory: true, categoryOverride: true, reviewed: true }]).state;
  expect(state.reviewQueue).toHaveLength(1);
  expect(state.reviewQueue![0]).toMatchObject({ importUploadId: second, sourceRepair: true });
  expect(state.importResults!.find((entry) => entry.uploadId === second)).toMatchObject({
    review: 1, issues: [{ message: "Betrag fehlt." }],
  });
  expect(state.importStatus!.issues).toEqual(["same.csv: Betrag fehlt."]);
  const prepared = prepareStatementImport([{ uploadId: crypto.randomUUID(), source: "Raiffeisen",
    file: "same.csv", rows: [booking("new")], skipped: 0, issues: [] }], state);
  state = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
  expect(state.reviewQueue).toHaveLength(1);
  expect(state.importStatus!.issues).toEqual(["same.csv: Betrag fehlt."]);
});

it("keeps missing source dates blank and preserves foreign currency evidence without any inferred FX", () => {
  const prepared = prepareStatementImport([{ uploadId: first, source: "Raiffeisen", file: "repair.csv",
    rows: [], skipped: 2, issues: [
      { file: "repair.csv", line: 2, message: "Datum fehlt.", draft: { ...booking("missing-date"), date: "" } },
      { file: "repair.csv", line: 3, message: "Fremdwährung USD: nicht als Euro importiert.",
        action: "reupload", reason: "foreign-currency",
        draft: { ...booking("fx"), amount: null, pocket: "Raiffeisen Giro (USD)" } },
    ] }], empty());
  const state = commitStatementImport(empty(), [], [], prepared.metadata).state;
  expect(appStateSchema.parse(state).reviewQueue).toHaveLength(1);
  expect(state.transactions).toEqual([]);
  expect(state.reviewQueue![0]).toMatchObject({ kind: "booking", draft: { date: "" }, sourceRepair: true });
  expect(state.importResults![0]).toMatchObject({ inserted: 0, review: 1, skipped: 1,
    issues: [{ action: "correct" }, { action: "reupload", reason: "foreign-currency",
      evidence: expect.stringContaining("USD") }] });
  expect(state.importResults![0].issues[1].reviewId).toBeUndefined();
});

it("bounds outcome metadata by age and count while leaving actionable repair drafts intact", () => {
  const now = Date.now();
  const outcome = importResultSchema.parse({ uploadId: first, name: "test.csv", completedAt: now,
    status: "imported", inserted: 0, updated: 0, duplicates: 1, review: 0, skipped: 0, issues: [] });
  const results = Array.from({ length: 25 }, (_, index) => ({
    ...outcome, uploadId: crypto.randomUUID(), completedAt: now - index,
  }));
  expect(retainImportResults([...results, { ...outcome, completedAt: now - IMPORT_RESULT_RETENTION_MS }], now)).toHaveLength(20);
  expect(retainImportResults([{ ...outcome, completedAt: now - IMPORT_RESULT_RETENTION_MS }], now)).toEqual([]);
});

it("preserves manual authority and stable fingerprints while reporting a duplicate", () => {
  const original = { ...booking(), category: "Shopping" as const, categoryOverride: true,
    manualCategory: true, reviewed: true, is_locked: true, merchantAlias: "Mein Händler",
    merchantNameConfirmed: true };
  const state = { ...empty(), transactions: [original] };
  const prepared = prepareStatementImport([{ uploadId: first, source: "Raiffeisen", file: "manual.csv",
    rows: [booking("new-id")], skipped: 0, issues: [] }], state);
  const saved = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
  expect(saved.transactions).toEqual([original]);
  expect(saved.importResults).toMatchObject([{ inserted: 0, updated: 0, duplicates: 1, review: 0 }]);
});

it("keeps row outcomes assigned to their upload when a fixed-price review spans multiple files", () => {
  const state = { ...empty(), financeRows: [{ id: "plan", kind: "fixed" as const, label: "Versicherungen",
    planCategory: "Versicherungen" as const, values: { "2026-10": 60 } }] };
  const insurance: Transaction = { ...booking(), description: "ALLIANZ ELEMENTAR Versicherungs AG Vertrag 4711",
    amount: -65, category: "Versicherungen", categoryOverride: true };
  const prepared = prepareStatementImport([
    { uploadId: first, source: "Raiffeisen", file: "same.csv", rows: [insurance], skipped: 0, issues: [] },
    { uploadId: second, source: "Raiffeisen", file: "same.csv", rows: [{ ...insurance, id: "second", date: "2026-10-06" }],
      skipped: 0, issues: [] },
  ], state);
  expect(prepared.review).toHaveLength(1);
  let saved = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
  expect(saved.importResults).toMatchObject([{ review: 1 }, { review: 1 }]);
  expect(appStateSchema.parse(saved).reviewQueue).toMatchObject([{
    importUploadIds: { [insurance.id]: first, second },
  }]);
  const change = saved.reviewQueue![0];
  if (change.kind !== "fixed") throw new Error("Expected fixed review");
  saved = commitStatementImport(saved, [], [{ change: change.change, accept: false }]).state;
  expect(saved.reviewQueue).toEqual([]);
  expect(saved.importResults).toMatchObject([{ inserted: 1, review: 0 }, { inserted: 1, review: 0 }]);
});

it("merges successive uploads into a fixed review without losing older bookings or their UUID counters", () => {
  let state: AppState = { ...empty(), financeRows: [{ id: "plan", kind: "fixed", label: "Versicherungen",
    planCategory: "Versicherungen", values: { "2026-10": 60 } }] };
  for (const [id, uploadId, date] of [["old", first, "2026-10-05"], ["new", second, "2026-10-06"]]) {
    const prepared = prepareStatementImport([{ uploadId, source: "Raiffeisen", file: "same.csv",
      rows: [{ ...booking(id), date, description: "ALLIANZ ELEMENTAR Versicherungs AG Vertrag 4711",
        amount: -65, category: "Versicherungen", categoryOverride: true }], skipped: 0, issues: [] }], state);
    state = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
  }
  expect(state.reviewQueue).toHaveLength(1);
  const item = state.reviewQueue![0];
  if (item.kind !== "fixed") throw new Error("Expected fixed review");
  expect(item.change.bookings).toHaveLength(2);
  expect(appStateSchema.parse(state).reviewQueue).toMatchObject([{ importUploadIds: { old: first, new: second } }]);
  expect(state.importResults).toEqual(expect.arrayContaining([
    expect.objectContaining({ uploadId: first, review: 1, skipped: 0, duplicates: 0 }),
    expect.objectContaining({ uploadId: second, review: 1, skipped: 0, duplicates: 0 }),
  ]));
  state = commitStatementImport(state, [], [{ change: item.change, accept: false }]).state;
  for (const uploadId of [first, second]) expect(state.importResults!.find((result) => result.uploadId === uploadId))
    .toMatchObject({ review: 0, inserted: 1, skipped: 0, duplicates: 0 });
});

it("retains current manual facts and original UUID ownership when stale fixed-review metadata is merged", () => {
  const original: Transaction = { ...booking("manual"), merchantAlias: "Mein Vertrag", merchantNameConfirmed: true,
    manualCategory: true, categoryOverride: true, is_locked: true, sharedPaidAmount: 10, sharedRepaymentFor: "purchase" };
  const change = { id: "group", category: "Versicherungen" as const, month: "2026-10", previous: 10, amount: 12, bookings: [original] };
  const state: AppState = { ...empty(), reviewQueue: [{ kind: "fixed", id: change.id, change,
    importUploadIds: { manual: first } }] };
  const saved = commitStatementImport(state, [], [], { reviewQueue: [{ kind: "fixed", id: change.id,
    importUploadIds: { manual: second }, change: { ...change, bookings: [booking("manual")] } }] }).state;
  expect(appStateSchema.parse(saved).reviewQueue).toMatchObject([{
    importUploadIds: { manual: first }, change: { bookings: [original] },
  }]);
});

it("counts a discarded unmatched review as skipped, and only an actual persisted match as duplicate", () => {
  const prepared = prepareStatementImport([{ uploadId: first, source: "Raiffeisen", file: "repair.csv",
    rows: [], skipped: 1, issues: [{ file: "repair.csv", message: "Betrag fehlt.",
      draft: { ...booking(), amount: null } }] }], empty());
  const before = commitStatementImport(empty(), [], [], prepared.metadata).state;
  expect(reconcileImportResultReviews(before, { ...before, reviewQueue: [] })).toMatchObject([{
    inserted: 0, updated: 0, duplicates: 0, skipped: 1, review: 0, status: "with-warnings",
  }]);
  const row = booking();
  const outcome = { ...before.importResults![0], issues: [] };
  const complete = { ...before, transactions: [row], importResults: [outcome],
    reviewQueue: [{ kind: "booking" as const, id: "review", importUploadId: first, draft: { ...row, id: "other-id" }, message: "Prüfen" }] };
  expect(reconcileImportResultReviews(complete, { ...complete, reviewQueue: [] })).toMatchObject([{
    inserted: 0, updated: 0, duplicates: 1, skipped: 0, review: 0,
  }]);
});

it("attributes partial mixed fixed-review removal to only the owning upload", () => {
  const a = booking("a"), b = { ...booking("b"), date: "2026-10-06" };
  const outcome = importResultSchema.parse({ uploadId: first, name: "same.csv", completedAt: Date.now(),
    status: "with-warnings", inserted: 0, updated: 0, duplicates: 0, review: 1, skipped: 0, issues: [] });
  const before: AppState = { ...empty(), importResults: [outcome, { ...outcome, uploadId: second }], reviewQueue: [{
    kind: "fixed", id: "group", importUploadIds: { a: first, b: second },
    change: { id: "group", category: "Versicherungen", month: "2026-10", previous: 10, amount: 12, bookings: [a, b] },
  }] };
  const after: AppState = { ...before, transactions: [a], reviewQueue: [{
    kind: "booking", id: b.id, draft: b, importUploadId: second, message: "Weiter prüfen",
  }] };
  expect(reconcileImportResultReviews(before, after)).toMatchObject([
    { uploadId: first, inserted: 1, review: 0, skipped: 0 },
    { uploadId: second, inserted: 0, review: 1, skipped: 0 },
  ]);
  expect(reconcileImportResultReviews(before, { ...after, transactions: [] })).toMatchObject([
    { uploadId: first, inserted: 0, duplicates: 0, review: 0, skipped: 1 },
    { uploadId: second, inserted: 0, review: 1, skipped: 0 },
  ]);
});

it("preserves only remaining fixed-review provenance after a single booking is manually approved", () => {
  const initial: AppState = { ...empty(), financeRows: [{ id: "plan", kind: "fixed", label: "Versicherungen",
    planCategory: "Versicherungen", values: { "2026-10": 60 } }] };
  const rows = ["a", "b"].map((id, index): Transaction => ({ ...booking(id), date: `2026-10-0${5 + index}`,
    description: "ALLIANZ ELEMENTAR Versicherungs AG Vertrag 4711", amount: -65,
    category: "Versicherungen", categoryOverride: true }));
  const prepared = prepareStatementImport(rows.map((row, index) => ({
    uploadId: index ? second : first, source: "Raiffeisen" as const, file: "same.csv",
    rows: [row], skipped: 0, issues: [],
  })), initial);
  let state = commitStatementImport(initial, prepared.automatic, [], prepared.metadata).state;
  state = commitStatementImport(state, [{ ...rows[0], fixedCost: false, reviewed: true, manualCategory: true }]).state;
  expect(appStateSchema.parse(state).reviewQueue).toMatchObject([{ kind: "fixed", importUploadIds: { b: second } }]);
  expect(state.reviewQueue![0].kind === "fixed" && state.reviewQueue![0].importUploadIds).not.toHaveProperty("a");
  expect(state.importResults!.find((result) => result.uploadId === first)).toMatchObject({ inserted: 1, review: 0 });
  expect(state.importResults!.find((result) => result.uploadId === second)).toMatchObject({ inserted: 0, review: 1 });
});

it("discards only an oversized unpersistable draft and retains valid source rows and bounded evidence", () => {
  const parsed = parseStatementCsv("Raiffeisen\nBuchungsdatum;Verwendungszweck/Text;Betrag\n2026-10-05;SPAR;-12,00\n2026-10-06;" +
    "X".repeat(1001) + ";-5,00", "oversized.csv");
  expect(parsed.rows).toHaveLength(1);
  expect(parsed.issues[0]).toMatchObject({ action: "reupload", reason: "invalid-repair-draft" });
  expect(parsed.issues[0].draft).toBeUndefined();
  const prepared = prepareStatementImport([{ ...parsed, uploadId: first }], empty());
  const state = commitStatementImport(empty(), prepared.automatic, [], prepared.metadata).state;
  expect(appStateSchema.safeParse(state).success).toBe(true);
  expect(state.transactions).toHaveLength(1);
  expect(state.reviewQueue).toEqual([]);
  expect(state.importResults).toMatchObject([{ inserted: 1, review: 0, skipped: 1, duplicates: 0,
    issues: [{ action: "reupload", reason: "invalid-repair-draft" }] }]);
  expect(state.importResults![0].issues[0].evidence!.length).toBeLessThanOrEqual(2000);
});

it("rejects an external invalid draft before review persistence without relying on parser admission", () => {
  const prepared = prepareStatementImport([{ uploadId: first, source: "Raiffeisen", file: "external.pdf",
    rows: [booking()], skipped: 1, issues: [{ file: "external.pdf", message: "Source " + "X".repeat(5000),
      draft: { ...booking("bad"), description: "X".repeat(1001) } }] }], empty());
  const state = commitStatementImport(empty(), prepared.automatic, [], prepared.metadata).state;
  expect(appStateSchema.safeParse(state).success).toBe(true);
  expect(prepared.review).toEqual([]);
  expect(state.importResults).toMatchObject([{ inserted: 1, skipped: 1, review: 0,
    issues: [{ action: "reupload", reason: "invalid-repair-draft" }] }]);
  expect(state.importResults![0].issues[0].message.length).toBe(2000);
});

it.each(["foreign-currency", "invalid-repair-draft"] as const)("uses typed nonrepairability %s even without a currency keyword", (reason) => {
  const prepared = prepareStatementImport([{ uploadId: first, source: "Raiffeisen", file: "foreign.csv",
    rows: [], skipped: 1, issues: [{ file: "foreign.csv", message: "Unsupported source unit.",
      reason, draft: { ...booking(), amount: -12, pocket: "Giro (USD)" } }] }], empty());
  const state = commitStatementImport(empty(), [], [], prepared.metadata).state;
  expect(prepared.review).toEqual([]);
  expect(state.reviewQueue).toEqual([]);
  expect(state.importResults).toMatchObject([{ inserted: 0, review: 0, skipped: 1,
    issues: [{ action: "reupload", reason, evidence: expect.stringContaining("-12") }] }]);
});

it("does not let a category decision silently authorize another complete external repair draft", () => {
  let state = empty();
  const prepared = prepareStatementImport([{ uploadId: first, source: "Raiffeisen", file: "repair.csv",
    rows: [], skipped: 1, issues: [{ file: "repair.csv", message: "Buchungsdaten prüfen.", draft: booking("repair") }] }], state);
  state = commitStatementImport(state, [], [], prepared.metadata).state;
  state = commitStatementImport(state, [{ ...booking("another"), date: "2026-10-06", categoryOverride: true,
    manualCategory: true, reviewed: true }]).state;
  expect(state.reviewQueue).toHaveLength(1);
  expect(state.transactions).toHaveLength(1);
  expect(state.reviewQueue![0]).toMatchObject({ kind: "booking", sourceRepair: true });
});

it("updates every UUID explicitly linked to a shared screenshot repair when it is approved", () => {
  let state = empty();
  const draft = { ...booking("shared-screenshot"), bank: "Amex", pocket: "AMEX Jannis",
    rawDetails: ["Amex-Screenshot", "SPAR"], amount: null };
  for (const uploadId of [first, second]) {
    const prepared = prepareStatementImport([{ uploadId, source: "Amex", file: "same.jpg", rows: [],
      skipped: 1, issues: [{ file: "same.jpg", message: "Amex-Screenshot: Betrag prüfen.", draft }] }], state);
    state = commitStatementImport(state, [], [], prepared.metadata).state;
  }
  expect(state.reviewQueue).toHaveLength(1);
  expect(state.importResults).toMatchObject([{ review: 1 }, { review: 1 }]);
  const item = state.reviewQueue![0];
  if (item.kind !== "booking") throw new Error("Expected screenshot repair");
  state = commitStatementImport(state, [{ ...item.draft, amount: -12, reviewed: true,
    manualCategory: true, categoryOverride: true, category: "Lebensmittel" }]).state;
  expect(state.reviewQueue).toEqual([]);
  expect(state.importResults).toMatchObject([{ inserted: 1, review: 0 }, { inserted: 1, review: 0 }]);
});

it("does not call a review resolved when normalization changes only its queue wrapper", () => {
  const row = booking();
  const outcome = importResultSchema.parse({ uploadId: first, name: "test.csv", completedAt: Date.now(),
    status: "with-warnings", inserted: 0, updated: 0, duplicates: 0, review: 1, skipped: 0, issues: [] });
  const before: AppState = { ...empty(), importResults: [outcome], reviewQueue: [{
    kind: "fixed", id: "group", importUploadId: first,
    change: { id: "group", category: "Gehalt", month: "2026-10", previous: 10, amount: 12, bookings: [row] },
  }] };
  const after: AppState = { ...before, reviewQueue: [
    { kind: "booking", id: row.id, draft: row, importUploadId: first, message: "Weiter prüfen." },
  ] };
  expect(reconcileImportResultReviews(before, after)).toEqual([outcome]);
});

it("preserves explicit settlement source decisions on ledger and receipt twins through review and duplicate imports", () => {
  const purchase = { ...booking("purchase"), amount: -100, sharedWithRaphael: true };
  const refund: Transaction = { ...booking("refund"), date: "2026-10-06", amount: 40,
    description: "SPAR Rückerstattung", category: "Rückerstattungen", manualCategory: true,
    categoryOverride: true, reviewed: true, sharedRefundFor: purchase.id };
  let state: AppState = { ...empty(), transactions: [purchase, refund], fixedReceipts: [{
    key: JSON.stringify(["synthetic receipt"]), date: refund.date, category: refund.category, amount: refund.amount,
    booking: refund,
  }] };
  const selected = { ...refund, sharedRefundFor: undefined, sharedRefundUnlinked: true };
  state = commitStatementImport(state, [selected]).state;
  expect(state.transactions.find((row) => row.id === refund.id)).toMatchObject({ sharedRefundUnlinked: true });
  expect(state.transactions.find((row) => row.id === refund.id)!.sharedRefundFor).toBeUndefined();
  const result = { source: "Raiffeisen" as const, file: "refund.csv", rows: [{ ...refund, id: "duplicate",
    sharedRefundFor: undefined, manualCategory: undefined, categoryOverride: undefined, reviewed: undefined }],
    skipped: 0, issues: [], uploadId: first };
  const prepared = prepareStatementImport([result], state);
  state = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
  expect(state.transactions.find((row) => row.id === refund.id)).toMatchObject({ sharedRefundUnlinked: true });
  expect(state.transactions.find((row) => row.id === refund.id)!.sharedRefundFor).toBeUndefined();
});

it("retains explicit settlement fields on fixed-only receipt review without copying them to a merchant twin", () => {
  const original = { ...booking("receipt"), category: "Versicherungen" as const, amount: -65 };
  const twin = { ...original, id: "unrelated", date: "2026-10-06" };
  const state: AppState = { ...empty(), transactions: [twin], fixedReceipts: [{
    key: "receipt-key", date: original.date, category: original.category, amount: original.amount, booking: original,
  }] };
  const selected = { ...original, manualCategory: true, categoryOverride: true, reviewed: true,
    fixedCost: true, sharedPaidAmount: 10, sharedRepaymentFor: "source-purchase" };
  const saved = commitStatementImport(state, [selected]).state;
  const receipt = saved.fixedReceipts?.find((item) => item.booking?.id === original.id);
  const promoted = saved.transactions.find((row) => row.id === original.id);
  expect(receipt?.booking ?? promoted).toMatchObject({ sharedPaidAmount: 10, sharedRepaymentFor: "source-purchase" });
  expect(saved.transactions.find((row) => row.id === twin.id)!.sharedRepaymentFor).toBeUndefined();
});

it("keeps equal filenames independent and gives truthful duplicate-only results by UUID", () => {
  const state = empty();
  const result = { source: "Raiffeisen" as const, file: "same.csv", rows: [booking()], skipped: 0, issues: [] };
  const prepared = prepareStatementImport([{ ...result, uploadId: first }], state);
  const saved = commitStatementImport(state, prepared.automatic, [], prepared.metadata).state;
  const again = prepareStatementImport([{ ...result, rows: [booking("copy")], uploadId: second }], saved);
  const repeated = commitStatementImport(saved, again.automatic, [], again.metadata).state;
  expect(repeated.transactions).toHaveLength(1);
  expect(repeated.importResults!.find((entry) => entry.uploadId === first)).toMatchObject({ inserted: 1, duplicates: 0 });
  expect(repeated.importResults!.find((entry) => entry.uploadId === second)).toMatchObject({ inserted: 0, duplicates: 1 });
});
