import { describe, expect, it } from "vitest";
import {
  actualBookings,
  actualPockets,
  calculateDashboard,
  calculatePlan,
  classify,
  monthlyInterest,
} from "./calc";
import { createSeed } from "./seed";
import { appStateSchema, type AppState, type Transaction } from "./types";
import { commitStatementImport, prepareStatementImport } from "./import/review";
import {
  parseStatementCsv,
  deduplicateStatements,
  statementFingerprint,
  type StatementResult,
} from "./import/statements";
import { exportWorkbook, parseWorkbook } from "./excel";
import { refreshPlanning } from "./planning";

function stateForTest(): AppState {
  const state = createSeed();
  state.settings.baselineDate = "2026-09-01";
  state.settings.asOf = "2026-09-12";
  state.settings.balances = {
    Sparkonto: 1000,
    Urlaub: 100,
    Motorrad: 0,
    Notgroschen: 5000,
  };
  state.financeRows = [];
  return state;
}
const row = (
  description: string,
  amount: number,
  extra: Partial<Transaction> = {},
): Transaction => ({
  id: crypto.randomUUID(),
  date: "2026-09-12",
  bank: "Revolut",
  pocket: "Lebensmittel",
  description,
  amount,
  category: "Prüfen",
  includeInPlan: true,
  ...extra,
});
const parsed = (rows: Transaction[]): StatementResult => ({
  source: "Revolut",
  file: "test.csv",
  rows,
  skipped: 0,
  issues: [],
});
function ingest(state: AppState, result: StatementResult) {
  const prepared = prepareStatementImport([result], state);
  return commitStatementImport(state, prepared.automatic, [], prepared.metadata)
    .state;
}

