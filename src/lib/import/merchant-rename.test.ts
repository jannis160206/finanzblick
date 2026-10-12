import { expect, it } from "vitest";
import { actualBookings } from "@/lib/calc";
import { exportWorkbook, parseWorkbook } from "@/lib/excel";
import { createSeed } from "@/lib/seed";
import { assignTransactions } from "@/lib/transaction-tools";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { createAccountMerchantResolver } from "@/lib/automation/aliases";
import { statementFingerprint } from "./identity";
import {
  applyMerchantRules,
  createMerchantNameApplier,
  merchantAliasSourceKey,
  rememberMerchantRename,
} from "./merchant-rules";
import { commitStatementImport, prepareStatementImport } from "./review";

const original: Transaction = {
  id: "kukowitsch", date: "2026-09-01", bank: "Raiffeisen", pocket: null,
  description: "KUKOWITSCH 3219", amount: -20, category: "Sonstiges",
  includeInPlan: true, categoryOverride: true, manualCategory: true,
  reviewed: true, is_locked: true,
};
const fixture = (patch: Partial<AppState> = {}): AppState => ({
  ...createSeed(), transactions: [original], financeRows: [], fixedReceipts: [],
  reviewQueue: [], merchantRules: [], ...patch,
});
const withoutIdentity = (row: Transaction) => {
  const { merchantAlias, merchantId, merchantLogo, merchantMatch, merchantNameConfirmed, ...bankFacts } = row;
  void merchantAlias; void merchantId; void merchantLogo; void merchantMatch; void merchantNameConfirmed;
  return bankFacts;
};

it("propagates an explicit rename across reviewed, locked, credited and other-bank twins without reassigning their finances", () => {
  const rows = [
    original,
    { ...original, id: "older", date: "2026-08-01", category: "Shopping" as const, fixedCost: false },
    { ...original, id: "credit", amount: 20, category: "Rückerstattungen" as const },
    { ...original, id: "other-bank", bank: "Amex", merchantAlias: "Legacy alias", merchantNameConfirmed: true },
  ];
  const unrelated = { ...original, id: "unrelated", description: "KUKOWITSCH 3220" };
  const receipt = { ...original, id: "receipt", amount: -30 };
  const queued = { ...original, id: "pending", amount: null };
  const state = fixture({
    transactions: [...rows, unrelated],
    fixedReceipts: [{
      key: statementFingerprint(receipt), merchantKey: merchantAliasSourceKey(receipt),
      date: receipt.date, amount: receipt.amount, category: "Shopping", booking: receipt,
    }],
    reviewQueue: [{ kind: "booking", id: queued.id, draft: queued, message: "Betrag fehlt" }],
  });
  const before = structuredClone(state);
  const saved = assignTransactions(state, [original.id], {
    category: original.category, merchantAlias: "Trafik KUKOWITSCH",
  });
  expect(saved.transactions.slice(0, rows.length).map(row => row.merchantAlias))
    .toEqual(rows.map(() => "Trafik KUKOWITSCH"));
  for (let index = 0; index < rows.length; index++) {
    expect(withoutIdentity(saved.transactions[index])).toEqual(withoutIdentity(rows[index]));
    expect(statementFingerprint(saved.transactions[index])).toBe(statementFingerprint(rows[index]));
  }
  expect(saved.transactions.at(-1)).toEqual(unrelated);
  expect(saved.fixedReceipts?.[0]).toMatchObject({
    ...state.fixedReceipts![0], booking: { ...receipt, merchantAlias: "Trafik KUKOWITSCH" },
  });
  expect(saved.reviewQueue?.[0]).toMatchObject({ draft: { ...queued, merchantAlias: "Trafik KUKOWITSCH" } });
  expect(saved.financeRows).toEqual(state.financeRows);
  expect(state).toEqual(before);
});

