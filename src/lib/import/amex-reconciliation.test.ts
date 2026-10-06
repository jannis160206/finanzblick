import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { actualBookings } from "@/lib/calc";
import { amexFunding } from "@/lib/amex-balance";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { prepareStatementImport, commitStatementImport } from "./review";
import { reconcileAmexImports } from "./amex-reconciliation";
import { parseAmexText } from "./amex-pdf";
import { statementFingerprint } from "./identity";
import type { StatementResult } from "./statements";

const booking = (id: string, patch: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-10-02", bank: "Amex", pocket: "Amex", description: "IKEA KLAGENFURT 9020 IK -",
  amount: -207.82, category: "Shopping", includeInPlan: true,
  rawDetails: ["Amex-Screenshot"], ...patch,
});
function fixture(rows: Transaction[] = []): AppState {
  const state = createSeed();
  return { ...state, transactions: rows, fixedReceipts: [], reviewQueue: [], financeRows: [],
    plannedOneOffs: [], plannedOneOffsSeeded: true, accountSnapshots: [],
    settings: { ...state.settings, asOf: "2026-10-06" },
    amexBalanceSnapshots: [{ date: "2026-10-05", periodStart: "2026-09-11", balance: 1619.19 }] };
}
function screenshot(rows: Transaction[], balance = 1489.69): StatementResult {
  return { source: "Amex", file: "WhatsApp Image 2026-10-06.jpeg", rows: rows.map((row) => ({
    ...row, amexSource: "screenshot", amexStatus: row.amexStatus ?? "posted", amexCapturedAt: "2026-10-06",
  })), issues: [], skipped: 0,
    amexScreenshot: { layout: "grouped", capturedAt: "2026-10-06", balance, balanceIncludesPending: false } };
}
function upload(state: AppState, results: StatementResult[]) {
  const preview = prepareStatementImport(results, state);
  return commitStatementImport(state, preview.automatic, [], preview.metadata).state;
}

