import { describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type FinanceRow, type Transaction } from "@/lib/types";
import {
  addMonthsToDate,
  cancellationWindow,
  contractCandidates,
  contractChargesBetween,
  contractPatch,
  contractReminders,
  contractRuleMatches,
  contractSummary,
  detectContracts,
  inferInterval,
  suggestContractRule,
  upsertContractOverride,
} from "./contracts";

let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"]): Transaction => ({
  id: `c${++counter}`, date, bank: "Raiffeisen", pocket: "Testkonto", description, amount, category, includeInPlan: true,
});
const stateWith = (transactions: Transaction[], extra: Partial<AppState> = {}): AppState => appStateSchema.parse({
  ...createSeed(), transactions, financeRows: [], merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
  ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [], ...extra,
});
const series = (description: string, amounts: number[], dates: string[], category: Transaction["category"] = "Abonnements") =>
  amounts.map((amount, index) => row(dates[index], description, -amount, category));
const monthsFrom = (start: string, count: number) => Array.from({ length: count }, (_, index) => addMonthsToDate(start, index));

describe("contract detection", () => {
  it("detects monthly subscriptions with next date, yearly cost and price increase", () => {
    const state = stateWith(series("Streamflix Abo", [9.99, 9.99, 9.99, 12.99], monthsFrom("2026-05-15", 4)));
    const [contract] = detectContracts(state, "2026-09-01");
    expect(contract).toMatchObject({
      name: "Streamflix Abo", interval: "monthly", amount: 12.99, monthly: 12.99, yearly: 155.88,
      nextDate: "2026-09-15", lastDate: "2026-08-15", status: "review", source: "detected",
    });
    expect(contract.priceChange).toMatchObject({ from: 9.99, to: 12.99 });
    expect(contract.charges).toHaveLength(4);
  });

  it("recognises quarterly, half-yearly and yearly payments", () => {
    const state = stateWith([
      ...series("Kfz Versicherung Donau", [120, 120, 120], ["2026-01-10", "2026-04-10", "2026-07-10"], "Versicherungen"),
      ...series("Haushalt Versicherung Uniqa", [80, 80], ["2025-11-02", "2026-05-02"], "Versicherungen"),
      ...series("Cloud Speicher Pro", [99, 99], ["2025-03-20", "2026-03-20"], "Abonnements"),
    ]);
    const byName = Object.fromEntries(detectContracts(state, "2026-08-01").map((contract) => [contract.name, contract]));
    expect(byName["Kfz Versicherung Donau"]).toMatchObject({ interval: "quarterly", monthly: 40, nextDate: "2026-10-10" });
    expect(byName["Haushalt Versicherung Uniqa"]).toMatchObject({ interval: "halfyearly", nextDate: "2026-11-02" });
    expect(byName["Cloud Speicher Pro"]).toMatchObject({ interval: "yearly", yearly: 99, nextDate: "2027-03-20" });
  });

  it("ignores everyday shopping, one-off purchases and stopped subscriptions", () => {
    const groceries = ["05-02", "05-09", "06-02", "06-09", "07-02", "07-09", "08-02"].map((date) => row(`2026-${date}`, "Supermarkt Nord", -40, "Lebensmittel"));
    const state = stateWith([
      ...groceries,
      row("2026-06-11", "Elektro Shop", -499, "Shopping"),
      ...series("Altabo Media", [5, 5, 5], monthsFrom("2026-01-03", 3)),
    ]);
    expect(detectContracts(state, "2026-08-20")).toEqual([]);
  });

  it("keeps parallel series at one merchant apart", () => {
    const state = stateWith([
      ...series("Ratenkauf Shop", [30, 30, 30], monthsFrom("2026-05-05", 3), "Shopping"),
      ...series("Ratenkauf Shop", [90, 90, 90], monthsFrom("2026-05-20", 3), "Shopping"),
    ]);
    const contracts = detectContracts(state, "2026-08-01");
    expect(contracts.map((contract) => contract.amount).sort((a, b) => a - b)).toEqual([30, 90]);
    expect(new Set(contracts.map((contract) => contract.id)).size).toBe(2);
  });

  it("takes fixed-cost plan rows without bookings and does not duplicate linked ones", () => {
    const charges = series("Handyvertrag Magenta", [25, 25, 25], monthsFrom("2026-05-07", 3), "Telefon & Internet");
    const fixedRows: FinanceRow[] = [
      { id: "rent", label: "Miete", kind: "fixed", planCategory: "Miete", values: { "2026-08": 650, "2026-09": 650, "2026-10": 650 } },
      { id: "phone", label: "Handy", kind: "fixed", planCategory: "Telefon & Internet", values: { "2026-08": 25, "2026-09": 25 },
        fixedSource: { key: "phone", bookingIds: charges.map((charge) => charge.id), merchantKeys: [], pocket: null, applied: {} } },
    ];
    const contracts = detectContracts(stateWith(charges, { financeRows: fixedRows }), "2026-08-01");
    expect(contracts).toHaveLength(2);
    const rent = contracts.find((contract) => contract.source === "fixed")!;
    expect(rent).toMatchObject({ name: "Miete", amount: 650, interval: "monthly", status: "active", fixedRowId: "rent" });
    expect(contracts.find((contract) => contract.source === "detected")).toMatchObject({ fixedRowId: "phone", status: "active" });
  });
});

