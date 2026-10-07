import { describe, expect, it } from "vitest";
import { actualBookings, classify } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { statementFingerprint } from "@/lib/import/identity";
import {
  merchantRuleKey,
  rememberMerchants,
} from "@/lib/import/merchant-rules";
import {
  bookingReviewReason,
  openReviewCount,
  queueLedgerReview,
} from "@/lib/import/review";
import { createSeed } from "@/lib/seed";
import {
  personalAmount,
  reconcileSharedHoliday,
  type AccountedTransaction,
} from "@/lib/shared-holiday";
import {
  appStateSchema,
  categorySchema,
  type AppState,
  type Transaction,
} from "@/lib/types";
import {
  assignTransactions,
  exportTransactionsCsv,
  matchesTransactionSearch,
  normalizeSearch,
  type TransactionAssignment,
} from "@/lib/transaction-tools";

const booking = (
  overrides: Partial<AccountedTransaction> = {},
): AccountedTransaction => ({
  id: "first",
  date: "2026-09-01",
  bank: "Revolut",
  pocket: "Hauptkonto",
  description: "Nordlicht Laden",
  category: "Prüfen",
  amount: -31.01,
  includeInPlan: false,
  ...overrides,
});

const fixture = (overrides: Partial<AppState> = {}): AppState => ({
  ...createSeed(),
  transactions: [],
  fixedReceipts: [],
  merchantRules: [],
  reviewQueue: [],
  financeRows: [],
  holidayRanges: [],
  ...overrides,
});

function csvRecords(csv: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 1; index < csv.length; index++) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && character === ";") {
      record.push(cell);
      cell = "";
    } else if (!quoted && character === "\r" && csv[index + 1] === "\n") {
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
      index++;
    } else cell += character;
  }
  return records;
}

function previousSingleSave(
  state: AppState,
  transaction: Transaction,
  choice: TransactionAssignment,
): AppState {
  const preview = classify({
    ...transaction,
    ...choice,
    manualCategory: true,
    includeInPlan: true,
  });
  const canMarkFixed =
    transaction.amount < 0 &&
    !preview.isTransfer &&
    !isIncomeCategory(preview.category);
  const assignment = {
    category: choice.category,
    categoryOverride: true,
    manualCategory: true,
    reviewed: choice.category !== "Prüfen",
    includeInPlan: true,
    ...(choice.merchantAlias !== undefined
      ? { merchantAlias: choice.merchantAlias }
      : {}),
    ...(choice.fixedCost !== undefined
      ? { fixedCost: canMarkFixed && choice.fixedCost }
      : {}),
  };
  return rememberMerchants(
    {
      ...state,
      transactions: state.transactions.map((row) =>
        row.id === transaction.id
          ? {
              ...row,
              ...assignment,
              includeInPlan: classify({ ...row, ...assignment }).includeInPlan,
            }
          : row,
      ),
      ...(state.fixedReceipts
        ? {
            fixedReceipts: state.fixedReceipts.map((receipt) =>
              receipt.key === transaction.id ||
              receipt.key === statementFingerprint(transaction)
                ? {
                    ...receipt,
                    category: choice.category,
                    booking: {
                      ...(receipt.booking ?? transaction),
                      ...assignment,
                      includeInPlan: classify({
                        ...(receipt.booking ?? transaction),
                        ...assignment,
                      }).includeInPlan,
                    },
                  }
                : receipt,
            ),
          }
        : {}),
    },
    [{ ...transaction, ...assignment }],
  );
}

describe("transaction search", () => {
  it("normalizes case, composed and decomposed accents, surrounding/repeated whitespace", () => {
    expect(normalizeSearch(" \tMÜLLER   Café\u0301\n")).toBe("muller cafe");
    expect(normalizeSearch("Prüfen Österreich")).toBe("prufen osterreich");
  });

  it("matches all words independently across bank text, alias, raw text, account and classified merchant", () => {
    const row = booking({
      description: "MÜLLER Café",
      merchantAlias: "Étoile",
      rawDescription: "ORIGINAL Überweisung",
      rawDetails: ["Referenz 123"],
      bank: "Raiffeisen",
      pocket: "Raiffeisen Giro",
    });
    expect(
      matchesTransactionSearch(
        row,
        "  cafe\tetoile original uberweisung girokonto referenz ",
      ),
    ).toBe(true);
    expect(matchesTransactionSearch(row, "raiffeisen cafe")).toBe(true);
    expect(matchesTransactionSearch(row, "etoile unbekannt")).toBe(false);
    expect(matchesTransactionSearch(row, "  \n ")).toBe(true);
    expect(matchesTransactionSearch(row, "gebundelt cafe", "Gebündelt")).toBe(
      true,
    );
    expect(
      matchesTransactionSearch(booking({ description: "BIPA" }), "bipa"),
    ).toBe(true);
    expect(
      matchesTransactionSearch(
        booking({ description: "POS 2,00 AT D1 12.09." }),
        "handler unbekannt",
      ),
    ).toBe(true);
  });
});

