import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  actualPockets,
  calculateDashboard,
  calculatePlan,
  classify,
  classifyStatementRows,
  monthsForYear,
} from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { refreshPlanning } from "@/lib/planning";
import { applyVariableBudgets } from "@/lib/variable-budgets";
import { createSeed } from "@/lib/seed";
import {
  appStateSchema,
  emptyMonth,
  type AppState,
  type Category,
  type Transaction,
} from "@/lib/types";
import { parseAmexText } from "./amex-pdf";
import {
  commitStatementImport,
  prepareStatementImport,
  splitFixedBookings,
} from "./review";
import {
  parseStatementCsv,
  parseStatementFile,
  type StatementResult,
} from "./statements";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const transaction = (
  description: string,
  amount: number,
  date = "2026-09-03",
): Transaction => ({
  id: crypto.randomUUID(),
  date,
  description,
  amount,
  bank: "Raiffeisen",
  pocket: "Raiffeisen Giro",
  category: "Prüfen",
  includeInPlan: true,
});
const resultFor = (rows: Transaction[]): StatementResult => ({
  source: "Raiffeisen",
  file: "Test.csv",
  rows,
  skipped: 0,
  issues: [],
});

describe("real statement layouts", () => {
  it("detects the headerless Raiffeisen export by structure, not filename", () => {
    const result = parseStatementCsv(
      fixture("raiffeisen-real.csv"),
      "unbenannt.csv",
    );
    expect(result.source).toBe("Raiffeisen");
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      date: "2026-08-19",
      amount: -13.15,
      category: "Restaurants",
    });
    expect(result.issues).toEqual([]);
  });
  it("detects Revolut transaction headers beyond 500 summary lines", () => {
    const result = parseStatementCsv(
      `${'"Zusammenfassung",,,,,,,,,,,\n'.repeat(600)}${fixture("revolut-real.csv")}`,
    );
    expect(result.source).toBe("Revolut");
    expect(result.rows.map((row) => row.amount)).toEqual([-2, -1, -2, 1]);
    expect(result.rows.map((row) => row.pocket)).toEqual([
      "Mittagessen",
      "Mittagessen",
      "Mittagessen",
      "Sparen",
    ]);
    expect(result.issues).toEqual([]);
  });
  it("reports malformed amounts as unbooked source-repair drafts, never as bookings", () => {
    const csv = `${fixture("raiffeisen-real.csv")}\n20.08.2026;BIPA;20.08.2026;unlesbar;EUR;20.08.2026 10:53:26:399\n`;
    const parsed = parseStatementCsv(csv);
    const prepared = prepareStatementImport([parsed], createSeed());
    expect(prepared.automatic).toHaveLength(3);
    expect(prepared.review).toHaveLength(1);
    expect(prepared.review[0]).toMatchObject({ kind: "booking", sourceRepair: true, draft: { description: "BIPA", amount: null } });
    expect(prepared.issues).toHaveLength(1);
    expect(parsed.issues[0]).toMatchObject({
      draft: { date: "2026-08-20", description: "BIPA", amount: null },
    });
    const unknown = parseStatementCsv(
      `${fixture("revolut-real.csv")}\nDatum,Anderes Layout,Unbekannter Betrag\n21.08.2026,BIPA,3`,
    );
    expect(unknown.rows).toHaveLength(4);
    expect(unknown.issues[0]).toMatchObject({
      message: expect.stringContaining("Unbekannter Dateiabschnitt"),
      draft: { pocket: null, amount: null },
    });
  });
  it("extracts real Amex text with split amounts, CR refunds and two holders", () => {
    const parsed = parseAmexText([fixture("amex-real.txt")]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(8);
    expect(parsed.skipped).toBe(1);
    expect(parsed.rows.some((row) => /ZAHLUNG\/ÜBERWEISUNG ERHALTEN/i.test(row.description))).toBe(false);
    expect(parsed.rows[0]).toMatchObject({ date: "2026-07-11", amount: -10.1 });
    expect(parsed.rows[4].amount).toBe(16.13);
    expect(parsed.rows[5].pocket).toBe("AMEX Raphael");
    expect(parsed.rows[7]).toMatchObject({ amount: 4, pocket: "AMEX Jannis" });
  });
  it("infers the prior year and retains messy PDF lines rather than rejecting the file", () => {
    const parsed = parseAmexText([
      "American Express\n10.01.27 10.02.27\nUmsatz vom Buchung am Details Betrag in EUR\n31.12 02.01 BILLA 12,50\n02.01 02.01 Text ohne Betrag\n03.01 unvollständig",
    ]);
    expect(parsed.rows[0]).toMatchObject({ date: "2026-12-31", amount: -12.5 });
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.issues.every((issue) => issue.draft?.amount === null)).toBe(
      true,
    );
    expect(prepareStatementImport([parsed], createSeed()).issues).toHaveLength(
      2,
    );
    const review = prepareStatementImport([parsed], createSeed()).review;
    expect(review).toHaveLength(2);
    expect(review.every((item) => item.kind === "booking" && item.sourceRepair === true)).toBe(true);
    expect(parseAmexText([""]).issues[0].message).toContain("Scan");
  });
  const examples = new URL("../../../import-example/", import.meta.url);
  // Private, git-ignored originals; the folder may also hold later, unrelated (e.g. encrypted) statements.
  const originalFiles = [
    "Umsatzliste_AT023928800000327551.csv",
    "consolidated_statement_2026-08-19_2026-09-11.csv",
    "11072026_-_10082026.pdf",
  ];
  it.skipIf(!originalFiles.every((name) => existsSync(new URL(name, examples))))(
    "parses all three supplied original files including binary PDF",
    async () => {
      const expected = { Raiffeisen: 40, Revolut: 173, Amex: 57 };
      const sources: string[] = [];
      for (const name of originalFiles) {
        const data = readFileSync(new URL(name, examples));
        const parsed = await parseStatementFile({
          name,
          size: data.length,
          arrayBuffer: async () => Uint8Array.from(data).buffer,
        });
        expect(parsed.source).not.toBeNull();
        sources.push(parsed.source!);
        expect(parsed.rows).toHaveLength(expected[parsed.source!]);
        expect(parsed.issues).toEqual([]);
        if (parsed.source === "Amex")
          expect(
            parsed.rows.reduce((sum, row) => sum + row.amount, 0),
          ).toBeCloseTo(-1529.58, 2);
      }
      expect(sources.sort()).toEqual(["Amex", "Raiffeisen", "Revolut"]);
    },
  );
});