describe("contract overrides", () => {
  const base = series("Streamflix Abo", [9.99, 9.99, 9.99], monthsFrom("2026-05-15", 3));

  it("confirms, ignores, edits and cancels detected contracts", () => {
    const id = detectContracts(stateWith(base), "2026-08-01")[0].id;
    const confirmed = detectContracts(stateWith(base, { contracts: upsertContractOverride(undefined, id, { status: "confirmed", amount: 11, name: "Streamflix" }, 1) }), "2026-08-01")[0];
    expect(confirmed).toMatchObject({ status: "active", amount: 11, name: "Streamflix", edited: true });
    const ignored = detectContracts(stateWith(base, { contracts: [{ id, status: "ignored", updatedAt: 1 }] }), "2026-08-01")[0];
    expect(ignored.status).toBe("ignored");
    const cancelled = stateWith(base, { contracts: [{ id, status: "cancelled", cancelledAt: "2026-09-01", updatedAt: 1 }] });
    const contracts = detectContracts(cancelled, "2026-08-01");
    expect(contracts[0].status).toBe("cancelled");
    expect(contractChargesBetween(contracts, "2026-08-01", "2026-12-31", "2026-08-01").map((charge) => charge.date)).toEqual(["2026-08-15"]);
    expect(contractSummary(detectContracts(stateWith(base, { contracts: [{ id, status: "ignored", updatedAt: 1 }] }), "2026-08-01"), "2026-08-01").monthly).toBe(0);
  });

  it("adds manual contracts and rejects incomplete ones", () => {
    const contracts = [{ id: "manual:gym", manual: true, name: "Fitnessstudio", amount: 39.9, interval: "monthly" as const, nextDate: "2026-07-01", category: "Sport & Fitness" as const, updatedAt: 1 }];
    const [gym] = detectContracts(stateWith([], { contracts }), "2026-08-10");
    expect(gym).toMatchObject({ source: "manual", status: "active", nextDate: "2026-09-01", type: "gym", monthly: 39.9 });
    expect(appStateSchema.safeParse({ ...stateWith([]), contracts: [{ id: "manual:x", manual: true, name: "X", updatedAt: 1 }] }).success).toBe(false);
  });

  it("updates overrides in place", () => {
    const first = upsertContractOverride(undefined, "a", { status: "confirmed" }, 1);
    const second = upsertContractOverride(first, "a", { note: "Kundennr. 4711" }, 2);
    expect(second).toEqual([{ id: "a", status: "confirmed", note: "Kundennr. 4711", updatedAt: 2 }]);
  });
});