it("remembers the source name through repeated renames and JSON/Excel reloads for future imports and reviewed rows", async () => {
  const first = assignTransactions(fixture(), [original.id], {
    category: original.category, merchantAlias: "Trafik KUKOWITSCH",
  });
  const second = assignTransactions(first, [original.id], {
    category: original.category, merchantAlias: "Meine Trafik",
  });
  const saved = assignTransactions(second, [original.id], {
    category: original.category, merchantAlias: "Meine Trafik aktuell",
  });
  for (const restored of [
    appStateSchema.parse(JSON.parse(JSON.stringify(saved))),
    (await parseWorkbook(await exportWorkbook(saved))).state,
  ]) {
    expect(restored.merchantNameRules).toEqual(saved.merchantNameRules);
    const future = { ...original, id: "future", date: "2026-10-01", bank: "Revolut", is_locked: undefined };
    const prepared = prepareStatementImport([{
      file: "synthetic.csv", source: "Revolut", rows: [future], issues: [], skipped: 0,
    }], restored);
    expect(prepared.automatic[0]).toMatchObject({ merchantAlias: "Meine Trafik aktuell" });
    const olderName = { ...future, id: "old-alias", merchantAlias: "Trafik KUKOWITSCH", merchantNameConfirmed: true };
    expect(applyMerchantRules(restored, [olderName])[0].merchantAlias).toBe("Meine Trafik aktuell");
    expect(createAccountMerchantResolver(restored)(future)).toMatchObject({
      kind: "matched", choice: { merchantAlias: "Meine Trafik aktuell" },
    });
    const imported = commitStatementImport(restored, prepared.automatic, [], prepared.metadata).state;
    expect(actualBookings(imported).find(row => row.id === future.id)?.merchantAlias).toBe("Meine Trafik aktuell");
  }
});

it("propagates a name edited in statement review without overwriting another twin's manual category", () => {
  const twin = { ...original, id: "manual-twin", category: "Shopping" as const };
  const saved = commitStatementImport(fixture({ transactions: [original, twin] }), [{
    ...original, merchantAlias: "Trafik KUKOWITSCH", merchantNameConfirmed: true,
  }]).state;
  expect(saved.transactions[1]).toMatchObject({ ...twin, merchantAlias: "Trafik KUKOWITSCH" });
  expect(saved.merchantNameRules).toContainEqual({
    key: merchantAliasSourceKey(original), merchantAlias: "Trafik KUKOWITSCH",
  });
});

it("renames all bookings sharing a current display name while keeping every original source link", () => {
  const rows = [
    { ...original, merchantAlias: "Trafik KUKOWITSCH", merchantNameConfirmed: true },
    { ...original, id: "second-source", description: "KUKOWITSCH FILIALE", merchantAlias: "Trafik KUKOWITSCH" },
  ];
  const saved = rememberMerchantRename(fixture({ transactions: rows }), rows[0], "Meine Trafik");
  expect(saved.transactions.map(row => row.merchantAlias)).toEqual(["Meine Trafik", "Meine Trafik"]);
  expect(applyMerchantRules(saved, rows.map(row => ({ ...row, merchantAlias: undefined })))
    .map(row => row.merchantAlias)).toEqual(["Meine Trafik", "Meine Trafik"]);
});

it("keeps transitive old-alias links independent of ledger order for later credits", () => {
  const bridge = { ...original, id: "bridge", merchantAlias: "Alte Trafik" };
  const branch = {
    ...original, id: "branch", description: "KUKOWITSCH FILIALE",
    merchantAlias: "Alte Trafik",
  };
  for (const rows of [[branch, bridge, original], [original, bridge, branch]]) {
    const saved = rememberMerchantRename(fixture({ transactions: rows }), original, "Meine Trafik");
    expect(saved.transactions.map(row => row.merchantAlias)).toEqual(rows.map(() => "Meine Trafik"));
    expect(applyMerchantRules(saved, [{
      ...branch, id: "future-credit", amount: 20, merchantAlias: undefined,
      category: "Rückerstattungen",
    }])[0].merchantAlias).toBe("Meine Trafik");
  }
});

it.each(["PayPal", "POS 3,00 AT D1"])("does not learn an unsafe blanket rename for %s", description => {
  const row = { ...original, description, rawDescription: description };
  const state = fixture({ transactions: [row, { ...row, id: "unrelated" }] });
  const saved = assignTransactions(state, [row.id], { category: row.category, merchantAlias: "Mein Einkauf" });
  expect(saved.transactions[0].merchantAlias).toBe("Mein Einkauf");
  expect(saved.transactions[1].merchantAlias).toBeUndefined();
  expect(saved.merchantNameRules).toBeUndefined();
});

it("keeps private recipient identities bank-scoped and conflicting name links unresolved", () => {
  const row = {
    ...original, description: "Sonstiges IBAN Empfaenger: AT000000000000000001",
  };
  const state = rememberMerchantRename(fixture({ transactions: [row] }), row, "Empfänger");
  expect(applyMerchantRules(state, [
    { ...row, bank: "Revolut" },
    { ...row, description: row.description.replace(/001$/, "002") },
  ]).map(item => item.merchantAlias)).toEqual([undefined, undefined]);
  const conflict = fixture({
    merchantNameRules: [
      { key: merchantAliasSourceKey(original)!, merchantAlias: "Erster Name" },
      { key: merchantAliasSourceKey(original)!, merchantAlias: "Zweiter Name" },
    ],
  });
  expect(createMerchantNameApplier(conflict)(original)).toBe(original);
});
