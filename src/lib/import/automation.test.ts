import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  actualPockets,
  calculateDashboard,
  missingFixedCosts,
  monthsForYear,
} from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { refreshPlanning } from "@/lib/planning";
import { createSeed } from "@/lib/seed";
import { emptyMonth, type AppState, type Transaction } from "@/lib/types";
import { commitStatementImport, prepareStatementImport } from "./review";
import {
  parseStatementCsv,
  statementFingerprint,
  type StatementResult,
} from "./statements";

function stateForTest() {
  const state = createSeed();
  state.settings.baselineDate = "2026-09-01";
  state.settings.asOf = "2026-09-12";
  state.settings.allocationStart = "2026-09-01";
  state.settings.balances = {
    Sparkonto: 900,
    Urlaub: 800,
    Motorrad: 0,
    Notgroschen: 4000,
  };
  state.financeRows = [
    {
      id: "income",
      label: "Gehalt",
      kind: "income",
      values: { "2026-09": 1000, "2026-10": 1000 },
    },
  ];
  state.months = Object.fromEntries(
    [...monthsForYear(2026), ...monthsForYear(2027)].map((month) => [
      month,
      emptyMonth(),
    ]),
  );
  return state;
}
const row = (
  description: string,
  amount = -14.99,
  date = "2026-09-03",
): Transaction => ({
  id: crypto.randomUUID(),
  date,
  description,
  amount,
  category: "Prüfen",
  bank: "Raiffeisen",
  pocket: "Raiffeisen Giro",
  includeInPlan: true,
});
const result = (rows: Transaction[]): StatementResult => ({
  source: "Raiffeisen",
  file: "test.csv",
  rows,
  issues: [],
  skipped: 0,
});
function importResult(state: AppState, parsed: StatementResult) {
  const prepared = prepareStatementImport([parsed], state);
  return commitStatementImport(
    state,
    prepared.automatic,
    [],
    prepared.metadata,
  );
}
const consolidated = `Revolut
Zeitraum,01.09.2026 bis 11.09.2026
Sparen (EUR)
,,Schlussguthaben,"1 782,59€"
Urlaub 2026 (EUR)
Eröffnungskontostand,Schlussguthaben
"1 200,00€","1 312,06€"
Notgroschen (EUR)
,,Schlussguthaben,"0,00€"
Motorrad (EUR)
,,Schlussguthaben,"900,00€"
Lebensmittel (EUR)
,,Schlussguthaben,"200,00€"
Mittagessen (EUR)
,,Schlussguthaben,"100,00€"
Tanken (EUR)
,,Schlussguthaben,"80,00€"
Entertainment (EUR)
,,Schlussguthaben,"70,00€"
Sparen (EUR)
Kontoauszug zu Transaktionen
Datum,Beschreibung,Kategorie,Geld ein-/ausgezahlt,Guthaben
03.09.2026,Um EUR Sparen einzustecken,Transfer intern,"50,00€","1 782,59€"
Motorrad (EUR)
Kontoauszug zu Transaktionen
Datum,Beschreibung,Kategorie,Geld ein-/ausgezahlt,Guthaben
03.09.2026,Um EUR Motorrad einzustecken,Transfer intern,"900,00€","900,00€"`;