describe("automatic import and fixed-cost review", () => {
  it("automatically selects only confident rows and keeps unknown merchants out", () => {
    const state = createSeed();
    const prepared = prepareStatementImport(
      [
        resultFor([
          transaction("BIPA", -4),
          transaction("Unbekannter Händler", -5),
        ]),
      ],
      state,
    );
    expect(prepared.automatic).toHaveLength(1);
    expect(prepared.review).toHaveLength(1);
    expect(commitStatementImport(state, prepared.automatic).added).toBe(1);
  });
  it("does not infer PayPal recurrence from a different merchant with the same amount", () => {
    const rows = classifyStatementRows(
      [transaction("PayPal Unbekannt", -12.99)],
      [transaction("PayPal Spotify", -12.99, "2026-08-03")],
    );
    expect(rows[0].category).toBe("Prüfen");
  });
  it.each([
    ["Gehalt", "Nettogehalt", "TeamTalentSolutions Gehalt", 2576.43],
    ["Leasing", "Leasing / Autokredit", "Porsche Bank", -289.52],
    ["Vollkasko", "Vollkasko", "Vollkasko Dauerauftrag", -63.25],
    ["Haftpflicht", "Haftpflicht", "Allianz", -48.88],
    ["Handyvertrag", "Handyvertrag", "A1 Telekom", -25.85],
    ["Apple Care", "Apple Care (PayPal)", "Apple Care", -14.99],
    ["Barber", "Barber", "Barber", -20],
    ["Rufbereitschaft", "Rufbereitschaft", "Rufbereitschaft", 250],
  ] as const)(
    "dedupes %s by month, questions changes and propagates only on yes",
    (category, label, description, amount) => {
      const state = createSeed();
      const previous = Math.abs(amount);
      state.financeRows = [
        {
          id: "fixed",
          kind:
            category === "Gehalt" || category === "Rufbereitschaft"
              ? "income"
              : "fixed",
          label,
          values: Object.fromEntries(
            monthsForYear(2026).map((month) => [month, previous]),
          ),
        },
      ];
      expect(
        commitStatementImport(state, [transaction(description, amount)]),
      ).toMatchObject({ added: 0, duplicates: 1, changes: [] });
      if (category === "Barber" || category === "Rufbereitschaft" || category === "Gehalt") {
        const changed = transaction(
          description,
          amount + Math.sign(amount) * 10,
        );
        const saved = commitStatementImport(state, [changed]);
        expect(saved.changes).toEqual([]);
        expect(saved.state.financeRows).toEqual(state.financeRows);
        expect(saved.state.transactions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ amount: changed.amount }),
          ]),
        );
        return;
      }
      expect(
        splitFixedBookings(state, [
          transaction(description, amount + Math.sign(amount) * 0.05),
        ]).changes,
      ).toEqual([]);
      expect(
        splitFixedBookings(state, [
          transaction(description, amount + Math.sign(amount) * 0.06),
        ]).changes,
      ).toHaveLength(1);
      const changed = transaction(
        description,
        amount + Math.sign(amount) * 10.48,
      );
      const split = splitFixedBookings(state, [
        changed,
        { ...changed, id: "second", date: "2026-09-04" },
      ]);
      expect(split.changes).toHaveLength(1);
      expect(split.rows).toEqual([]);
      const yes = commitStatementImport(
        state,
        [],
        [{ change: split.changes[0], accept: true }],
      );
      expect(yes.state.financeRows[0].values["2026-08"]).toBe(previous);
      expect(yes.state.financeRows[0].values["2026-09"]).toBeCloseTo(
        Math.abs(changed.amount),
        2,
      );
      expect(yes.state.financeRows[0].values["2027-12"]).toBeCloseTo(
        Math.abs(changed.amount),
        2,
      );
      expect(yes.state.transactions).toEqual([]);
      expect(splitFixedBookings(yes.state, [changed]).changes).toEqual([]);
      const no = commitStatementImport(
        state,
        [],
        [{ change: split.changes[0], accept: false }],
      );
      expect(no.state.financeRows).toEqual(state.financeRows);
      expect(splitFixedBookings(no.state, [changed])).toMatchObject({
        rows: [],
        changes: [],
        duplicates: 1,
      });
      expect(no.state.transactions).toEqual([]);
    },
  );
  it("uses existing bookings without a grid row and rechecks a reviewed row against fresh state", () => {
    const state = createSeed();
    state.transactions = [transaction("Porsche Bank bereits gebucht", -289.52)];
    expect(
      commitStatementImport(state, [
        transaction("Porsche Bank neuer Text", -289.52, "2026-09-05"),
      ]),
    ).toMatchObject({ added: 0, duplicates: 1 });
    expect(
      commitStatementImport(state, [
        transaction("Porsche Bank neuer Text", -300, "2026-09-05"),
      ]),
    ).toMatchObject({
      added: 0,
      changes: [expect.objectContaining({ previous: 289.52, amount: 300 })],
    });
    const candidate = {
      ...transaction("Unbekannt", -10),
      category: "Shopping" as const,
      categoryOverride: true,
    };
    state.transactions.push({ ...candidate, id: "other-tab" });
    expect(commitStatementImport(state, [candidate])).toMatchObject({
      added: 0,
      duplicates: 1,
    });
  });
  it("auto-files explicit Apple Care but asks about generic PayPal despite a matching amount", () => {
    const state = createSeed();
    const apple = transaction("PayPal AppleCare+", -14.99);
    const prepared = prepareStatementImport([resultFor([apple])], state);
    expect(prepared.review).toEqual([]);
    expect(prepared.automatic[0]).toMatchObject({
      category: "Versicherungen",
      includeInPlan: false,
    });
    const saved = commitStatementImport(state, prepared.automatic);
    expect(saved.added).toBe(1);
    expect(classify(saved.state.transactions[0]).includeInPlan).toBe(false);
    state.financeRows.push({
      id: "apple",
      kind: "fixed",
      label: "Apple Care",
      values: { "2026-09": 14.99 },
    });
    const matching = prepareStatementImport(
      [
        resultFor([
          apple,
          transaction(
            "PayPal Europe S.a.r.l. et Cie S.C.A Verwendungszweck: 105/PAYPAL",
            -14.99,
          ),
        ]),
      ],
      state,
    );
    expect(matching).toMatchObject({
      automatic: [],
      duplicates: 1,
    });
    expect(matching.review).toHaveLength(1);
    expect(matching.review[0]).toMatchObject({ kind: "booking", draft: { amount: -14.99, category: "Prüfen" } });
    const unknown = prepareStatementImport(
      [resultFor([transaction("Unbekannter Händler", -14.99)])],
      state,
    );
    expect(unknown.review).toHaveLength(1);
  });
  it("keeps manual pocket movements signed and round-trips them through Excel", async () => {
    const state = createSeed();
    state.transactions = [
      {
        ...transaction("Einzahlung Urlaub", 50, state.settings.baselineDate),
        bank: "Manuell",
        pocket: "Urlaub",
        category: "Transfer intern",
        categoryOverride: true,
        afterBaseline: true,
      },
      {
        ...transaction(
          "Entnahme Urlaub · Amazon Auszahlung bei Pocket",
          -10,
          state.settings.baselineDate,
        ),
        bank: "Manuell",
        pocket: "Urlaub",
        category: "Transfer intern",
        categoryOverride: true,
        afterBaseline: true,
      },
    ];
    const expected = {
      ...state.settings.balances,
      Urlaub: state.settings.balances.Urlaub + 40,
    };
    expect(actualPockets(state)).toEqual(expected);
    expect(calculateDashboard(state).current.actualSpending).toBe(0);
    expect(calculatePlan(state.transactions, state.settings.asOf).total).toBe(
      0,
    );
    const restored = (await parseWorkbook(await exportWorkbook(state))).state;
    expect(restored.transactions).toEqual(state.transactions);
    expect(actualPockets(restored)).toEqual(expected);
  });
  it("round-trips price decisions and explicit monthly overrides through Excel", async () => {
    const state = createSeed();
    state.months = Object.fromEntries(
      [...monthsForYear(2026), ...monthsForYear(2027)].map((month) => [
        month,
        emptyMonth(),
      ]),
    );
    state.financeRows = [
      {
        id: "lease",
        kind: "fixed",
        label: "Leasing",
        values: { "2026-09": 289.52 },
      },
    ];
    const booking = transaction("Porsche Bank", -300);
    const change = splitFixedBookings(state, [booking]).changes[0];
    const rejected = commitStatementImport(
      state,
      [],
      [{ change, accept: false }],
    ).state;
    rejected.financeRows.push({
      id: "food",
      kind: "variable",
      label: "Lebensmittel",
      planCategory: "Lebensmittel",
      values: { "2026-10": 123 },
      overrides: { "2026-10": 123, "2026-11": null },
    });
    const restored = (await parseWorkbook(await exportWorkbook(rejected)))
      .state;
    expect(restored).toEqual(applyVariableBudgets(appStateSchema.parse(rejected)));
    expect(splitFixedBookings(restored, [booking]).changes).toEqual([]);
  });
});

