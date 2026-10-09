import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema, type Transaction } from "@/lib/types";
import { MerchantIndex, seedMerchants } from "./merchants";
import { enrichTransaction } from "./pipeline";
import {
  aggregateRecognitionBenchmarks,
  benchmarkRate,
  evaluateRecognitionBenchmark,
  recognitionBenchmarkSource,
} from "./recognition-benchmark";

const index = new MerchantIndex(seedMerchants);
const row = (
  id: string,
  description: string,
  extra: Partial<Transaction> = {},
) =>
  transactionSchema.parse({
    id,
    description,
    bank: "Amex",
    pocket: "Amex",
    date: "2026-09-01",
    amount: -12,
    category: "Prüfen",
    includeInPlan: true,
    ...extra,
  });
const manual = (
  id: string,
  description: string,
  date = "2026-09-01",
  extra: Partial<Transaction> = {},
) =>
  row(id, description, {
    date,
    merchantAlias: "BILLA",
    category: "Lebensmittel",
    manualCategory: true,
    reviewed: true,
    categoryOverride: true,
    ...extra,
  });
const state = (transactions: Transaction[]) => ({
  ...blankTestState(),
  transactions,
});

describe("source-only recognition evaluation", () => {
  it("removes every assignment, planning and lock field but retains actual source evidence", () => {
    const original = manual("secret-uuid", "BILLA", "2026-09-02", {
      rawDescription: "POS Unbekannter Laden 4711",
      rawDetails: ["original bank evidence"],
      time: "12:45:00",
      merchantId: "at-billa",
      merchantMatch: "rule",
      merchantLogo: true,
      is_locked: true,
      requires_manual_review: false,
      fixedCost: true,
      includeInPlan: false,
      afterBaseline: true,
      sharedWithRaphael: true,
      sharedPaidManually: true,
      bankReference: "original-ref",
      sourceCategory: "Kartenzahlung",
    });
    const source = recognitionBenchmarkSource(original);
    expect(source).toMatchObject({
      description: original.rawDescription,
      rawDescription: original.rawDescription,
      rawDetails: original.rawDetails,
      time: original.time,
      amount: original.amount,
      bank: original.bank,
      bankReference: original.bankReference,
      sourceCategory: original.sourceCategory,
      category: "Prüfen",
      includeInPlan: true,
    });
    for (const field of [
      "merchantId",
      "merchantAlias",
      "merchantLogo",
      "merchantMatch",
      "is_locked",
      "manualCategory",
      "reviewed",
      "categoryOverride",
      "requires_manual_review",
      "fixedCost",
      "afterBaseline",
      "sharedWithRaphael",
      "sharedPaidManually",
    ])
      expect(source).not.toHaveProperty(field);
    expect(original.description).toBe("BILLA");
    expect(original.rawDetails).not.toBe(source.rawDetails);
  });

  it("never treats automatic outcomes, lock alone or legacy override alone as ground truth", () => {
    const result = evaluateRecognitionBenchmark(
      state([
        row("auto", "BILLA", {
          category: "Lebensmittel",
          merchantAlias: "BILLA",
          merchantId: "at-billa",
          merchantMatch: "alias",
          requires_manual_review: false,
          categoryOverride: true,
        }),
        row("override", "BILLA", {
          category: "Lebensmittel",
          categoryOverride: true,
        }),
        row("locked", "BILLA", { category: "Lebensmittel", is_locked: true }),
        row("category-review", "BILLA", {
          category: "Lebensmittel",
          categoryOverride: true,
          reviewed: true,
          merchantAlias: "BILLA",
          merchantId: "at-billa",
          merchantMatch: "alias",
        }),
      ]),
      index,
    );
    expect(result.inventory).toMatchObject({
      eligible: 4,
      merchantLabels: 0,
      categoryLabels: 1,
      jointLabels: 0,
      unconfirmedAutomaticIdentities: 2,
    });
    expect(result.temporal.merchantPrecision.rate).toBeNull();
    expect(result.temporal.jointPrecision.rate).toBeNull();
    expect(result.temporal.categoryPrecision.rate).toBe(1);
    expect(result.temporal.target99).toBe("insufficient-evidence");
  });

  it("accepts explicit legacy manual alias identity independently of category truth", () => {
    const result = evaluateRecognitionBenchmark(
      state([
        row("identity-only", "BILLA", {
          merchantAlias: "BILLA",
          categoryOverride: true,
        }),
        manual("manual", "BILLA"),
        row("reviewed", "BILLA", {
          category: "Lebensmittel",
          reviewed: true,
          categoryOverride: true,
        }),
      ]),
      index,
    );
    expect(result.inventory).toMatchObject({
      merchantLabels: 2,
      categoryLabels: 2,
      jointLabels: 1,
      unlabeled: 0,
    });
  });

  it("deduplicates ledger and receipt IDs and merges only nonconflicting human labels", () => {
    const original = row("same", "BILLA");
    const input = {
      ...state([original]),
      fixedReceipts: [
        {
          key: "receipt",
          date: original.date,
          amount: original.amount,
          category: "Shopping" as const,
          booking: manual("same", "BILLA"),
        },
      ],
    };
    const result = evaluateRecognitionBenchmark(input, index);
    expect(result.inventory).toMatchObject({
      copies: 2,
      logicalTransactions: 1,
      duplicateCopies: 1,
      eligible: 1,
      jointLabels: 1,
      conflictingLabels: 0,
    });
    expect(result.temporal.jointPrecision.samples).toBe(1);
  });

  it("excludes and reports conflicting human labels and conflicting source facts", () => {
    const input = {
      ...state([
        manual("category-conflict", "BILLA"),
        manual("source-conflict", "BILLA"),
      ]),
      fixedReceipts: [
        {
          key: "a",
          date: "2026-09-01",
          amount: -12,
          category: "Shopping" as const,
          booking: manual("category-conflict", "BILLA", "2026-09-01", {
            category: "Shopping",
          }),
        },
        {
          key: "b",
          date: "2026-09-01",
          amount: -12,
          category: "Lebensmittel" as const,
          booking: manual("source-conflict", "BILLA andere Quelle"),
        },
      ],
    };
    const result = evaluateRecognitionBenchmark(input, index);
    expect(result.inventory).toMatchObject({
      logicalTransactions: 2,
      conflictingLabels: 1,
      conflictingSources: 1,
      eligible: 0,
    });
    expect(result.temporal.jointPrecision.rate).toBeNull();
  });

  it("holds entire future dates out, learns only earlier confirmed choices and ignores stored rules", () => {
    const input = {
      ...state([
        manual("earlier", "POS Sonderladen", "2026-09-01"),
        manual("future", "POS Sonderladen", "2026-09-02"),
        manual("future-poison", "POS Nachtladen", "2026-09-02"),
      ]),
      merchantRules: [
        {
          key: "amex|nachtladen",
          category: "Lebensmittel" as const,
          merchantAlias: "BILLA",
        },
      ],
    };
    const result = evaluateRecognitionBenchmark(input, index);
    expect(result.split).toMatchObject({
      training: 1,
      holdout: 2,
      learnedRules: 1,
      temporalAvailable: true,
    });
    expect(result.temporal).toMatchObject({
      eligible: 2,
      automatic: 1,
      abstained: 1,
      labels: { joint: 2 },
    });
    expect(result.temporal.jointPrecision.rate).toBe(1);
    expect(result.temporal.jointCorrectness.rate).toBe(0.5);
    expect(result.temporalUnseenDescriptors).toMatchObject({
      eligible: 1,
      automatic: 0,
    });
    expect(result.descriptorGroupHoldout).toMatchObject({
      eligible: 1,
      automatic: 0,
    });
  });

  it("group holdout removes all occurrences of its descriptor, even when chronological training had one", () => {
    const result = evaluateRecognitionBenchmark(
      state([
        manual("a", "POS Ersterladen", "2026-09-01"),
        manual("b", "POS Sonderladen", "2026-09-02"),
        manual("c", "POS Sonderladen", "2026-09-03"),
      ]),
      index,
    );
    expect(result.temporal).toMatchObject({ eligible: 1, automatic: 1 });
    expect(result.temporalUnseenDescriptors.eligible).toBe(0);
    expect(result.descriptorGroupHoldout).toMatchObject({
      eligible: 2,
      automatic: 0,
    });
  });

  it("conflicting earlier training choices abstain rather than selecting the last label", () => {
    const result = evaluateRecognitionBenchmark(
      state([
        manual("a", "BILLA", "2026-09-01"),
        manual("b", "BILLA", "2026-09-02", { category: "Shopping" }),
        manual("c", "BILLA", "2026-09-03"),
      ]),
      index,
    );
    expect(result.split.conflictingTrainingRules).toBe(1);
    expect(result.temporal.automatic).toBe(0);
    expect(result.temporal.reviewRequested).toBe(1);
  });

  it("does not teach an outgoing spending rule from an earlier refund", () => {
    const result = evaluateRecognitionBenchmark(
      state([
        manual("refund", "POS Sonderladen refund", "2026-09-01", {
          amount: 12,
          category: "Rückerstattungen",
        }),
        manual("purchase", "POS Sonderladen refund", "2026-09-02"),
      ]),
      index,
    );
    expect(result.split.learnedRules).toBe(0);
    expect(result.temporal.automatic).toBe(0);
  });

  it("excludes transfers/income/unsupported credits but scores human-confirmed refunds", () => {
    const result = evaluateRecognitionBenchmark(
      state([
        manual("transfer", "SEPA Überweisung an BILLA", "2026-09-01", {
          category: "Transfer",
        }),
        row("salary", "Gehalt", {
          amount: 2000,
          category: "Gehalt",
          manualCategory: true,
        }),
        row("credit", "Unknown positive credit", { amount: 12 }),
        manual("refund", "BILLA refund", "2026-09-01", {
          amount: 12,
          category: "Rückerstattungen",
        }),
      ]),
      index,
    );
    expect(result.inventory).toMatchObject({
      excludedTransfers: 1,
      excludedIncomeOrCredits: 2,
      eligible: 1,
      jointLabels: 1,
    });

    expect(result.temporal.jointCorrectness.rate).toBe(1);
  });

  it("does not exclude a human-confirmed refund just because the source resembles an income credit", () => {
    const result = evaluateRecognitionBenchmark(
      state([
        manual("confirmed-refund", "Gutschrift Sonderladen", "2026-09-01", {
          amount: 12,
          category: "Rückerstattungen",
        }),
      ]),
      index,
    );
    expect(result.inventory).toMatchObject({
      eligible: 1,
      jointLabels: 1,
      excludedIncomeOrCredits: 0,
    });
    expect(result.temporal.jointCorrectness.rate).toBe(0);
  });

  it("unknown/fuzzy/ambiguous descriptions abstain, even when historical fields carried answers", () => {
    const result = evaluateRecognitionBenchmark(
      state([
        manual("fuzzy", "Muelller", "2026-09-01", {
          merchantAlias: "Müller",
          category: "Drogerie",
        }),
        manual("ambiguous", "BILLA PENNY"),
        manual("unknown", "POS Unbekannterladen"),
      ]),
      index,
    );
    expect(result.temporal).toMatchObject({
      automatic: 0,
      abstained: 3,
      reviewRequested: 3,
    });
    expect(result.temporal.jointPrecision.rate).toBeNull();
    expect(result.temporal.jointCorrectness.rate).toBe(0);
  });

  it("separates merchant, category and joint mistakes; precision does not hide poor coverage", () => {
    const enrich: typeof enrichTransaction = (source) => ({
      ...source,
      merchantAlias: source.id === "merchant-wrong" ? "PENNY" : "BILLA",
      category: source.id === "category-wrong" ? "Shopping" : "Lebensmittel",
      requires_manual_review: source.id === "review",
    });
    const result = evaluateRecognitionBenchmark(
      state([
        manual("correct", "BILLA"),
        manual("merchant-wrong", "BILLA"),
        manual("category-wrong", "BILLA"),
        manual("review", "BILLA"),
      ]),
      index,
      { enrich },
    );
    expect(result.temporal.merchantPrecision.rate).toBeCloseTo(2 / 3);
    expect(result.temporal.categoryPrecision.rate).toBeCloseTo(2 / 3);
    expect(result.temporal.jointPrecision.rate).toBeCloseTo(1 / 3);
    expect(result.temporal.jointCorrectness.rate).toBe(0.25);
    expect(result.temporal.automaticCoverage.rate).toBe(0.75);
    expect(result.temporal.descriptorGroupCorrectness).toMatchObject({
      successes: 0,
      samples: 1,
    });
  });

  it("tiny perfect samples and hundreds of same-descriptor variants cannot establish 99%", () => {
    const result = evaluateRecognitionBenchmark(
      state(
        Array.from({ length: 500 }, (_, i) =>
          manual(`variant-${i}`, `BILLA Filiale ${i + 1}`),
        ),
      ),
      index,
    );
    expect(result.temporal.jointPrecision.rate).toBe(1);
    expect(result.temporal.jointPrecision.lower95).toBeGreaterThan(0.99);
    expect(result.temporal.sourceDescriptorGroups).toBe(1);
    expect(result.temporal.descriptorGroupCorrectness.lower95).toBeLessThan(
      0.3,
    );
    expect(result.temporal.target99).toBe("insufficient-evidence");
    expect(result.split.temporalAvailable).toBe(false);
    expect(benchmarkRate(1, 1).lower95).toBeCloseTo(0.206549);
    expect(benchmarkRate(381, 381).lower95).toBeGreaterThan(0.99);
  });

  it("pools counts, not percentages, and contains no private source data", () => {
    const first = evaluateRecognitionBenchmark(
      state([manual("private-uuid", "BILLA")]),
      index,
    );
    const second = evaluateRecognitionBenchmark(
      state([
        manual("other", "BILLA"),
        manual("other2", "Unbekannterladen"),
        manual("other3", "Unbekannterladen"),
      ]),
      index,
    );
    const aggregate = aggregateRecognitionBenchmarks([first, second]);
    expect(aggregate.temporal.automaticCoverage.rate).toBe(0.5);
    expect(aggregate.temporal.jointPrecision.rate).toBe(1);
    expect(aggregate.temporal.jointCorrectness.rate).toBe(0.5);
    const output = JSON.stringify(aggregate);
    for (const secret of [
      "private-uuid",
      "BILLA",
      "Unbekannterladen",
      "Amex",
      "2026-09",
      "rawDescription",
    ])
      expect(output).not.toContain(secret);
    expect(
      aggregateRecognitionBenchmarks([]).temporal.jointPrecision.rate,
    ).toBeNull();
  });

  it("does not pool repeated account-local descriptors into independent target evidence", () => {
    const account = evaluateRecognitionBenchmark(
      state([
        manual("earlier", "BILLA", "2026-09-01"),
        manual("later", "BILLA", "2026-09-02"),
      ]),
      index,
    );
    const aggregate = aggregateRecognitionBenchmarks(
      Array.from({ length: 381 }, () => account),
    );
    expect(aggregate.temporal.descriptorGroupCorrectness).toMatchObject({
      successes: 381,
      samples: 381,
    });
    expect(
      aggregate.temporal.descriptorGroupCorrectness.lower95,
    ).toBeGreaterThan(0.99);
    expect(aggregate.temporal.target99).toBe("insufficient-evidence");
    expect(aggregateRecognitionBenchmarks([account]).temporal).toEqual(
      account.temporal,
    );
  });

  it("retains conflicting training keys when considering a normalized future alias", () => {
    const result = evaluateRecognitionBenchmark(
      state([
        manual("a", "POS Sonderladen Ref: OLD123", "2026-09-01"),
        manual("b", "POS Sonderladen Ref: OLD123", "2026-09-02", {
          category: "Shopping",
        }),
        manual("c", "POS Sonderladen Ref: NEW999", "2026-09-03"),
        manual("d", "POS Sonderladen Ref: THIRD777", "2026-09-04"),
        manual("e", "POS Sonderladen Ref: FOURTH777", "2026-09-05"),
      ]),
      index,
    );
    expect(result.split.conflictingTrainingRules).toBe(1);
    expect(result.split.learnedRules).toBe(1);
    expect(result.temporal).toMatchObject({ automatic: 0, reviewRequested: 2 });
  });

  it("rejects invalid split options and invalid rate counts", () => {
    for (const holdoutFraction of [0, 1, NaN, -0.1])
      expect(() =>
        evaluateRecognitionBenchmark(state([]), index, { holdoutFraction }),
      ).toThrow();
    expect(() => benchmarkRate(2, 1)).toThrow();
    expect(() => benchmarkRate(0.5, 1)).toThrow();
    expect(
      evaluateRecognitionBenchmark(state([]), index).split.temporalAvailable,
    ).toBe(false);
  });

  it("marks seven human labels insufficient even when measured coverage is below target", () => {
    const result = evaluateRecognitionBenchmark(
      state(
        Array.from({ length: 7 }, (_, i) =>
          manual(`small-${i}`, "POS Unbekannterladen"),
        ),
      ),
      index,
    );
    expect(result.temporal.labels.joint).toBe(7);
    expect(result.temporal.automaticCoverage.rate).toBe(0);
    expect(result.temporal.jointCorrectness.rate).toBe(0);
    expect(result.temporal.target99).toBe("insufficient-evidence");
  });
});