describe("decided suggestions stay decided", () => {
  const decide = (state: AppState, today: string, amount: number, status: "confirmed" | "ignored", at = 1) => {
    const contract = detectContracts(state, today).find((item) => item.amount === amount)!;
    return upsertContractOverride(state.contracts, contract.id, contractPatch(contract, { status }), at);
  };
  const statusOf = (contracts: ReturnType<typeof detectContracts>, amount: number) => contracts.find((item) => item.amount === amount)?.status;
  const review = (contracts: ReturnType<typeof detectContracts>) => contracts.filter((item) => item.status === "review");

  it("stores what the series looked like with the decision", () => {
    const state = stateWith(series("Streamflix Abo", [9.99, 9.99, 9.99], monthsFrom("2026-05-15", 3)));
    const contracts = decide(state, "2026-08-01", 9.99, "confirmed");
    expect(contracts).toEqual([{ id: "streamflix", status: "confirmed", snapshot: { brand: "streamflix", amount: 9.99, interval: "monthly" }, updatedAt: 1 }]);
    expect(appStateSchema.safeParse({ ...state, contracts }).success).toBe(true);
  });

  it("keeps a decision when a price change gives the series a new id", () => {
    const main = series("Gymflex Club", [30, 30, 30, 30, 30, 30, 30, 30], monthsFrom("2026-01-03", 8), "Sport & Fitness");
    const before = [...main, ...series("Gymflex Club", [7.99, 7.99, 7.99], monthsFrom("2026-02-20", 3), "Sport & Fitness")];
    const contracts = decide(stateWith(before), "2026-05-01", 7.99, "ignored");
    const after = [...before, ...series("Gymflex Club", [9.19, 9.19, 9.19], monthsFrom("2026-06-20", 3), "Sport & Fitness")];
    const fresh = detectContracts(stateWith(after), "2026-09-01").find((item) => item.amount === 9.19)!;
    expect(fresh.id).not.toBe(contracts[0].id);
    const result = detectContracts(stateWith(after, { contracts }), "2026-09-01");
    expect(statusOf(result, 9.19)).toBe("ignored");
    expect(result.find((item) => item.amount === 9.19)!.id).toBe(contracts[0].id);
    expect(review(result).map((item) => item.amount)).toEqual([30]);
  });

  it("follows the decisions when the main and the side series swap", () => {
    const yearly = series("Cloudbox Speicher", [5.99, 5.99, 5.99, 5.99], monthsFrom("2026-01-05", 4));
    const family = series("Cloudbox Speicher", [19.99, 19.99, 19.99], monthsFrom("2026-02-18", 3));
    let state = stateWith([...yearly, ...family]);
    state = { ...state, contracts: decide(state, "2026-05-01", 5.99, "confirmed", 1) };
    state = { ...state, contracts: decide(state, "2026-05-01", 19.99, "ignored", 2) };
    expect(state.contracts!.map((entry) => entry.id)[0]).toBe("cloudbox");
    const later = [...yearly, ...family, ...series("Cloudbox Speicher", [19.99, 19.99, 19.99], monthsFrom("2026-05-18", 3))];
    expect(detectContracts(stateWith(later), "2026-08-01").find((item) => item.amount === 19.99)!.id).toBe("cloudbox");
    const result = detectContracts({ ...state, transactions: later }, "2026-08-01");
    expect(statusOf(result, 5.99)).toBe("active");
    expect(statusOf(result, 19.99)).toBe("ignored");
    expect(review(result)).toEqual([]);
    expect(new Set(result.map((item) => item.id)).size).toBe(result.length);
  });

  it("applies decisions saved before snapshots existed", () => {
    const charges = series("Ratenkauf Shop", [30, 30, 30], monthsFrom("2026-05-05", 3), "Shopping");
    const legacy = [{ id: "ratenkauf#3000", status: "ignored" as const, updatedAt: 1 }];
    const exact = detectContracts(stateWith([...charges, ...series("Ratenkauf Shop", [90, 90, 90, 90], monthsFrom("2026-04-20", 4), "Shopping")], { contracts: legacy }), "2026-08-01");
    expect(statusOf(exact, 30)).toBe("ignored");
    expect(statusOf(exact, 90)).toBe("review");
    const renamed = [{ id: "ratenkauf#2999", status: "confirmed" as const, updatedAt: 1 }];
    expect(statusOf(detectContracts(stateWith(charges, { contracts: renamed }), "2026-08-01"), 30)).toBe("active");
    const primary = [{ id: "ratenkauf", status: "confirmed" as const, updatedAt: 1 }];
    expect(statusOf(detectContracts(stateWith(charges, { contracts: primary }), "2026-08-01"), 30)).toBe("active");
    const repeated = [{ id: "ratenkauf#2899", status: "confirmed" as const, updatedAt: 1 }, { id: "ratenkauf#2950", status: "ignored" as const, updatedAt: 2 }];
    expect(statusOf(detectContracts(stateWith(charges, { contracts: repeated }), "2026-08-01"), 30)).toBe("ignored");
  });

  it("keeps parallel series of one merchant apart", () => {
    const small = series("Streamflix Abo", [4.99, 4.99, 4.99, 4.99], monthsFrom("2026-04-03", 4));
    const large = series("Streamflix Abo", [17.99, 17.99, 17.99], monthsFrom("2026-05-21", 3));
    const snapshot = { brand: "streamflix", amount: 4.99, interval: "monthly" as const };
    const decided = detectContracts(stateWith([...small, ...large], { contracts: [{ id: "streamflix#old", status: "confirmed", snapshot, updatedAt: 1 }] }), "2026-08-01");
    expect(statusOf(decided, 4.99)).toBe("active");
    expect(statusOf(decided, 17.99)).toBe("review");
    const legacy = detectContracts(stateWith([...small, ...large], { contracts: [{ id: "streamflix#1234", status: "ignored", updatedAt: 1 }] }), "2026-08-01");
    expect(review(legacy).map((item) => item.amount).sort((a, b) => a - b)).toEqual([4.99, 17.99]);
    const mismatch = detectContracts(stateWith([...small, ...large], { contracts: [{ id: "streamflix", status: "ignored", snapshot: { ...snapshot, amount: 17.99 }, updatedAt: 1 }] }), "2026-08-01");
    expect(statusOf(mismatch, 17.99)).toBe("ignored");
    expect(statusOf(mismatch, 4.99)).toBe("review");
    expect(mismatch.find((item) => item.amount === 4.99)!.id).not.toBe("streamflix");
  });
});