describe("Revolut closing balances", () => {
  it("reads vertical and horizontal closings, excludes operating pots and an unmoved emergency pocket", () => {
    const parsed = parseStatementCsv(consolidated);
    expect(parsed.issues).toEqual([]);
    expect(parsed.pocketSnapshots).toEqual(
      expect.arrayContaining([
        {
          pocket: "Sparkonto",
          date: "2026-09-11",
          bank: "Revolut",
          balance: 1782.59,
        },
        {
          pocket: "Urlaub",
          date: "2026-09-11",
          bank: "Revolut",
          balance: 1312.06,
        },
        {
          pocket: "Motorrad",
          date: "2026-09-11",
          bank: "Revolut",
          balance: 900,
        },
      ]),
    );
    expect(parsed.pocketSnapshots).toHaveLength(3);
    const saved = importResult(stateForTest(), parsed);
    expect(saved.state.transactions).toHaveLength(2); // Only original statement rows.
    expect(actualPockets(saved.state)).toEqual({
      Sparkonto: 1782.59,
      Urlaub: 1312.06,
      Motorrad: 900,
      Notgroschen: 4000,
    });
    const again = importResult(saved.state, parsed);
    expect(again.added).toBe(0);
    expect(again.state).toEqual(saved.state);
  });
  it("uses the last dated running balance, not the sum of pocket shifts", () => {
    const parsed = parseStatementCsv(
      `Revolut\nSparen (EUR)\nDatum,Beschreibung,Geld ein-/ausgezahlt,Guthaben\n11.09.2026,Um EUR Sparen einzustecken,10,120\n10.09.2026,Um EUR Sparen einzustecken,10,110`,
    );
    expect(parsed.pocketSnapshots).toEqual([
      {
        bank: "Revolut",
        pocket: "Sparkonto",
        date: "2026-09-11",
        balance: 120,
      },
    ]);
  });
  it("accepts a dated closing-only statement and rejects ambiguous undated balances", () => {
    const parsed = parseStatementCsv(
      'Revolut\nSparen (EUR)\nSchlussguthaben,"0,00€"',
      "consolidated_2026-09-01_2026-09-11.csv",
    );
    expect(parsed.rows).toEqual([]);
    expect(parsed.pocketSnapshots?.[0].balance).toBe(0);
    expect(() =>
      parseStatementCsv('Revolut\nSparen (EUR)\nSchlussguthaben,"5,00€"'),
    ).toThrow();
  });
  it("keeps a moving Revolut emergency pocket separate from Trade Republic", () => {
    const source = `${consolidated}\nNotgroschen (EUR)\nKontoauszug zu Transaktionen\nDatum,Beschreibung,Geld ein-/ausgezahlt,Guthaben\n11.09.2026,Auszahlung bei Pocket,-1,0`;
    const state = importResult(stateForTest(), parseStatementCsv(source)).state;
    expect(actualPockets(state).Notgroschen).toBe(4000);
    expect(state.accountSnapshots).toContainEqual({
      bank: "Revolut",
      name: "Notgroschen",
      date: "2026-09-11",
      balance: 0,
    });
    expect(state.settings.balances.Notgroschen).toBe(4000);
    const october = calculateDashboard(refreshPlanning(state, "2026-10-12"));
    expect(
      october.timeline.find((month) => month.month === "2026-10")!.interest,
    ).toBeCloseTo(6.04, 2);
  });
  it("does not let older imports replace a newer closing or count covered movements twice", () => {
    const state = importResult(
      stateForTest(),
      parseStatementCsv(consolidated),
    ).state;
    state.transactions.push({
      ...row("Um EUR Sparen einzustecken", 25, "2026-09-12"),
      bank: "Revolut",
      pocket: "Sparen",
      category: "Transfer intern",
    });
    const old = parseStatementCsv(
      "Revolut\nSparen (EUR)\nSchlussguthaben,100\nDatum,Beschreibung,Geld ein-/ausgezahlt,Guthaben\n05.09.2026,Um EUR Sparen einzustecken,30,100",
    );
    const saved = importResult(state, old).state;
    expect(actualPockets(saved).Sparkonto).toBe(1807.59);
    expect(
      actualPockets({
        ...saved,
        settings: { ...saved.settings, asOf: "2026-09-11" },
      }).Sparkonto,
    ).toBe(1782.59);
  });
  it("anchors the forecast at imported actuals and does not execute the same monthly transfer again", () => {
    const state = importResult(
      stateForTest(),
      parseStatementCsv(consolidated),
    ).state;
    const d = calculateDashboard(state);
    const september = d.timeline.find((month) => month.month === "2026-09")!;
    expect(september.rates.Motorrad).toBe(900);
    expect(september.end.Motorrad).toBe(900); // Already executed.
    expect(september.end.Sparkonto).toBe(1832.59); // Only 50 of planned 100 remain.
    expect(d.countdown.remaining).toBe(7600);
    expect(d.ninetyDays[1].bikeTransfer).toBe(900);
  });
  it("keeps this month's executed motorcycle allocation and switches following months to 60/40", () => {
    const state = importResult(
      stateForTest(),
      parseStatementCsv(consolidated),
    ).state;
    state.pocketSnapshots!.find((item) => item.pocket === "Motorrad")!.balance =
      8500;
    const d = calculateDashboard(state);
    const september = d.timeline.find((month) => month.month === "2026-09")!;
    const october = d.timeline.find((month) => month.month === "2026-10")!;
    expect(september.rates).toMatchObject({
      Motorrad: 900,
      Sparkonto: 60,
      Urlaub: 40,
    });
    expect(september.end.Motorrad).toBe(8500);
    expect(october.rates).toMatchObject({
      Motorrad: 0,
      Sparkonto: 600,
      Urlaub: 400,
    });
    expect(d.countdown.funded).toBe(true);
  });
  const example = new URL(
    "../../../import-example/consolidated_statement_2026-08-19_2026-09-11.csv",
    import.meta.url,
  );
  it.skipIf(!existsSync(example))(
    "reconciles the supplied consolidated CSV",
    () => {
      const parsed = parseStatementCsv(
        readFileSync(example, "utf8"),
        "consolidated_2026-08-19_2026-09-11.csv",
      );
      const saved = importResult(stateForTest(), parsed).state;
      expect(actualPockets(saved)).toEqual({
        Sparkonto: 1782.59,
        Urlaub: 1312.06,
        Motorrad: 0,
        Notgroschen: 4000,
      });
      expect(saved.pocketSnapshots).toHaveLength(3);
    },
  );
});

