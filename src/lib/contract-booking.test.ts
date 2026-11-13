import { describe, expect, it } from "vitest";
import { addMonthsToDate, detectContracts } from "@/lib/contracts";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { assignBookingToContract, canHoldContract, contractBookingsChange, contractFit, contractOfBooking, contractSeedFromBooking } from "./contract-booking";

let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"] = "Abonnements"): Transaction => ({
  id: `b${++counter}`, date, bank: "Raiffeisen", pocket: "Testkonto", description, amount, category, includeInPlan: true,
});
const stateWith = (transactions: Transaction[], extra: Partial<AppState> = {}): AppState => appStateSchema.parse({
  ...createSeed(), transactions, financeRows: [], merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
  ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [], ...extra,
});
const monthly = (description: string, amount: number, start: string, count: number, category?: Transaction["category"]) =>
  Array.from({ length: count }, (_, index) => row(addMonthsToDate(start, index), description, -amount, category));
const TODAY = "2026-09-01";

describe("contractBookingsChange", () => {
  it("adds new bookings, keeps detected ones out of the list and confirms a suggestion", () => {
    const change = contractBookingsChange({ charges: [{ id: "x", date: TODAY, amount: 1 }], status: "review" },
      { bookingIds: ["old"], excludedBookingIds: ["new"] }, ["x", "new"], []);
    expect(change.added).toEqual(["new"]);
    expect(change.patch).toEqual({ bookingIds: ["old", "new"], excludedBookingIds: undefined, status: "confirmed" });
  });

  it("removes charges by excluding them and can leave the status alone", () => {
    const change = contractBookingsChange({ charges: [{ id: "x", date: TODAY, amount: 1 }], status: "review" }, { bookingIds: ["x"] }, [], ["x", "unknown"], false);
    expect(change.removed).toEqual(["x"]);
    expect(change.patch).toEqual({ bookingIds: undefined, excludedBookingIds: ["x"] });
  });
});

describe("assignBookingToContract", () => {
  const streaming = monthly("Streamflix Abo", 9.99, "2026-05-15", 4);
  const gym = monthly("Kraftwerk Studio", 29, "2026-05-03", 4, "Sport & Fitness");
  const stray = row("2026-08-20", "Kino Abendkasse", -12);

  it("links a loose booking to an existing contract and keeps the detected charges", () => {
    const state = stateWith([...streaming, ...gym, stray]);
    const contracts = detectContracts(state, TODAY);
    const target = contracts.find((contract) => contract.name === "Streamflix Abo")!;
    expect(contractOfBooking(contracts, stray.id)).toBeUndefined();
    const next = assignBookingToContract(state, contracts, stray.id, target.id, 5);
    const linked = detectContracts(next, TODAY).find((contract) => contract.id === target.id)!;
    expect(linked.charges.map((charge) => charge.id)).toEqual(expect.arrayContaining([stray.id, ...streaming.map((booking) => booking.id)]));
    expect(linked.status).toBe("active");
    expect(contractOfBooking(detectContracts(next, TODAY), stray.id)?.id).toBe(target.id);
  });

  it("moves a booking between contracts and can release it again", () => {
    const state = stateWith([...streaming, ...gym]);
    const contracts = detectContracts(state, TODAY);
    const from = contracts.find((contract) => contract.name === "Streamflix Abo")!;
    const to = contracts.find((contract) => contract.name === "Kraftwerk Studio")!;
    const moved = streaming[3].id;
    const next = assignBookingToContract(state, contracts, moved, to.id, 5);
    const after = detectContracts(next, TODAY);
    expect(contractOfBooking(after, moved)?.id).toBe(to.id);
    expect(next.contracts?.find((entry) => entry.id === from.id)).toMatchObject({ excludedBookingIds: [moved] });
    expect(next.contracts?.find((entry) => entry.id === from.id)?.status).toBeUndefined();
    const released = assignBookingToContract(next, after, moved, null, 6);
    expect(contractOfBooking(detectContracts(released, TODAY), moved)).toBeUndefined();
  });

  it("changes nothing when the booking already belongs to the target", () => {
    const state = stateWith(streaming);
    const contracts = detectContracts(state, TODAY);
    expect(assignBookingToContract(state, contracts, streaming[0].id, contracts[0].id)).toBe(state);
  });
});

describe("contractSeedFromBooking", () => {
  it("fills merchant, amount, category and the rhythm of earlier bookings", () => {
    const earlier = monthly("Kraftwerk Studio", 29, "2026-04-03", 4, "Sport & Fitness");
    const latest = row("2026-08-03", "Kraftwerk Studio", -31, "Sport & Fitness");
    const seed = contractSeedFromBooking(stateWith([...earlier, latest]), latest, TODAY);
    expect(seed).toMatchObject({ name: "Kraftwerk Studio", amount: 31, category: "Sport & Fitness", interval: "monthly", nextDate: "2026-09-03", selected: [latest.id] });
    expect(seed.rule).toMatchObject({ amountMin: 24.8, amountMax: 38.75, account: "Raiffeisen · Testkonto" });
  });

  it("falls back to a monthly subscription for a single open booking", () => {
    const single = row("2026-08-28", "Wolkenspeicher Plus", -4.99, "Prüfen");
    expect(contractSeedFromBooking(stateWith([single]), single, TODAY)).toMatchObject({
      amount: 4.99, category: "Abonnements", interval: "monthly", nextDate: "2026-09-28",
    });
  });
});

describe("contractFit and canHoldContract", () => {
  it("ranks the same merchant and a similar amount first", () => {
    const state = stateWith([...monthly("Streamflix Abo", 9.99, "2026-05-15", 4), ...monthly("Kraftwerk Studio", 29, "2026-05-03", 4)]);
    const contracts = detectContracts(state, TODAY);
    const booking = row("2026-08-30", "Streamflix Abo", -10.49);
    const [best] = [...contracts].sort((a, b) => contractFit(b, booking) - contractFit(a, booking));
    expect(best.name).toBe("Streamflix Abo");
    expect(contractFit(best, booking)).toBe(3);
  });

  it("accepts only counted debits", () => {
    expect(canHoldContract({ amount: -5 })).toBe(true);
    expect(canHoldContract({ amount: 5 })).toBe(false);
    expect(canHoldContract({ amount: -5, ignored: true })).toBe(false);
  });
});