describe("transaction CSV export", () => {
  it("writes BOM, quoted semicolon CSV and preserves supplied result order without pagination", () => {
    const rows = Array.from({ length: 65 }, (_, index) =>
      booking({
        id: `row-${index}`,
        category: "Shopping",
        manualCategory: true,
        includeInPlan: true,
        merchantAlias: 'Laden; "Étoile"\nFiliale',
        rawDescription: 'Bank; "Original"\r\nText',
      }),
    ).reverse();
    const snapshot = structuredClone(rows);
    const csv = exportTransactionsCsv(rows);
    const [header, ...records] = csvRecords(csv);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(header).toEqual([
      "ID",
      "Datum",
      "Händler",
      "Original-Banktext",
      "Kategorie",
      "Bank",
      "Pocket / Konto",
      "Originalbetrag",
      "Eigenanteil",
      "Geteilt / Erstattung",
      "Planrelevant",
    ]);
    expect(records).toHaveLength(65);
    expect(records.map((record) => record[0])).toEqual(
      rows.map((row) => row.id),
    );
    expect(records[0]).toEqual([
      "row-64",
      "2026-09-01",
      'Laden; "Étoile"\nFiliale',
      'Bank; "Original"\r\nText',
      "Shopping",
      "Revolut",
      "Revolut · Hauptkonto",
      "-31,01",
      "-31,01",
      "",
      "Ja",
    ]);
    expect(rows).toEqual(snapshot);
  });

  it("preserves signed original/own amounts, odd-cent sharing, ordinary credits and reimbursement transfers", () => {
    const shared = booking({
      amount: -31.01,
      sharedWithRaphael: true,
      category: "Shopping",
    });
    const repayment = booking({
      id: "repayment",
      date: "2026-09-02",
      amount: 15.5,
      description: "Raphael Rückzahlung",
      category: "Einkommen",
    });
    const credit = booking({
      id: "credit",
      amount: 8.75,
      description: "Gutschrift",
      category: "Rückerstattungen",
    });
    const salary = booking({
      id: "salary",
      amount: 2500,
      category: "Einkommen",
      description: "Einnahme",
    });
    const rows = reconcileSharedHoliday([
      shared,
      repayment,
      credit,
      salary,
    ]).bookings;
    const records = csvRecords(exportTransactionsCsv(rows)).slice(1);
    expect(records[0].slice(7, 10)).toEqual([
      "-31,01",
      "-15,51",
      "Geteilt · 50 % Eigenanteil",
    ]);
    expect(records[1][4]).toBe("Transfer");
    expect(records[1].slice(7, 9)).toEqual(["15,50", "0,00"]);
    expect(records[1][9]).toContain("kein Einkommen");
    expect(records[1][10]).toBe("Nein");
    expect(records[2].slice(7, 9)).toEqual(["8,75", "8,75"]);
    expect(records[3].slice(7, 9)).toEqual(["2500,00", "2500,00"]);
    expect(records[3][10]).toBe("Nein");
    expect(rows.map(personalAmount)).toEqual([-15.51, 0, 8.75, 2500]);
  });

  it.each([
    "=1+1",
    "+SUM(1;2)",
    "-1+1",
    "@SUM(1)",
    " \t=1+1",
    "\r\n+SUM(1;2)",
    "\u0000-1+1",
    "\u200B@SUM(1)",
    "\uFEFF=1+1",
    "＝1+1",
  ])("neutralizes formula text including invisible prefixes: %j", (text) => {
    const row = booking({
      id: text,
      merchantAlias: text,
      rawDescription: text,
      bank: text,
      pocket: null,
      amount: -3.5,
    });
    const cells = csvRecords(exportTransactionsCsv([row]))[1];
    for (const index of [0, 2, 3, 5, 6])
      expect(cells[index].startsWith("'")).toBe(true);
    expect(cells[3]).toBe(`'${text}`);
    expect(cells[7]).toBe("-3,50");
    expect(cells[8]).toBe("-3,50");
  });

  it("includes the header for an empty export and reports manual shared payment without guessing repayment state", () => {
    expect(csvRecords(exportTransactionsCsv([]))).toHaveLength(1);
    const cells = csvRecords(
      exportTransactionsCsv([
        booking({ sharedWithRaphael: true, sharedPaidManually: true }),
      ]),
    )[1];
    expect(cells[9]).toBe("Geteilt · 50 % Eigenanteil · manuell bezahlt");
  });
});

