import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { createTestDirectory } from "@/lib/server/test-support";
import { appStateSchema } from "@/lib/types";
import { IMPORT_RESULT_WARNING_JSON_BUDGET, IMPORT_WARNING_DETAILS_OMITTED } from "@/lib/import/result-schema";
import { AutomationStore } from "./store";
import { AutomationWorker } from "./worker";
import { MerchantIndex, seedMerchants } from "./merchants";
import { parseStatementInChild } from "./parser-runtime";

let directory: string;
let accounts: AccountDatabase;
let store: AutomationStore;
let userId: string;
const owner = "warning-boundary-worker";

beforeEach(async () => {
  directory = createTestDirectory();
  accounts = new AccountDatabase(join(directory, "synthetic.sqlite"));
  store = new AutomationStore(accounts);
  userId = (await accounts.register("alice", "test-only-password-123")).user.id;
  store.upsertMerchants(seedMerchants);
});
afterEach(() => {
  accounts.close();
  rmSync(directory, { recursive: true, force: true });
});

it("commits the good EUR row and consistent bounded warnings after real child parsing of 100 malformed foreign rows", async () => {
  const currency = "USD" + "X".repeat(1800);
  const bytes = Buffer.from([
    "Raiffeisen",
    "Buchungsdatum;Verwendungszweck/Text;Betrag;Währung",
    "2026-10-05;SPAR;-12,00;EUR",
    ...Array.from({ length: 100 }, (_, index) => `2026-10-06;foreign-${index};-5,00;${currency}`),
  ].join("\n"));
  const id = randomUUID();
  store.reserveUpload(userId, id, "warnings.csv", bytes.length);
  const path = store.filePath(id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  store.readyUpload(userId, id);
  const parsed = await parseStatementInChild(path, "warnings.csv", bytes.length);
  expect(parsed.rows).toHaveLength(1);
  expect(parsed.issues).toHaveLength(100);
  expect(parsed.issues.every((issue) => issue.action === "reupload" &&
    issue.reason === "foreign-currency" && !issue.draft)).toBe(true);
  expect(JSON.stringify(parsed.issues).length).toBeGreaterThan(262_144);

  expect(store.acquire(owner)).toBe(true);
  const worker = new AutomationWorker(store, owner, new MerchantIndex(store.loadMerchants()));
  const job = store.claim(owner);
  if (!job) throw new Error("Synthetic upload was not claimed.");
  await worker.process(job);

  const finance = accounts.getFinance(userId);
  const state = appStateSchema.parse(finance.state);
  const result = state.importResults?.find((item) => item.uploadId === id);
  expect(result).toBeDefined();
  expect(finance.revision).toBe(1);
  expect(state.transactions).toHaveLength(1);
  expect(state.transactions[0]).toMatchObject({ description: "SPAR", amount: -12 });
  expect(state.reviewQueue ?? []).toEqual([]);
  expect(result).toMatchObject({ uploadId: id, status: "with-warnings",
    inserted: 1, updated: 0, duplicates: 0, review: 0, skipped: 100 });
  expect(result!.issues).toHaveLength(100);
  expect(result!.warningDetailsOmitted).toBe(true);
  expect(result!.issues[0].message).toContain(IMPORT_WARNING_DETAILS_OMITTED);
  expect(result!.issues.every((issue) => issue.action === "reupload" &&
    issue.reason === "foreign-currency" && !issue.reviewId)).toBe(true);
  const completed = store.snapshot(userId).jobs.find((item) => item.id === id);
  expect(completed).toMatchObject({ status: "COMPLETED", attempts: 0, cursor: 1, result });
  const persisted = accounts.transaction((db) => db.prepare(
    "SELECT outcome_json AS json, length(outcome_json) AS length FROM automation_jobs WHERE id = ?",
  ).get(id));
  if (!persisted || typeof persisted.json !== "string" || typeof persisted.length !== "number")
    throw new Error("Synthetic checkpoint outcome was not persisted.");
  expect(persisted.length).toBeLessThanOrEqual(IMPORT_RESULT_WARNING_JSON_BUDGET);
  expect(JSON.parse(persisted.json)).toEqual(result);
  const financialOutcome = accounts.transaction((db) => db.prepare(
    "SELECT json_extract(state_json, '$.importResults[0]') AS json FROM finance WHERE user_id = ?",
  ).get(userId));
  if (!financialOutcome || typeof financialOutcome.json !== "string")
    throw new Error("Synthetic financial outcome was not persisted.");
  expect(JSON.parse(financialOutcome.json)).toEqual(JSON.parse(persisted.json));
  expect(financialOutcome.json.length).toBeLessThanOrEqual(IMPORT_RESULT_WARNING_JSON_BUDGET);
  console.info("Synthetic warning checkpoint proof", {
    inputBytes: bytes.length, outcomeCharacters: persisted.length, inserted: result!.inserted,
    review: result!.review, skipped: result!.skipped,
  });
});