describe("cancellation deadlines and reminders", () => {
  it("computes the latest notice date for monthly terms and fixed terms with renewal", () => {
    expect(cancellationWindow({ notice: { value: 1, unit: "months" }, nextDate: "2026-09-15", interval: "monthly" }, "2026-08-01"))
      .toEqual({ deadline: "2026-08-15", effectiveEnd: "2026-09-15" });
    expect(cancellationWindow({ notice: { value: 1, unit: "months" }, nextDate: "2026-09-15", interval: "monthly" }, "2026-08-20"))
      .toEqual({ deadline: "2026-09-15", effectiveEnd: "2026-10-15" });
    expect(cancellationWindow({ notice: { value: 3, unit: "months" }, termEnd: "2026-10-31", interval: "monthly", renewalMonths: 12 }, "2026-08-15"))
      .toEqual({ deadline: "2027-07-31", effectiveEnd: "2027-10-31" });
    expect(cancellationWindow({ notice: { value: 14, unit: "days" }, termEnd: "2026-08-20", interval: "monthly", autoRenew: false }, "2026-08-15")).toBeUndefined();
    expect(cancellationWindow({ nextDate: "2026-09-15", interval: "monthly" }, "2026-08-01")).toBeUndefined();
  });

  it("reminds of deadlines within 30 days and of recent price increases", () => {
    const transactions = series("Streamflix Abo", [9.99, 9.99, 12.99], monthsFrom("2026-06-15", 3));
    const id = detectContracts(stateWith(transactions), "2026-08-20")[0].id;
    const state = stateWith(transactions, { contracts: [{ id, status: "confirmed", notice: { value: 2, unit: "weeks" }, updatedAt: 1 }] });
    const reminders = contractReminders(detectContracts(state, "2026-08-20"), "2026-08-20");
    expect(reminders.map((reminder) => reminder.kind).sort()).toEqual(["deadline", "price"]);
    expect(reminders.find((reminder) => reminder.kind === "deadline")).toMatchObject({ date: "2026-09-01", tone: "warn" });
  });

  it("summarises running contracts and the next charge", () => {
    const state = stateWith([
      ...series("Streamflix Abo", [10, 10, 10], monthsFrom("2026-05-15", 3)),
      ...series("Kfz Versicherung Donau", [120, 120, 120], ["2026-01-10", "2026-04-10", "2026-07-10"], "Versicherungen"),
    ]);
    const summary = contractSummary(detectContracts(state, "2026-08-01"), "2026-08-01");
    expect(summary).toMatchObject({ monthly: 50, yearly: 600, active: 2, review: 2 });
    expect(summary.next?.name).toBe("Streamflix Abo");
  });
});