describe("automatic reconciliation and merchant choices", () => {
  function fixedState() {
    const state = stateForTest();
    state.financeRows = [
      {
        id: "insurance",
        kind: "fixed",
        label: "Haftpflicht",
        values: { "2026-09": 48.88, "2026-10": 48.88 },
      },
    ];
    return state;
  }
  it("records matching fixed statements as evidence, not duplicate ledger bookings", () => {
    const state = fixedState();
    expect(missingFixedCosts(state)).toEqual(["Haftpflicht"]);
    expect(
      missingFixedCosts({
        ...state,
        settings: { ...state.settings, asOf: "2026-09-05" },
      }),
    ).toEqual([]);
    const saved = importResult(state, result([row("Allianz", -48.88)]));
    expect(saved.added).toBe(0);
    expect(saved.state.transactions).toEqual([]);
    expect(saved.state.fixedReceipts).toHaveLength(1);
    expect(missingFixedCosts(saved.state)).toEqual([]);
    expect(
      missingFixedCosts(refreshPlanning(saved.state, "2026-10-06")),
    ).toEqual(["Haftpflicht"]);
  });
  it("does not ask about an already imported fixed receipt after the plan changes", () => {
    const original = row("Allianz", -48.88);
    const state = importResult(fixedState(), result([original])).state;
    state.financeRows[0].values["2026-09"] = 55;
    const prepared = prepareStatementImport([result([original])], state);
    expect(prepared).toMatchObject({
      review: [],
      automatic: [],
      duplicates: 1,
    });
  });
  it("recognizes an auto-deduped PayPal fixed merchant on a later price change, including after Excel restore", async () => {
    const state = stateForTest();
    state.financeRows = [
      {
        id: "apple",
        kind: "fixed",
        label: "Apple Care",
        values: { "2026-09": 14.99, "2026-10": 14.99 },
      },
    ];
    const merchant =
      "PayPal Europe Referenz 123456 Mandat: APPLE-ABO, 02.10.2021";
    const saved = importResult(state, result([row(merchant)])).state;
    expect(saved.transactions).toEqual([]);
    expect(saved.fixedReceipts![0].merchantKey).toContain("mandat:apple-abo");
    const restored = (await parseWorkbook(await exportWorkbook(saved))).state;
    const changed = row(
      merchant.replace("123456", "987654"),
      -17.99,
      "2026-10-03",
    );
    expect(
      prepareStatementImport([result([changed])], restored).review[0],
    ).toMatchObject({
      kind: "fixed",
      change: { category: "Apple Care", previous: 14.99, amount: 17.99 },
    });
    restored.merchantRules = [
      { key: saved.fixedReceipts![0].merchantKey!, category: "Shopping" },
    ];
    const explicit = prepareStatementImport([result([changed])], restored);
    expect(explicit.review).toEqual([]);
    expect(explicit.automatic[0].category).toBe("Shopping");
    expect(
      prepareStatementImport(
        [result([row("PayPal anderer Händler", -17.99, "2026-10-03")])],
        restored,
      ).review[0].kind,
    ).toBe("booking");
  });
  it("backfills receipts for previously reviewed fixed bookings from legacy backups", () => {
    const state = fixedState();
    const booking = row("Allianz", -50);
    state.ignoredStatementKeys = [statementFingerprint(booking)];
    const prepared = prepareStatementImport([result([booking])], state);
    expect(prepared.review).toEqual([]);
    const saved = importResult(state, result([booking])).state;
    expect(saved.transactions).toEqual([]);
    expect(saved.fixedReceipts).toHaveLength(1);
    expect(saved.financeRows[0].values["2026-09"]).toBe(48.88);
    expect(missingFixedCosts(saved)).toEqual([]);
  });
  it.each([true, false])(
    "changed fixed receipt is reconciled for accept=%s without another booking",
    (accept) => {
      const state = fixedState();
      const prepared = prepareStatementImport(
        [result([row("Allianz", -50)])],
        state,
      );
      const item = prepared.review[0];
      expect(item.kind).toBe("fixed");
      if (item.kind !== "fixed") throw new Error("Expected fixed decision");
      const saved = commitStatementImport(
        state,
        [],
        [{ change: item.change, accept }],
      ).state;
      expect(saved.transactions).toEqual([]);
      expect(saved.financeRows[0].values["2026-10"]).toBe(accept ? 50 : 48.88);
      expect(missingFixedCosts(saved)).toEqual([]);
    },
  );
  it("remembers explicit merchant choices and does not apply them to unrelated merchants or banks", () => {
    const chosen = {
      ...row("Neuer Shop Referenz 123456"),
      category: "Shopping" as const,
      categoryOverride: true,
    };
    const saved = commitStatementImport(stateForTest(), [chosen]).state;
    const next = prepareStatementImport(
      [result([row("Neuer Shop Referenz 789012", -20, "2026-09-04")])],
      saved,
    );
    expect(next.review).toEqual([]);
    expect(next.automatic[0]).toMatchObject({
      category: "Shopping",
      categoryOverride: true,
      includeInPlan: true,
    });
    const other = prepareStatementImport(
      [
        result([
          row("Anderer Shop Referenz 789012"),
          { ...row("Neuer Shop Referenz 789012"), bank: "Amex" },
        ]),
      ],
      saved,
    );
    expect(other.review).toHaveLength(2);
  });
  it("keeps learning even when a reviewed fixed booking matches a grid amount", () => {
    const state = fixedState();
    const chosen = {
      ...row("Versicherungsdienst", -48.88),
      category: "Haftpflicht" as const,
      categoryOverride: true,
    };
    const saved = commitStatementImport(state, [chosen]).state;
    expect(saved.transactions).toEqual([]);
    expect(saved.merchantRules).toHaveLength(1);
    const next = prepareStatementImport(
      [result([row("Versicherungsdienst", -50, "2026-10-03")])],
      saved,
    );
    expect(next.review[0]).toMatchObject({
      kind: "fixed",
      change: { category: "Haftpflicht", previous: 48.88, amount: 50 },
    });
  });
  it("does not turn on-call pay into a salary change just because the sender is the same", () => {
    const state = stateForTest();
    state.financeRows = [
      {
        id: "salary",
        label: "Gehalt",
        kind: "income",
        values: { "2026-09": 2500 },
      },
      {
        id: "on-call",
        label: "Rufbereitschaft",
        kind: "income",
        values: { "2026-09": 250 },
      },
    ];
    const saved = importResult(
      state,
      result([row("TeamTalentSolutions Gehalt", 2500)]),
    ).state;
    const next = prepareStatementImport(
      [result([row("TeamTalentSolutions Gehalt", 250, "2026-09-04")])],
      saved,
    );
    expect(next.review).toEqual([]);
    expect(next.duplicates).toBe(1);
    expect(next.metadata.fixedReceipts[0].category).toBe("Rufbereitschaft");
  });
  it("rebuilds learned variable categories on reload, preserving explicit overrides", () => {
    const state = stateForTest();
    state.transactions = ["05", "06", "07", "08"].map((month) => ({
      ...row("Bekannter Shop", -100, `2026-${month}-01`),
      category: "Shopping",
      categoryOverride: true,
    }));
    state.financeRows.push({
      id: "shopping",
      label: "Shopping",
      kind: "variable",
      planCategory: "Shopping",
      values: {},
      overrides: { "2026-10": 33 },
    });
    const refreshed = refreshPlanning(state, "2026-09-12");
    expect(
      refreshed.financeRows.find((line) => line.id === "shopping")!.values,
    ).toMatchObject({ "2026-09": 100, "2026-10": 33, "2027-12": 100 });
    const october = refreshPlanning(refreshed, "2026-10-01");
    expect(calculateDashboard(october).plan.months).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
    ]);
    expect(
      october.financeRows.find((line) => line.id === "shopping")!.values[
        "2026-11"
      ],
    ).toBe(65);
    expect(calculateDashboard(october).countdown.days).toBeLessThan(
      calculateDashboard(refreshed).countdown.days,
    );
  });
  it("round-trips closing balances, receipts and merchant rules through Excel", async () => {
    let state = importResult(
      fixedState(),
      parseStatementCsv(consolidated),
    ).state;
    state = commitStatementImport(state, [
      {
        ...row("Versicherungsdienst", -48.88),
        category: "Haftpflicht",
        categoryOverride: true,
      },
    ]).state;
    const restored = (await parseWorkbook(await exportWorkbook(state))).state;
    expect(restored).toEqual(state);
    expect(actualPockets(restored)).toEqual(actualPockets(state));
    expect(missingFixedCosts(restored)).toEqual([]);
    expect(
      prepareStatementImport(
        [result([row("Versicherungsdienst", -48.88, "2026-10-03")])],
        restored,
      ).review,
    ).toEqual([]);
  });
});
