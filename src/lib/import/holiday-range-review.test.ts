import { expect, it } from "vitest";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema, type Transaction } from "@/lib/types";
import { classify, actualBookings } from "@/lib/calc";
import { openReviewCount, queueLedgerReview } from "./review";

const booking = (id: string, description: string, date: string, extra: Partial<Transaction> = {}) =>
  transactionSchema.parse({
    id, description, bank: "Erste", pocket: "Erste", date, amount: -23.4,
    category: "Prüfen", includeInPlan: true, requires_manual_review: true, ...extra,
  });
const stateWith = (rows: Transaction[]) => ({
  ...blankTestState(),
  holidayRanges: [{ from: "2026-08-10", to: "2026-08-20" }],
  transactions: rows,
  reviewQueue: rows.map((draft) => ({
    kind: "booking" as const, id: draft.id, draft, message: "Händlerzuordnung unsicher – bitte prüfen.",
  })),
});

it("treats unknown spend inside the holiday range as Urlaub and closes its review", () => {
  const state = stateWith([
    booking("in", "Taverna Poseidon Rhodos", "2026-08-12"),
    booking("start", "Kiosk Lindos", "2026-08-10"),
    booking("end", "Souvenir Lindos", "2026-08-20"),
    booking("before", "Qwx Heimat Villach", "2026-08-09"),
    booking("after", "Zrt Daheim Villach", "2026-08-21"),
    booking("pos", "Kartenzahlung POS", "2026-08-13"),
  ]);
  const next = queueLedgerReview(state);
  const open = new Set((next.reviewQueue ?? []).map((item) => item.kind === "booking" ? item.id : ""));
  expect(open.has("in") || open.has("start") || open.has("end") || open.has("pos")).toBe(false);
  for (const id of ["before", "after"])
    expect(classify(actualBookings(next).find((row) => row.id === id)!).category).not.toBe("Urlaub");
  for (const id of ["in", "start", "end", "pos"])
    expect(classify(actualBookings(next).find((row) => row.id === id)!).category).toBe("Urlaub");
  expect(openReviewCount(next.reviewQueue ?? [])).toBe(open.size);
});

it("keeps fixed costs, income and manual choices out of the holiday rule", () => {
  const state = stateWith([
    booking("manual", "Taverna Poseidon Rhodos", "2026-08-12", {
      category: "Shopping", categoryOverride: true, manualCategory: true, requires_manual_review: false,
    }),
    booking("income", "Gutschrift Kunde", "2026-08-12", { amount: 100 }),
  ]);
  const next = queueLedgerReview(state);
  expect(classify(actualBookings(next).find((row) => row.id === "manual")!).category).toBe("Shopping");
});

it("settles pending drafts that are not in the ledger yet", () => {
  const draft = booking("pending", "Taverna Poseidon Rhodos", "2026-08-14");
  const state = { ...stateWith([]), reviewQueue: [{ kind: "booking" as const, id: draft.id, draft, message: "Händlerzuordnung unsicher – bitte prüfen." }] };
  const next = queueLedgerReview(state);
  expect(openReviewCount(next.reviewQueue ?? [])).toBe(0);
  expect(classify(actualBookings(next).find((row) => row.id === "pending")!).category).toBe("Urlaub");
});
