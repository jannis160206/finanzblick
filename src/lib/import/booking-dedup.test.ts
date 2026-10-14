import { describe, expect, it } from "vitest";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema, type AppState, type Transaction } from "@/lib/types";
import { statementFingerprint } from "./identity";
import { mergeDuplicateBookings } from "./booking-dedup";
import { queueLedgerReview } from "./review";

const booking = (id: string, patch: Partial<Transaction> = {}) =>
  transactionSchema.parse({
    id,
    date: "2026-09-05",
    bank: "Revolut",
    pocket: null,
    description: "Synthetic Coffee Corner",
    amount: -4.2,
    category: "Cafés & Snacks",
    includeInPlan: true,
    ...patch,
  });
const stateWith = (transactions: Transaction[], patch: Partial<AppState> = {}): AppState => ({
  ...blankTestState(),
  transactions,
  ...patch,
});

describe("mergeDuplicateBookings", () => {
  it("merges identical bank movements and keeps the booking with the user's decision", () => {
    const plain = booking("a", { occurrence: 1 });
    const decided = booking("b", {
      occurrence: 1,
      category: "Restaurants",
      categoryOverride: true,
      manualCategory: true,
      reviewed: true,
      time: "12:30:00",
    });
    const { state, merged } = mergeDuplicateBookings(stateWith([plain, decided]));
    expect(merged).toBe(1);
    expect(state.transactions).toEqual([decided]);
  });

  it("fills missing bank facts from the discarded copy but never its assignment", () => {
    const first = booking("a", { occurrence: 1, manualCategory: true, categoryOverride: true, reviewed: true });
    const second = booking("b", { occurrence: 1, bankReference: undefined, time: "09:15:00", category: "Shopping" });
    const { state } = mergeDuplicateBookings(stateWith([first, second]));
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]).toMatchObject({ id: "a", time: "09:15:00", category: "Cafés & Snacks", manualCategory: true });
  });

  it("keeps genuinely repeated purchases and equal rows on different days or accounts", () => {
    const rows = [
      booking("a"),
      booking("b"),
      booking("c", { date: "2026-09-06" }),
      booking("d", { bank: "Raiffeisen", pocket: "Giro" }),
      booking("e", { amount: -4.3 }),
    ];
    const input = stateWith(rows);
    const { state, merged } = mergeDuplicateBookings(input);
    expect(merged).toBe(0);
    expect(state).toBe(input);
  });

  it("merges rows sharing a bank reference even when their wording differs", () => {
    const rows = [
      booking("a", { bankReference: "REF-1", description: "Coffee Corner" }),
      booking("b", { bankReference: "REF-1", description: "Coffee Corner Wien" }),
      booking("c", { bankReference: "REF-2", description: "Coffee Corner" }),
    ];
    const { state } = mergeDuplicateBookings(stateWith(rows));
    expect(state.transactions.map((row) => row.bankReference)).toEqual(["REF-1", "REF-2"]);
  });

  it("repoints reviews, receipts and plan sources from the discarded id to the survivor", () => {
    const plain = booking("a", { occurrence: 1 });
    const decided = booking("b", { occurrence: 1, merchantNameConfirmed: true, is_locked: true });
    const base = blankTestState();
    const input = stateWith([plain, decided], {
      reviewQueue: [
        { kind: "booking", id: "a", draft: plain, message: "Check" },
        { kind: "fixed", id: "fixed", change: { id: "fixed", category: "Miete", month: "2026-09", previous: 1, amount: 2, bookings: [plain, decided] } },
      ],
      fixedReceipts: [{ key: statementFingerprint(plain), booking: plain, category: plain.category, amount: plain.amount, date: plain.date }],
      financeRows: [
        ...base.financeRows,
        { id: "plan", label: "Plan", kind: "fixed", values: {}, fixedSource: { key: "k", bookingIds: ["a", "b"], merchantKeys: [], pocket: null, applied: {} } },
      ],
    });
    const { state } = mergeDuplicateBookings(input);
    expect(state.transactions.map((row) => row.id)).toEqual(["b"]);
    expect(state.reviewQueue?.some((item) => item.kind === "booking")).toBe(false);
    const fixed = state.reviewQueue?.find((item) => item.kind === "fixed");
    expect(fixed?.kind === "fixed" && fixed.change.bookings.map((row) => row.id)).toEqual(["b"]);
    expect(state.fixedReceipts?.[0].booking?.id).toBe("b");
    expect(state.financeRows.find((row) => row.id === "plan")?.fixedSource?.bookingIds).toEqual(["b"]);
  });

  it("merges an Amex screenshot with its statement row but keeps two real screenshot twins", () => {
    const amex = (id: string, patch: Partial<Transaction>) =>
      booking(id, { bank: "Amex", pocket: "Amex", description: "SYNTHETIC SHOP", ...patch });
    const screenshot = amex("s", { rawDetails: ["Amex-Screenshot"], occurrence: 1 });
    const statement = amex("p", { occurrence: 1, bankReference: undefined });
    const { state } = mergeDuplicateBookings(stateWith([screenshot, statement]));
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0].id).toBe("p");
    const twins = mergeDuplicateBookings(
      stateWith([amex("t1", { rawDetails: ["Amex-Screenshot"] }), amex("t2", { rawDetails: ["Amex-Screenshot"] })]),
    );
    expect(twins.merged).toBe(0);
  });

  it("runs on every ledger review pass and is idempotent", () => {
    const input = stateWith([booking("a", { occurrence: 1 }), booking("b", { occurrence: 1 })]);
    const once = queueLedgerReview(input);
    expect(once.transactions).toHaveLength(1);
    expect(queueLedgerReview(once).transactions).toEqual(once.transactions);
  });
});