describe("transaction assignments", () => {
  it.each([
    { category: "Shopping" as const },
    { category: "Shopping" as const, fixedCost: true },
    {
      category: "Shopping" as const,
      fixedCost: false,
      merchantAlias: "Étoile Laden",
    },
    { category: "Einkommen" as const, fixedCost: true },
    { category: "Transfer" as const, fixedCost: true },
    { category: "Prüfen" as const },
  ])(
    "matches the existing single save for ordinary, mirrored and receipt-only bookings: %j",
    (choice) => {
      const original = booking({
        rawDescription: "Original Banktext",
        rawDetails: ["Details"],
        fixedCost: true,
        sharedWithRaphael: true,
        bankReference: "synthetic-reference",
      });
      const receipt = {
        key: statementFingerprint(original),
        category: original.category,
        date: original.date,
        amount: original.amount,
        rowId: "fixed-plan",
        booking: original,
      };
      for (const state of [
        fixture({ transactions: [original] }),
        fixture({ transactions: [original], fixedReceipts: [receipt] }),
        fixture({ fixedReceipts: [receipt] }),
        fixture({ fixedReceipts: [{ ...receipt, booking: undefined }] }),
      ]) {
        const displayed = actualBookings(state)[0];
        const before = structuredClone(state);
        expect(assignTransactions(state, [displayed.id], choice)).toEqual(
          previousSingleSave(state, displayed, choice),
        );
        expect(state).toEqual(before);
      }
    },
  );

  it("assigns mixed ledger and receipt-only targets without duplicating money or altering bank facts/plans", () => {
    const ledger = booking({ fixedCost: false, sharedWithRaphael: true });
    const source = booking({
      id: "receipt-original",
      date: "2026-09-02",
      amount: -17.75,
      category: "Telefon & Internet",
      fixedCost: true,
      rawDescription: "Source bank text",
      time: "12:34:56",
    });
    const key = statementFingerprint(source);
    const state = fixture({
      transactions: [ledger],
      fixedReceipts: [
        {
          key,
          booking: source,
          date: source.date,
          amount: source.amount,
          category: source.category,
          rowId: "plan",
        },
      ],
    });
    const result = assignTransactions(state, [ledger.id, key], {
      category: "Bildung",
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      ...ledger,
      category: "Bildung",
      manualCategory: true,
      categoryOverride: true,
      reviewed: true,
      includeInPlan: true,
    });
    expect(result.fixedReceipts?.[0]).toMatchObject({
      key,
      date: source.date,
      amount: source.amount,
      category: "Bildung",
      rowId: "plan",
      booking: {
        ...source,
        category: "Bildung",
        manualCategory: true,
        reviewed: true,
        fixedCost: true,
        includeInPlan: false,
      },
    });
    expect(actualBookings(result)).toHaveLength(2);
    expect(actualBookings(result).map((row) => row.amount)).toEqual([
      -31.01, -17.75,
    ]);
    expect(result.financeRows).toBe(state.financeRows);
    expect(result.months).toBe(state.months);
    expect(result.settings).toBe(state.settings);
    expect(appStateSchema.safeParse(result).success).toBe(true);
  });

  it("accepts the original receipt booking ID and links receipts whose key differs from the fingerprint", () => {
    const original = booking();
    const receipt = {
      key: "receipt-key",
      booking: original,
      date: original.date,
      amount: original.amount,
      category: original.category,
    };
    const receiptOnly = fixture({ fixedReceipts: [receipt] });
    const corrected = assignTransactions(receiptOnly, [original.id], {
      category: "Shopping",
      fixedCost: false,
    });
    expect(actualBookings(corrected)[0]).toMatchObject({
      id: receipt.key,
      category: "Shopping",
      includeInPlan: true,
    });
    const mirrored = fixture({
      transactions: [original],
      fixedReceipts: [receipt],
    });
    expect(
      assignTransactions(mirrored, [original.id], { category: "Shopping" })
        .fixedReceipts?.[0].booking,
    ).toMatchObject({ category: "Shopping", manualCategory: true });
  });

  it("materializes a bare financial receipt while keeping its original amount, date and synthetic identity", () => {
    const state = fixture({
      fixedReceipts: [
        {
          key: "bare",
          date: "2026-09-02",
          amount: -14,
          category: "Telefon & Internet",
          rowId: "contract",
        },
      ],
    });
    const result = assignTransactions(state, ["bare"], {
      category: "Shopping",
      fixedCost: false,
    });
    expect(result.transactions).toEqual([]);
    expect(result.fixedReceipts?.[0]).toMatchObject({
      key: "bare",
      amount: -14,
      date: "2026-09-02",
      rowId: "contract",
      booking: {
        id: "bare",
        bank: "Auszugsbeleg",
        pocket: null,
        description: "Telefon & Internet",
        amount: -14,
        date: "2026-09-02",
        category: "Shopping",
        fixedCost: false,
        categoryOverride: true,
        manualCategory: true,
        reviewed: true,
        includeInPlan: true,
      },
    });
    expect(actualBookings(result)).toHaveLength(1);
    expect(classify(actualBookings(result)[0]).includeInPlan).toBe(true);
  });

  it("rejects vanished IDs atomically rather than silently assigning the remaining selection", () => {
    const state = fixture({ transactions: [booking()] });
    const before = structuredClone(state);
    expect(() =>
      assignTransactions(state, ["first", "vanished"], {
        category: "Shopping",
      }),
    ).toThrow("Buchung nicht mehr vorhanden: vanished");
    expect(state).toEqual(before);
    expect(assignTransactions(state, [], { category: "Shopping" })).toBe(state);
  });

  it("validates the assignment schema strictly and canonicalizes known legacy categories", () => {
    const state = fixture({ transactions: [booking()] });
    for (const invalid of [
      { category: "Invented" },
      { category: "Shopping", fixedCost: "true" },
      { category: "Shopping", merchantAlias: " \t " },
      { category: "Shopping", merchantAlias: "x".repeat(201) },
      { category: "Shopping", amount: -1 },
    ])
      expect(() =>
        assignTransactions(state, ["first"], invalid as TransactionAssignment),
      ).toThrow();
    expect(
      assignTransactions(state, ["first"], { category: "Spotify" })
        .transactions[0].category,
    ).toBe(categorySchema.parse("Spotify"));
  });

  it("permits a validated single alias but never assigns one name to multiple bookings", () => {
    const first = booking();
    const second = booking({ id: "second", description: "Südlicht Laden" });
    const state = fixture({ transactions: [first, second] });
    expect(() =>
      assignTransactions(state, [first.id, second.id], {
        category: "Shopping",
        merchantAlias: "Étoile",
      }),
    ).toThrow("Ein Händlername");
    const result = assignTransactions(state, [first.id, first.id], {
      category: "Shopping",
      merchantAlias: "  Étoile  ",
    });
    expect(result.transactions[0].merchantAlias).toBe("Étoile");
    expect(result.transactions[0].description).toBe(first.description);
    expect(result.transactions[1]).toBe(second);
  });

  it.each([true, false, undefined])(
    "preserves omitted per-booking fixedCost flags, including ineligible rows: %s",
    (fixedCost) => {
      const rows = [
        booking({ fixedCost }),
        booking({ id: "credit", amount: 5, fixedCost }),
        booking({ id: "named-transfer", description: "Transfer", fixedCost }),
      ];
      const result = assignTransactions(
        fixture({ transactions: rows }),
        rows.map((row) => row.id),
        { category: "Shopping" },
      );
      expect(result.transactions.map((row) => row.fixedCost)).toEqual([
        fixedCost,
        fixedCost,
        fixedCost,
      ]);
      expect(classify(result.transactions[1]).isFixedCost).toBe(false);
      expect(classify(result.transactions[2])).toMatchObject({
        isTransfer: true,
        isFixedCost: false,
        includeInPlan: false,
      });
    },
  );

  it("allows explicit fixed costs only for negative nontransfer, nonincome assignments", () => {
    const expense = booking();
    const positive = booking({ id: "credit", amount: 5 });
    const state = fixture({ transactions: [expense, positive] });
    const shopping = assignTransactions(state, ["first", "credit"], {
      category: "Shopping",
      fixedCost: true,
    });
    expect(shopping.transactions.map((row) => row.fixedCost)).toEqual([
      true,
      false,
    ]);
    expect(
      shopping.transactions.map((row) => classify(row).includeInPlan),
    ).toEqual([false, true]);
    for (const category of [
      "Transfer",
      "Transfer intern",
      "Einkommen",
      "Gehalt",
    ] as const) {
      const result = assignTransactions(state, ["first"], {
        category,
        fixedCost: true,
      });
      expect(result.transactions[0].fixedCost).toBe(false);
      expect(result.transactions[0].includeInPlan).toBe(false);
    }
    const transfer = booking({
      description: "Transfer Nordlicht",
      fixedCost: true,
      sharedWithRaphael: true,
    });
    const guarded = assignTransactions(
      fixture({ transactions: [transfer] }),
      [transfer.id],
      { category: "Shopping", fixedCost: true },
    );
    expect(guarded.transactions[0]).toMatchObject({
      fixedCost: false,
      includeInPlan: false,
      sharedWithRaphael: true,
    });
    expect(classify(guarded.transactions[0])).toMatchObject({
      category: "Transfer",
      isTransfer: true,
      isFixedCost: false,
    });
  });

  it("remembers all selected merchants together so conflicting aliases do not overwrite the source rule", () => {
    const first = booking({ merchantAlias: "Nordlicht Geschäft" });
    const second = booking({
      id: "second",
      date: "2026-09-02",
      merchantAlias: "Südlicht Geschäft",
    });
    const sourceKey = merchantRuleKey({ ...first, merchantAlias: undefined });
    const state = fixture({
      transactions: [first, second],
      merchantRules: [{ key: sourceKey, category: "Bildung" }],
    });
    const result = assignTransactions(state, ["first", "second"], {
      category: "Shopping",
    });
    expect(
      result.merchantRules?.find((rule) => rule.key === sourceKey)?.category,
    ).toBe("Bildung");
    expect(
      result.merchantRules?.find((rule) => rule.key === merchantRuleKey(first))
        ?.category,
    ).toBe("Shopping");
    expect(
      result.merchantRules?.find((rule) => rule.key === merchantRuleKey(second))
        ?.category,
    ).toBe("Shopping");
  });

  it("retains existing merchant propagation without inheriting explicit acknowledgements or fixed-cost choices", () => {
    const first = booking({ fixedCost: true });
    const second = booking({
      id: "second",
      date: "2026-09-02",
      fixedCost: false,
    });
    const other = booking({
      id: "other",
      description: "Unrelated",
      fixedCost: undefined,
    });
    const state = fixture({ transactions: [first, second, other] });
    const result = assignTransactions(state, ["first"], {
      category: "Shopping",
    });
    expect(result.transactions[0]).toMatchObject({
      category: "Shopping",
      reviewed: true,
      fixedCost: true,
    });
    expect(result.transactions[1]).toMatchObject({
      category: "Shopping",
      categoryOverride: true,
      fixedCost: false,
    });
    expect(result.transactions[1].manualCategory).toBeUndefined();
    expect(result.transactions[1].reviewed).toBeUndefined();
    expect(result.transactions[2]).toBe(other);
  });

  it("clears acknowledged ledger and receipt reviews through the provider's existing queue derivation, without plan changes", () => {
    const first = booking({ description: "POS 2,00 AT D1 12.09." });
    const second = booking({
      id: "second",
      amount: -18,
      date: "2026-09-02",
      description: "Other unknown",
    });
    const key = statementFingerprint(second);
    const fixedChange = {
      id: "fixed",
      category: "Leasing" as const,
      month: "2026-09",
      previous: 15,
      amount: 18,
      bookings: [second],
    };
    const state = fixture({
      transactions: [first],
      fixedReceipts: [
        {
          key,
          booking: second,
          date: second.date,
          amount: second.amount,
          category: second.category,
        },
      ],
      reviewQueue: [
        {
          kind: "booking",
          id: first.id,
          draft: first,
          message: "Händler unbekannt",
        },
        { kind: "fixed", id: "fixed", change: fixedChange },
      ],
    });
    const assigned = assignTransactions(state, [first.id, key], {
      category: "Shopping",
    });
    expect(assigned.reviewQueue).toBe(state.reviewQueue);
    const derived = queueLedgerReview(assigned);
    expect(openReviewCount(derived.reviewQueue ?? [])).toBe(0);
    expect(
      actualBookings(derived).every(
        (row) => !bookingReviewReason(derived, row),
      ),
    ).toBe(true);
    expect(derived.financeRows).toBe(state.financeRows);
    const reopened = queueLedgerReview(
      assignTransactions(derived, [first.id], { category: "Prüfen" }),
    );
    expect(reopened.transactions[0].reviewed).toBe(false);
    expect(openReviewCount(reopened.reviewQueue ?? [])).toBe(1);
  });
});