describe("weekly rhythms, rules and hand-picked bookings", () => {
  const fortnight = (start: string, count: number) => Array.from({ length: count }, (_, index) => {
    const date = new Date(`${start}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index * 14);
    return date.toISOString().slice(0, 10);
  });

  it("detects bi-weekly payments from four charges on", () => {
    const four = series("Putzhilfe Maria", [45, 45, 45, 45], fortnight("2026-06-19", 4), "Sonstiges");
    const [contract] = detectContracts(stateWith(four), "2026-08-05");
    expect(contract).toMatchObject({ interval: "biweekly", nextDate: "2026-08-14", monthly: 97.5, yearly: 1170 });
    expect(detectContracts(stateWith(four.slice(1)), "2026-08-05")).toEqual([]);
  });

  it("runs weekly manual contracts with weekly charges", () => {
    const contracts = [{ id: "manual:kurs", manual: true, name: "Yogakurs", amount: 10, interval: "weekly" as const, nextDate: "2026-08-03", category: "Sport & Fitness" as const, updatedAt: 1 }];
    const [course] = detectContracts(stateWith([], { contracts }), "2026-08-10");
    expect(course).toMatchObject({ nextDate: "2026-08-10", monthly: 43.33, yearly: 520 });
    expect(contractChargesBetween([course], "2026-08-10", "2026-08-31", "2026-08-10").map((charge) => charge.date))
      .toEqual(["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"]);
  });

  it("matches rules on text, amount range and account", () => {
    const booking = row("2026-08-01", "SEPA Lastschrift FITNESS PRO GmbH Studio Süd", -35, "Sport & Fitness");
    expect(contractRuleMatches(booking, { text: "fitness pro" })).toBe(true);
    expect(contractRuleMatches(booking, { text: "studio sud" })).toBe(true);
    expect(contractRuleMatches(booking, { amountMin: 30, amountMax: 35 })).toBe(true);
    expect(contractRuleMatches(booking, { amountMin: 36 })).toBe(false);
    expect(contractRuleMatches(booking, { account: "Raiffeisen · Testkonto" })).toBe(true);
    expect(contractRuleMatches(booking, { text: "fitness", account: "Bank · Anders" })).toBe(false);
    expect(contractRuleMatches(booking, {})).toBe(false);
    expect(contractRuleMatches({ ...booking, amount: 35 }, { text: "fitness" })).toBe(false);
  });

  it("suggests a rule and the rhythm from picked bookings", () => {
    const picked = series("Fitness Pro", [33, 35, 35], monthsFrom("2026-05-02", 3), "Sport & Fitness");
    expect(suggestContractRule(picked)).toEqual({ text: "Fitness Pro", amountMin: 26.4, amountMax: 43.75, account: "Raiffeisen · Testkonto" });
    expect(suggestContractRule([])).toBeUndefined();
    expect(inferInterval(monthsFrom("2026-01-15", 4))).toBe("monthly");
    expect(inferInterval(fortnight("2026-01-02", 4))).toBe("biweekly");
    expect(inferInterval(["2025-03-01", "2026-03-01"])).toBe("yearly");
    expect(inferInterval(["2026-03-01"])).toBeUndefined();
  });

  it("collects charges of manual contracts by rule and hand-picked bookings without the excluded ones", () => {
    const studio = series("FITNESS PRO GmbH", [35, 35, 35], monthsFrom("2026-05-02", 3), "Sport & Fitness");
    const cash = row("2026-04-02", "Mitgliedsbeitrag Studio Sued", -35, "Sonstiges");
    const shop = row("2026-07-20", "Fitness Pro Shop Shaker", -120, "Shopping");
    const contracts = [{
      id: "manual:gym", manual: true, name: "Fitnessstudio", amount: 35, interval: "monthly" as const, nextDate: "2026-08-02",
      category: "Sport & Fitness" as const, status: "confirmed" as const, bookingIds: [cash.id], excludedBookingIds: [studio[0].id],
      match: { text: "fitness pro", amountMin: 30, amountMax: 40 }, updatedAt: 1,
    }];
    const [gym] = detectContracts(stateWith([...studio, cash, shop], { contracts }), "2026-08-10");
    expect(gym.charges.map((charge) => charge.id)).toEqual([studio[2].id, studio[1].id, cash.id]);
    expect(gym).toMatchObject({ id: "manual:gym", status: "active", lastDate: "2026-07-02", nextDate: "2026-09-02", amount: 35 });
  });

  it("lets a rule-based contract absorb the automatically detected series", () => {
    const charges = series("Streamflix Abo", [9.99, 9.99, 9.99], monthsFrom("2026-05-15", 3));
    expect(detectContracts(stateWith(charges), "2026-08-01")).toHaveLength(1);
    const contracts = [{ id: "manual:stream", manual: true, name: "Streaming", amount: 9.99, interval: "monthly" as const, nextDate: "2026-08-15", match: { text: "streamflix" }, updatedAt: 1 }];
    const result = detectContracts(stateWith(charges, { contracts }), "2026-08-01");
    expect(result.map((contract) => contract.id)).toEqual(["manual:stream"]);
    expect(result[0].charges).toHaveLength(3);
  });

  it("drops deselected charges from a detected contract and offers candidates", () => {
    const charges = series("Streamflix Abo", [9.99, 9.99, 9.99, 9.99], monthsFrom("2026-04-15", 4));
    const state = stateWith(charges);
    const id = detectContracts(state, "2026-08-01")[0].id;
    const edited = detectContracts(stateWith(charges, { contracts: [{ id, status: "confirmed", excludedBookingIds: [charges[3].id], bookingIds: charges.slice(0, 3).map((charge) => charge.id), updatedAt: 1 }] }), "2026-08-01");
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ lastDate: "2026-06-15", status: "active" });
    expect(edited[0].charges).toHaveLength(3);
    const later = [...charges, row("2026-08-15", "Streamflix Abo", -9.99, "Abonnements")];
    const kept = detectContracts(stateWith(later, { contracts: [{ id, excludedBookingIds: [charges[0].id], updatedAt: 1 }] }), "2026-08-20");
    expect(kept[0].charges.map((charge) => charge.date)).toEqual(["2026-08-15", "2026-07-15", "2026-06-15", "2026-05-15"]);
    expect(contractCandidates(state, "2026-08-01").map((candidate) => candidate.date)).toEqual(["2026-07-15", "2026-06-15", "2026-05-15", "2026-04-15"]);
  });
});