describe("statement-only UX rules", () => {
  it("treats Amazon as extra spending, never as a savings credit", () => {
    const state = stateForTest();
    state.transactions = [
      row("AMAZON", -80, { category: "Transfer", includeInPlan: false }),
    ];
    expect(classify(state.transactions[0])).toMatchObject({
      isTransfer: false,
      includeInPlan: false,
    });
    expect(actualPockets(state).Sparkonto).toBe(920);
    expect(calculateDashboard(state).current.actualSpending).toBe(80);
    state.pocketSnapshots = [
      {
        bank: "Revolut",
        pocket: "Sparkonto",
        date: "2026-09-12",
        balance: 920,
      },
    ];
    expect(actualPockets(state).Sparkonto).toBe(920);
    state.settings.asOf = "2026-09-13";
    state.transactions.push(
      row("Amazon", -20, {
        date: "2026-09-13",
        bank: "Amex",
        pocket: "AMEX Jannis",
      }),
    );
    expect(actualPockets(state).Sparkonto).toBe(900);
    state.transactions.push(
      row("Transfer intern", -20, { date: "2026-09-13", pocket: "Sparen" }),
    );
    expect(actualPockets(state).Sparkonto).toBe(900);
  });

  it("includes fixed receipts in actual expenses and categories exactly once", () => {
    const state = stateForTest();
    state.financeRows = [
      {
        id: "insurance",
        kind: "fixed",
        label: "Haftpflicht",
        values: { "2026-09": 50 },
      },
    ];
    const booking = row("Allianz", -50);
    const saved = ingest(state, parsed([booking]));
    expect(saved.transactions).toHaveLength(0);
    expect(calculateDashboard(saved).current.actualSpending).toBe(50);
    expect(calculateDashboard(saved).spending).toContainEqual({
      name: "Versicherungen",
      value: 50,
    });
    expect(actualBookings(saved)[0].description).toBe("Allianz");
    saved.transactions.push({ ...booking, occurrence: 1 });
    expect(calculateDashboard(saved).current.actualSpending).toBe(50);
    expect(
      ingest(saved, parsed([{ ...booking, id: "reimport" }])).fixedReceipts,
    ).toEqual(saved.fixedReceipts);
  });

  it("persists the review queue, accepts more files and assigns the same merchant in bulk", async () => {
    let state = ingest(stateForTest(), parsed([row("Neuer Laden", -10)]));
    state = refreshPlanning(
      appStateSchema.parse(JSON.parse(JSON.stringify(state))),
      "2026-09-12",
    );
    expect(state.reviewQueue).toHaveLength(1);
    state = ingest(
      state,
      parsed([
        row("Neuer Laden", -15, { date: "2026-09-11" }),
        row("Anderer Laden", -5),
      ]),
    );
    expect(state.reviewQueue).toHaveLength(3);
    const restored = (await parseWorkbook(await exportWorkbook(state))).state;
    expect(restored.reviewQueue).toEqual(state.reviewQueue);
    const first = restored.reviewQueue![0];
    if (first.kind !== "booking" || first.draft.amount === null)
      throw new Error("Expected booking");
    const saved = commitStatementImport(restored, [
      {
        ...first.draft,
        amount: first.draft.amount,
        category: "Shopping",
        categoryOverride: true,
      },
    ]).state;
    expect(saved.transactions).toHaveLength(2);
    expect(
      saved.transactions.every((item) => item.category === "Shopping"),
    ).toBe(true);
    expect(saved.reviewQueue).toHaveLength(1);
    expect(saved.importStatus).toMatchObject({ imported: 2, issues: [] });
    const again = ingest(
      saved,
      parsed([row("Neuer Laden", -10), row("Anderer Laden", -5)]),
    );
    expect(again.transactions).toHaveLength(2);
    expect(again.reviewQueue).toHaveLength(1);
  });

  it("keeps identical real purchases and different pockets while repeat files are idempotent", () => {
    const csv = `Revolut\nLebensmittel (EUR)\nDatum,Beschreibung,Betrag\n12.09.2026,BILLA,-15\n12.09.2026,BILLA,-15\nMittagessen (EUR)\nDatum,Beschreibung,Betrag\n12.09.2026,BILLA,-15`;
    const state = ingest(stateForTest(), parseStatementCsv(csv));
    expect(state.transactions).toHaveLength(3);
    expect(new Set(state.transactions.map(statementFingerprint)).size).toBe(3);
    expect(ingest(state, parseStatementCsv(csv)).transactions).toEqual(
      state.transactions,
    );
    const a = row("Shop", -10, { bankReference: "a" });
    const b = { ...a, id: "b", bankReference: "b" };
    expect(
      deduplicateStatements(
        [a, b, { ...a, id: "repeat", description: "Changed text" }],
        [],
      ).rows,
    ).toHaveLength(2);
  });

  it("extracts bank references and preserves them in backup", async () => {
    const result = parseStatementCsv(
      "Revolut\nDatum,Beschreibung,Betrag,Referenz\n12.09.2026,BILLA,-15,bank-1\n12.09.2026,BILLA,-15,bank-2",
    );
    expect(result.rows.map((item) => item.bankReference)).toEqual([
      "bank-1",
      "bank-2",
    ]);
    const state = ingest(stateForTest(), result);
    const restored = (await parseWorkbook(await exportWorkbook(state))).state;
    expect(restored.transactions).toEqual(state.transactions);
  });

  it("separates TR from every Revolut Notgroschen and preserves original account names", async () => {
    const csv = `Revolut\nZeitraum,01.09.2026 bis 12.09.2026\nNotgroschen (EUR)\nSchlussguthaben,10\nMittagessen (EUR)\nSchlussguthaben,20\nLebensmittel (EUR)\nSchlussguthaben,30\nEntertainment & Haushalt (EUR)\nSchlussguthaben,40\nTanken (EUR)\nSchlussguthaben,50\nUrlaub neu (EUR)\nSchlussguthaben,60`;
    const state = ingest(stateForTest(), parseStatementCsv(csv));
    expect(state.accountSnapshots).toHaveLength(6);
    expect(state.pocketSnapshots ?? []).toEqual([]);
    expect(actualPockets(state).Notgroschen).toBe(5000);
    expect(actualPockets(state).Urlaub).toBe(100);
    state.trBalances = [{ date: "2026-09-11", balance: 5200 }];
    state.settings.interestRates = [{ date: "2026-01-01", rate: 0.04 }];
    const restored = (await parseWorkbook(await exportWorkbook(state))).state;
    expect(restored.accountSnapshots).toEqual(state.accountSnapshots);
    expect(restored.trBalances).toEqual(state.trBalances);
    expect(restored.settings.interestRates).toEqual(
      state.settings.interestRates,
    );
    const october = refreshPlanning(restored, "2026-10-12");
    expect(actualPockets(october).Notgroschen).toBe(5200);
    expect(
      calculateDashboard(october).timeline.find(
        (item) => item.month === "2026-11",
      )!.end.Notgroschen,
    ).toBeGreaterThan(5200);
    october.trBalances!.push({ date: "2026-10-12", balance: 5300 });
    expect(actualPockets(october).Notgroschen).toBe(5300);
    expect(actualPockets(october, "2026-09-12").Notgroschen).toBe(5200);
  });

  it("reduces the original category by refunds and excludes Raphael only from the plan", () => {
    const history = ["05", "06", "07", "08"].map((month) =>
      row("BILLA", -100, {
        date: `2026-${month}-01`,
        bank: "Amex",
        pocket: "AMEX Jannis",
      }),
    );
    const refund = row("BILLA Erstattung", 5, {
      date: "2026-08-02",
      bank: "Amex",
      pocket: "AMEX Jannis",
    });
    const raphael = row("BILLA", -200, {
      bank: "Amex",
      pocket: "AMEX Raphael",
    });
    const state = ingest(stateForTest(), parsed([...history, refund, raphael]));
    expect(state.transactions).toHaveLength(6);
    expect(state.transactions.find((item) => item.amount === 5)?.category).toBe(
      "Lebensmittel",
    );
    expect(calculatePlan(state.transactions, state.settings.asOf).total).toBe(
      98.25,
    );
    expect(
      classify(
        state.transactions.find((item) => item.pocket === "AMEX Raphael")!,
      ).includeInPlan,
    ).toBe(false);
    state.settings.asOf = "2026-08-31";
    expect(calculateDashboard(state).current.actualSpending).toBe(95);
  });

  it.each([
    "13. Gehalt",
    "13. Monatsgehalt",
    "Juni Bonus",
    "Rufbereitschaft",
    "Urlaubsgeld",
  ])("never promotes %s even with an existing salary rule", (description) => {
    const state = stateForTest();
    state.financeRows = [
      {
        id: "salary",
        kind: "income",
        label: "Gehalt",
        values: { "2026-09": 2000, "2026-10": 2000 },
      },
    ];
    const saved = ingest(
      state,
      parsed([
        row(description, 3000, { category: "Gehalt", categoryOverride: true }),
      ]),
    );
    expect(saved.reviewQueue ?? []).toEqual([]);
    expect(saved.financeRows).toEqual(state.financeRows);
    expect(actualBookings(saved)).toHaveLength(1);
    expect(calculateDashboard(saved).current.received).toBe(3000);
  });

  it("remembers a rejected changed amount across months and Excel restore", async () => {
    const state = stateForTest();
    state.financeRows = [
      {
        id: "lease",
        kind: "fixed",
        label: "Leasing",
        values: { "2026-09": 100, "2026-10": 100, "2026-11": 100 },
      },
    ];
    const pending = ingest(state, parsed([row("Porsche Bank", -110)]));
    const item = pending.reviewQueue![0];
    if (item.kind !== "fixed") throw new Error("Expected fixed review");
    const saved = commitStatementImport(
      pending,
      [],
      [{ change: item.change, accept: false }],
    ).state;
    const restored = (await parseWorkbook(await exportWorkbook(saved))).state;
    const next = ingest(
      restored,
      parsed([row("Porsche Bank", -110, { date: "2026-10-12" })]),
    );
    expect(next.reviewQueue).toEqual([]);
    expect(next.financeRows[0].values["2026-10"]).toBe(100);
    expect(actualBookings(next)).toHaveLength(2);
    expect(
      ingest(next, parsed([row("Porsche Bank", -120, { date: "2026-11-12" })]))
        .reviewQueue,
    ).toHaveLength(1);
  });

  it("retains the historical budget plus only the partial current month and applies rate history", () => {
    const rows = ["05", "06", "07", "08", "09"].map((month) =>
      row("Mensa", -100, { date: `2026-${month}-01` }),
    );
    expect(calculatePlan(rows, "2026-09-12").total).toBe(140);
    expect(
      monthlyInterest(12000, "2026-10", {
        ...stateForTest().settings,
        interestRates: [{ date: "2026-10-01", rate: 0.04 }],
      }),
    ).toBe(29);
  });
});