describe("silent planning", () => {
  function history(): AppState {
    const state = createSeed();
    state.settings.baselineDate = "2026-01-01";
    state.settings.allocationStart = "2026-01-01";
    state.settings.asOf = "2026-08-11";
    state.financeRows = [
      {
        id: "salary",
        kind: "income",
        label: "Gehalt",
        values: { "2026-09": 2000, "2026-10": 2000 },
      },
    ];
    for (const [description, category] of [
      ["BILLA", "Lebensmittel"],
      ["Mensa", "Mittagessen"],
      ["PACE Pay", "Mobilität"],
      ["G2A", "Guthabenkarten"],
      ["McDonalds", "Restaurants"],
    ] as [string, Category][]) {
      state.financeRows.push({
        id: category,
        kind: "variable",
        label: category,
        planCategory: category,
        values: {
          "2026-08": 88,
          "2026-09": 999,
          "2026-10": 999,
          "2027-12": 999,
        },
      });
      for (const month of ["05", "06", "07", "08"])
        state.transactions.push(
          { ...transaction(description, -100, `2026-${month}-${month === "05" ? "04" : month === "08" ? "03" : "02"}`), time: "12:00:00" },
        );
    }
    return state;
  }
  it("enforces seven budget lines on load and removes current/future overrides", () => {
    const state = history();
    state.financeRows.find((row) => row.id === "Mobilität")!.overrides = {
      "2026-10": 77,
      "2027-12": 0,
    };
    state.months["2026-09"] = { ...emptyMonth(), variableOverride: 999 };
    const loaded = refreshPlanning(state, "2026-09-11");
    expect(loaded.settings.asOf).toBe("2026-09-11");
    expect(
      loaded.financeRows
        .filter((row) => row.kind === "variable")
        .map((row) => row.values["2026-09"]),
    ).toEqual([250, 117, 180, 20, 250, 0, 100]);
    expect(
      loaded.financeRows.find((row) => row.id === "Mobilität")?.values,
    ).toMatchObject({ "2026-08": 88, "2026-10": 180, "2027-12": 180 });
    expect(calculateDashboard(loaded).current.variablePlan).toBe(917);
    expect(refreshPlanning(loaded, "2026-09-11")).toEqual(loaded);
  });
  it("advances the budget calendar on the first without re-averaging spending", () => {
    const state = history();
    const september = refreshPlanning(state, "2026-09-30");
    const october = refreshPlanning(september, "2026-10-01");
    const dashboard = calculateDashboard(october);
    expect(dashboard.plan.currentMonth).toBe("2026-10");
    expect(
      october.financeRows.find((row) => row.id === "Lebensmittel")?.values[
        "2026-10"
      ],
    ).toBe(250);
    const current = dashboard.timeline.find((row) => row.month === "2026-10")!;
    expect(current.variablePlan).toBe(911.5);
    expect(
      Object.values(current.rates).reduce((sum, value) => sum + value, 0),
    ).toBe(1088.5);
    expect(current.rates.Motorrad).toBeGreaterThan(0);
    const imported = commitStatementImport(october, [
      transaction("BILLA", -100, "2026-09-05"),
    ]).state;
    const refreshed = refreshPlanning(imported, "2026-10-01");
    expect(
      refreshed.financeRows.find((row) => row.id === "Lebensmittel")?.values[
        "2026-11"
      ],
    ).toBe(250);
    expect(
      calculatePlan(refreshed.transactions, refreshed.settings.asOf).months,
    ).toHaveLength(4);
  });
});