describe("operator benchmark privacy and immutability", () => {
  afterEach(() => {
    vi.doUnmock("node:util");
    vi.doUnmock("@/lib/server/config");
    vi.doUnmock("@/lib/server/database");
    vi.doUnmock("node:sqlite");
    vi.restoreAllMocks();
    process.exitCode = 0;
  });

  it.each([
    {
      readonly: false,
      badSnapshot: false,
      oversized: false,
      requireTarget: false,
    },
    {
      readonly: true,
      badSnapshot: false,
      oversized: false,
      requireTarget: false,
    },
    {
      readonly: false,
      badSnapshot: true,
      oversized: false,
      requireTarget: false,
    },
    {
      readonly: true,
      badSnapshot: false,
      oversized: true,
      requireTarget: false,
    },
    {
      readonly: true,
      badSnapshot: false,
      oversized: false,
      requireTarget: true,
    },
  ])(
    "evaluates sequentially and safely with $readonly read-only / $badSnapshot invalid / $oversized oversized",
    async (options) => {
      const db = new DatabaseSync(":memory:");
      db.exec(`
      CREATE TABLE finance (user_id TEXT PRIMARY KEY, state_json TEXT, revision INTEGER, updated_at INTEGER);
      CREATE TABLE merchants (
        id TEXT, canonical_name TEXT, aliases_json TEXT, regex_json TEXT,
        default_category TEXT, region TEXT, source TEXT, updated_at INTEGER,
        city TEXT, license TEXT, attribution TEXT, logo_json TEXT, wikidata_id TEXT,
        requires_category_evidence INTEGER DEFAULT 0
      );
      CREATE TABLE automation_jobs (id TEXT);
    `);
      const insert = db.prepare("INSERT INTO finance VALUES (?, ?, 1, 123)");
      insert.run(
        "secret-user-a",
        JSON.stringify(state([manual("private-booking", "BILLA")])),
      );
      insert.run(
        "secret-user-b",
        options.badSnapshot
          ? '{"secret-validation-text":"private financial value"}'
          : options.oversized
            ? "x".repeat(20 * 1024 * 1024 + 1)
            : JSON.stringify(state([manual("private-booking", "BILLA")])),
      );
      const snapshots = db
        .prepare("SELECT * FROM finance ORDER BY user_id")
        .all();
      const close = vi.fn();
      const logging = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.doMock("node:util", async (original) => ({
        ...(await original<typeof import("node:util")>()),
        parseArgs: () => ({
          values: {
            readonly: options.readonly,
            "verify-unchanged": true,
            "holdout-fraction": "0.3",
            "require-target": options.requireTarget,
          },
        }),
      }));
      vi.doMock("@/lib/server/config", () => ({
        readAccountConfig: () => ({ databasePath: "not-printed" }),
      }));
      vi.doMock("@/lib/server/database", () => ({
        MAX_FINANCE_BYTES: 20 * 1024 * 1024,
        AccountDatabase: class {
          read<T>(action: (database: DatabaseSync) => T) {
            return action(db);
          }
          close = close;
        },
      }));
      const readonlyOpen = vi.fn(function () {
        return db;
      });
      if (options.readonly) {
        vi.doMock("node:sqlite", () => ({ DatabaseSync: readonlyOpen }));
        vi.spyOn(db, "close").mockImplementation(close);
      }
      vi.resetModules();
      try {
        await import("../../../scripts/statement-recognition-benchmark");
        expect(logging).toHaveBeenCalledTimes(1);
        const serialized = String(logging.mock.calls[0][0]);
        const result = JSON.parse(serialized);
        const failed = options.badSnapshot || options.oversized;
        expect(result).toMatchObject({
          accountCount: 2,
          evaluatedAccounts: failed ? 1 : 2,
          financeUnchanged: true,
          status: failed
            ? "incomplete"
            : options.requireTarget
              ? "target-not-supported"
              : "complete",
          accounts: [{ accountOrdinal: 1 }, { accountOrdinal: 2 }],
        });
        if (failed) {
          expect(result.accounts[1].error).toBe(
            options.oversized ? "snapshot-limit" : "account-evaluation-failed",
          );
          expect(process.exitCode).toBe(1);
        }
        if (options.requireTarget && !failed) expect(process.exitCode).toBe(2);
        if (options.readonly)
          expect(readonlyOpen).toHaveBeenCalledWith("not-printed", {
            readOnly: true,
          });
        // Empty merchants table must stay empty: no fallback seeds are synthesized.
        expect(result.aggregate.temporal.automatic).toBe(0);
        expect(
          db.prepare("SELECT * FROM finance ORDER BY user_id").all(),
        ).toEqual(snapshots);
        expect(
          db.prepare("SELECT count(*) AS count FROM automation_jobs").get()!
            .count,
        ).toBe(0);
        expect(close).toHaveBeenCalledTimes(1);
        for (const secret of [
          "secret-user",
          "private-booking",
          "BILLA",
          "not-printed",
          "secret-validation-text",
          "private financial value",
        ])
          expect(serialized).not.toContain(secret);
      } finally {
        if (options.readonly) vi.mocked(db.close).mockRestore();
        db.close();
      }
    },
  );
});