describe("Amex screenshot validation and final PDF reconciliation", () => {
  it("corrects unique old amounts once, preserving identity, categories, aliases and sharing", () => {
    const old = booking("old", { amount: -200, category: "Wohnen & Haushalt", fixedCost: false,
      categoryOverride: true, manualCategory: true, merchantAlias: "Schrank", sharedWithRaphael: true, reviewed: true });
    const state = fixture([old]);
    const result = screenshot([booking("new"), booking("other", { description: "BILLA FINKENSTEIN", amount: -16.39 })]);
    const saved = upload(state, [result]);
    expect(saved.transactions.find((row) => row.id === "old")).toMatchObject({
      ...old, amount: -207.82, amexSource: "screenshot", amexCapturedAt: "2026-10-06",
    });
    expect(saved.transactions.some((row) => row.id === "new")).toBe(false);
    expect(saved.amexScreenshotValidation).toEqual({ version: 1, date: "2026-10-06" });
    expect(saved.amexBalanceSnapshots?.at(-1)).toMatchObject({ balance: 1489.69 });
    expect(upload(saved, [result])).toEqual(saved);
    const later = reconcileAmexImports(saved, { rows: [booking("again", { amount: -220 })], validationDate: "2026-10-07" });
    expect(later.state.transactions.find((row) => row.id === "old")?.amount).toBe(-207.82);
  });

  it("uses the new total plus pending once, then subtracts shared halves and actual reserve", () => {
    const rows = [
      booking("ikea", { sharedWithRaphael: true }),
      booking("airbnb", { description: "AIRBNB * HMKFJJJ9QC LONDON", date: "2026-10-03", amount: -126, sharedWithRaphael: true }),
      booking("tapeso", { description: "MOLLIE=TAPESO DRACHTEN", amount: -164.90, sharedWithRaphael: true }),
      booking("pending", { description: "SPAR FINKENSTEIN 6423", date: "2026-10-05", amount: -6.56, amexStatus: "pending" }),
    ];
    const saved = upload(fixture(rows), [screenshot(rows)]);
    saved.accountSnapshots = [{ bank: "Revolut", name: "Amex Rückzahlung", date: "2026-10-06", balance: 954 }];
    expect(amexFunding(saved, actualBookings(saved))).toMatchObject({
      outstanding: 1496.25, ownOutstanding: 1246.89, reserved: 954, additional: 292.89,
    });
    expect(upload(saved, [screenshot(rows)]).transactions).toEqual(saved.transactions);
  });

  it("adds missing PDF bookings and enriches the originals without resetting personal choices", () => {
    const old = booking("old", { description: "AIRBNB * HMKFJJJ9QC", date: "2026-10-03", amount: -126,
      sharedWithRaphael: true, merchantAlias: "Urlaub", manualCategory: true, categoryOverride: true, fixedCost: false });
    const pdf = parseAmexText(["11.10.2026\nUmsatz vom Buchung am Betrag in EUR\nNeue Belastungen für HERRN JANNIS BRUEHL\n03.10 04.10 AIRBNB * HMKFJJJ9QC LONDON 126,00\nUhrzeit: 15:20:00\n04.10 04.10 BILLA FINKENSTEIN 16,39"]);
    const saved = upload(fixture([old]), [pdf]);
    expect(saved.transactions.find((row) => row.id === "old")).toMatchObject({
      id: "old", description: "AIRBNB * HMKFJJJ9QC LONDON", amount: -126,
      amexSource: "pdf", amexStatus: "posted", time: "15:20:00",
      sharedWithRaphael: true, merchantAlias: "Urlaub", manualCategory: true, fixedCost: false,
    });
    expect(saved.transactions).toHaveLength(2);
    expect(upload(saved, [pdf])).toEqual(saved);
    const reimport = upload(saved, [screenshot([old])]);
    expect(reimport.transactions).toEqual(saved.transactions);
  });

  it("reads the closing date rather than the previous-period date in a real-style PDF header", () => {
    const pdf = parseAmexText(["American Express\nDatum Rechnungsdatum\n10.09.26 11.10.26\nUmsatz vom Buchung am Betrag in EUR\n02.10 03.10 IKEA KLAGENFURT 9020 IK - 207,82"]);
    expect(pdf.rows[0].date).toBe("2026-10-02");
    const saved = upload(fixture([booking("existing")]), [pdf]);
    expect(saved.transactions).toHaveLength(1);
    expect(saved.transactions[0]).toMatchObject({ id: "existing", amexSource: "pdf", date: "2026-10-02" });
  });

  it("handles pending becoming final with a corrected date/amount and accounts for the difference", () => {
    const old = booking("pending", { description: "SPAR FINKENSTEIN 6423", amount: -6.56,
      date: "2026-10-05", amexStatus: "pending", amexCapturedAt: "2026-10-06" });
    const state = fixture([old]);
    state.amexBalanceSnapshots = [{ date: "2026-10-06", periodStart: "2026-09-11", balance: 1489.69, pendingBalance: 6.56 }];
    const pdf = parseAmexText(["11.10.2026\nUmsatz vom Buchung am Betrag in EUR\n05.10 06.10 SPAR FINKENSTEIN 6423 6,90"]);
    const saved = upload(state, [pdf]);
    expect(saved.transactions).toHaveLength(1);
    expect(saved.transactions[0]).toMatchObject({ id: "pending", amount: -6.9, amexSource: "pdf", amexStatus: "posted" });
    expect(saved.amexBalanceSnapshots?.[0].pendingBalance).toBe(6.9);
    expect(amexFunding(saved, actualBookings(saved)).outstanding).toBe(1496.59);
    expect(upload(saved, [pdf])).toEqual(saved);
    const redropped = upload(saved, [screenshot([old])]);
    expect(redropped.transactions).toEqual(saved.transactions);
    expect(amexFunding(redropped, actualBookings(redropped)).outstanding).toBe(1496.59);
  });

  it("does not pick among two same-merchant purchases when changed values are ambiguous", () => {
    const state = fixture([booking("one", { amount: -7 }), booking("two", { amount: -208 })]);
    const result = reconcileAmexImports(state, { rows: [booking("new", { amount: -20 })], validationDate: "2026-10-06" });
    expect(result.state.transactions).toEqual(state.transactions);
    expect(result.rows).toEqual([]);
    expect(result.review).toHaveLength(1);
  });

  it("reserves exact matches before fixing another purchase at the same merchant", () => {
    const state = fixture([booking("small", { amount: -6.97 }), booking("big", { amount: -200 })]);
    const rows = [booking("new-big"), booking("new-small", { amount: -6.97 })];
    const result = reconcileAmexImports(state, { rows, validationDate: "2026-10-06" });
    expect(result.state.transactions.map((row) => row.amount)).toEqual([-6.97, -207.82]);
    expect(result.rows).toEqual([]);
  });

  it("never joins different cardholders, different Amazon orders or positive credits to charges", () => {
    const state = fixture([booking("order", { description: "AMAZON.DE*ABC123", amount: -30 })]);
    const rows = [
      booking("other", { description: "AMAZON.DE*DEF456", amount: -30 }),
      booking("raphael", { description: "AMAZON.DE*ABC123", amount: -30, pocket: "AMEX Raphael" }),
      booking("credit", { description: "AMAZON.DE*ABC123", amount: 30 }),
    ];
    const result = reconcileAmexImports(state, { rows, validationDate: "2026-10-06" });
    expect(result.state.transactions).toEqual(state.transactions);
    expect(result.rows).toEqual(rows);
  });

  it("repairs fixed receipt bank facts and ignored identities without changing the recurring plan", () => {
    const old = booking("fixed", { amount: -12, fixedCost: true });
    const state = fixture();
    state.fixedReceipts = [{ key: statementFingerprint(old), booking: old, date: old.date,
      amount: old.amount, category: old.category, rowId: "existing-contract" }];
    state.ignoredStatementKeys = [statementFingerprint(old)];
    const result = reconcileAmexImports(state, { rows: [booking("correct", { amount: -12.99 })], validationDate: "2026-10-06" });
    const fixed = result.state.fixedReceipts![0];
    expect(fixed).toMatchObject({ amount: -12.99, rowId: "existing-contract", booking: { id: "fixed", fixedCost: true } });
    expect(result.state.ignoredStatementKeys).toEqual([fixed.key]);
    expect(result.state.financeRows).toEqual(state.financeRows);
  });

  it("roundtrips validation, source, pending status and totals through JSON and Excel", async () => {
    const state = fixture([booking("pending", { amexSource: "screenshot", amexStatus: "pending",
      amexCapturedAt: "2026-10-06", amexPeriodStart: "2026-09-11", amexScreenshotKeys: ["retained-identity"] })]);
    state.amexBalanceSnapshots![0].pendingBalance = 6.56;
    state.amexScreenshotValidation = { version: 1, date: "2026-10-06" };
    const json = appStateSchema.parse(JSON.parse(JSON.stringify(state)));
    expect(json.amexScreenshotValidation).toEqual(state.amexScreenshotValidation);
    const restored = (await parseWorkbook(await exportWorkbook(state))).state;
    expect(restored.amexScreenshotValidation).toEqual(state.amexScreenshotValidation);
    expect(restored.transactions[0]).toMatchObject(state.transactions[0]);
    expect(restored.amexBalanceSnapshots).toEqual(state.amexBalanceSnapshots);
  });

  it("does not consume the one-time correction on an empty or failed screenshot batch", () => {
    expect(upload(fixture(), [screenshot([])]).amexScreenshotValidation).toBeUndefined();
  });

  it("allows later confirmation from the validation batch to repair an untouched legacy row", () => {
    const old = booking("old", { description: "SPAR FINKENSTEIN 6423", amount: -60 });
    const state = fixture([old]);
    state.amexScreenshotValidation = { version: 1, date: "2026-10-06" };
    const confirmed = booking("confirmed", { description: old.description, amount: -6.56,
      amexSource: "screenshot", amexCapturedAt: "2026-10-06", manualCategory: true, reviewed: true });
    const result = reconcileAmexImports(state, { rows: [confirmed] });
    expect(result.state.transactions[0]).toMatchObject({ id: "old", amount: -6.56 });
    expect(result.rows).toEqual([]);
  });

  it("does not double-count a pending charge whose final transaction date moved past the capture", () => {
    const old = booking("pending", { description: "SPAR FINKENSTEIN 6423", amount: -6.56,
      date: "2026-10-05", amexStatus: "pending", amexCapturedAt: "2026-10-06" });
    const state = fixture([old]);
    state.settings.asOf = "2026-10-11";
    state.amexBalanceSnapshots = [{ date: "2026-10-06", periodStart: "2026-09-11", balance: 1489.69, pendingBalance: 6.56 }];
    const pdf = parseAmexText(["11.10.2026\nUmsatz vom Buchung am Betrag in EUR\n07.10 08.10 SPAR FINKENSTEIN 6423 6,90"]);
    const saved = upload(state, [pdf]);
    expect(saved.transactions).toHaveLength(1);
    expect(saved.amexBalanceSnapshots![0].pendingBalance).toBe(0);
    expect(amexFunding(saved, actualBookings(saved)).outstanding).toBe(1496.59);
  });

  it("matches the same numbered store when the app and PDF order the branch words differently", () => {
    const old = booking("pending", { description: "SPAR FINKENSTEIN 6423", amount: -6.56,
      date: "2026-10-05", amexStatus: "pending" });
    const pdf = parseAmexText(["11.10.2026\nUmsatz vom Buchung am Betrag in EUR\n05.10 06.10 Spar Fil. 6423 Spar Fil Finkenstein 6,56"]);
    const saved = upload(fixture([old]), [pdf]);
    expect(saved.transactions).toHaveLength(1);
    expect(saved.transactions[0]).toMatchObject({ id: "pending", amount: -6.56, amexSource: "pdf", amexStatus: "posted" });
  });

  it("keeps the first occurrence's scroll position when later images overlap", () => {
    const rows = [booking("first"), booking("second", { description: "BILLA FINKENSTEIN", amount: -16 }),
      booking("overlap")];
    const result = reconcileAmexImports(fixture(), { rows });
    expect(result.rows.map((row) => row.id)).toEqual(["first", "second"]);
  });

  it("corrects the sign of a uniquely identified explicit credit rather than saving it twice", () => {
    const old = booking("credit", { description: "Entertainment Gutschrift", amount: -11 });
    const result = reconcileAmexImports(fixture([old]), {
      rows: [booking("correct", { description: old.description, amount: 11 })], validationDate: "2026-10-06",
    });
    expect(result.state.transactions).toHaveLength(1);
    expect(result.state.transactions[0]).toMatchObject({ id: "credit", amount: 11 });
    expect(result.rows).toEqual([]);
  });

  it("includes signed pending credits once as well as pending charges", () => {
    const rows = [
      booking("pending", { description: "SPAR FINKENSTEIN 6423", amount: -6.56, amexStatus: "pending" }),
      booking("credit", { description: "Entertainment Gutschrift", amount: 15, amexStatus: "pending" }),
    ];
    const saved = upload(fixture(), [screenshot(rows)]);
    expect(saved.amexBalanceSnapshots?.at(-1)?.pendingBalance).toBe(-8.44);
    expect(amexFunding(saved, actualBookings(saved)).outstanding).toBe(1481.25);
  });

  it("matches a unique coded app order to a PDF merchant without its order code", () => {
    const old = booking("order", { description: "AMZN MKTP DE*ABC123 AMZN.COM/BILL", amount: -25 });
    const pdf = parseAmexText(["11.10.2026\nUmsatz vom Buchung am Betrag in EUR\n02.10 03.10 AMZN MKTP DE AMZN.COM/BILL 25,00"]);
    const saved = upload(fixture([old]), [pdf]);
    expect(saved.transactions).toHaveLength(1);
    expect(saved.transactions[0]).toMatchObject({ id: "order", amexSource: "pdf", amount: -25 });
  });

  it("asks rather than collapsing two coded equal-price orders into an uncoded PDF row", () => {
    const state = fixture([
      booking("one", { description: "AMZN MKTP DE*ABC123 AMZN.COM/BILL", amount: -25, includeInPlan: false }),
      booking("two", { description: "AMZN MKTP DE*DEF456 AMZN.COM/BILL", amount: -25, includeInPlan: false }),
    ]);
    const pdf = parseAmexText(["11.10.2026\nUmsatz vom Buchung am Betrag in EUR\n02.10 03.10 AMZN MKTP DE AMZN.COM/BILL 25,00"]);
    const saved = upload(state, [pdf]);
    expect(saved.transactions).toEqual(state.transactions);
    expect(saved.reviewQueue).toHaveLength(1);
  });

  it("rechecks new rows against PDF facts imported while the screenshot was being read", () => {
    const old = booking("screenshot", { description: "AIRBNB * HMKFJJJ9QC", amount: -126 });
    const state = fixture();
    const prepared = prepareStatementImport([screenshot([old, booking("second", { description: "BILLA FINKENSTEIN", amount: -16 })])], state);
    const updated = fixture([booking("pdf", { description: "AIRBNB * HMKFJJJ9QC LONDON", amount: -126,
      amexSource: "pdf", rawDetails: ["London"], reviewed: true })]);
    const saved = commitStatementImport(updated, prepared.automatic, [], prepared.metadata).state;
    expect(saved.transactions.filter((row) => /AIRBNB/.test(row.description))).toHaveLength(1);
    expect(saved.transactions.find((row) => row.id === "pdf")?.description).toBe("AIRBNB * HMKFJJJ9QC LONDON");
  });

  it("recomputes the pending total against a PDF that arrived after screenshot preparation", () => {
    const pending = booking("pending", { description: "SPAR FINKENSTEIN 6423", date: "2026-10-05",
      amount: -6.56, amexSource: "screenshot", amexStatus: "pending", amexCapturedAt: "2026-10-06" });
    const state = fixture([pending]);
    state.amexBalanceSnapshots = [{ date: "2026-10-06", periodStart: "2026-09-11", balance: 1489.69, pendingBalance: 6.56 }];
    const prepared = prepareStatementImport([screenshot([pending])], state);
    const pdf = parseAmexText(["11.10.2026\nUmsatz vom Buchung am Betrag in EUR\n05.10 06.10 SPAR FINKENSTEIN 6423 6,90"]);
    const finalized = upload(state, [pdf]);
    const saved = commitStatementImport(finalized, prepared.automatic, [], prepared.metadata).state;
    expect(saved.transactions).toHaveLength(1);
    expect(saved.amexBalanceSnapshots![0].pendingBalance).toBe(6.9);
    expect(amexFunding(saved, actualBookings(saved)).outstanding).toBe(1496.59);
  });

  it("retains the manual ledger classification when a stale fixed receipt mirrors it", () => {
    const ledger = booking("ledger", { category: "Wohnen & Haushalt", manualCategory: true, categoryOverride: true,
      fixedCost: false, merchantAlias: "Schrank", sharedWithRaphael: true });
    const state = fixture([ledger]);
    const stale = { ...ledger, id: "receipt-copy", category: "Shopping" as const,
      merchantAlias: undefined, manualCategory: false, fixedCost: true, sharedWithRaphael: false };
    state.fixedReceipts = [{ key: statementFingerprint(stale), booking: stale, date: stale.date,
      amount: stale.amount, category: stale.category }];
    const saved = reconcileAmexImports(state, { rows: [booking("corrected", { amount: -210 })],
      validationDate: "2026-10-06" }).state;
    expect(saved.transactions[0]).toMatchObject({ id: "ledger", amount: -210, category: "Wohnen & Haushalt",
      merchantAlias: "Schrank", sharedWithRaphael: true, manualCategory: true, fixedCost: false });
  });

  it("does not turn a new same-price charge on another day into a correction", () => {
    const old = booking("first", { description: "SPAR FINKENSTEIN 6423", amount: -6.56,
      amexSource: "screenshot", amexStatus: "pending", amexCapturedAt: "2026-10-06" });
    const next = booking("second", { description: old.description, date: "2026-10-04", amount: -6.56,
      amexSource: "screenshot", amexStatus: "pending", amexCapturedAt: "2026-10-06" });
    const result = reconcileAmexImports(fixture([old]), { rows: [next], validationDate: "2026-10-06" });
    expect(result.state.transactions).toEqual([old]);
    expect(result.rows.map((row) => row.id)).toEqual(["second"]);
  });

  it("applies a confirmed correction to a receipt-only booking without counting it twice", () => {
    const old = booking("receipt-booking", { amount: -12, fixedCost: true, sharedWithRaphael: true });
    const state = fixture();
    state.amexScreenshotValidation = { version: 1, date: "2026-10-06" };
    state.fixedReceipts = [{ key: statementFingerprint(old), booking: old, date: old.date,
      amount: old.amount, category: old.category, rowId: "contract" }];
    const confirmed = booking("review-draft", { amount: -12.99, amexSource: "screenshot",
      amexCapturedAt: "2026-10-06", manualCategory: true, categoryOverride: true, reviewed: true,
      category: "Wohnen & Haushalt", fixedCost: false });
    const saved = commitStatementImport(state, [confirmed], [], { amexReconciliation: { rows: [confirmed] } }).state;
    expect(actualBookings(saved)).toHaveLength(1);
    expect(actualBookings(saved)[0]).toMatchObject({ amount: -12.99, category: "Wohnen & Haushalt",
      fixedCost: false, sharedWithRaphael: true });
    expect(saved.financeRows).toEqual(state.financeRows);
  });
});
