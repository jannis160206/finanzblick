import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { appStateSchema } from "../src/lib/types";
import { AccountDatabase, MAX_FINANCE_BYTES } from "../src/lib/server/database";
import { readAccountConfig } from "../src/lib/server/config";
import { readMerchantDefinitions } from "../src/lib/automation/store";
import { MerchantIndex } from "../src/lib/automation/merchants";
import {
  aggregateRecognitionBenchmarks,
  evaluateRecognitionBenchmark,
  type RecognitionBenchmarkResult,
} from "../src/lib/automation/recognition-benchmark";

function fingerprint(db: DatabaseSync): string {
  const hash = createHash("sha256");
  // Hash bounded chunks, including oversized snapshots, without materializing them.
  for (const row of db
    .prepare(
      "SELECT user_id, length(state_json) AS characters, revision, updated_at FROM finance ORDER BY user_id",
    )
    .iterate()) {
    hash.update(JSON.stringify(row));
    for (
      let offset = 1;
      offset <= Number(row.characters);
      offset += 1_048_576
    ) {
      const chunk = db
        .prepare(
          "SELECT substr(state_json, ?, 1048576) AS chunk FROM finance WHERE user_id = ?",
        )
        .get(offset, row.user_id)!;
      hash.update(String(chunk.chunk));
    }
  }
  return hash.digest("hex");
}

function run() {
  const { values } = parseArgs({
    options: {
      readonly: { type: "boolean", default: false },
      "verify-unchanged": { type: "boolean", default: false },
      "holdout-fraction": { type: "string", default: "0.3" },
      "require-target": { type: "boolean", default: false },
    },
  });
  const fraction = Number(values["holdout-fraction"]);
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1)
    throw new Error("Invalid options.");
  const config = readAccountConfig();
  let accounts: AccountDatabase | undefined;
  let db: DatabaseSync | undefined;
  try {
    if (values.readonly) {
      db = new DatabaseSync(config.databasePath, { readOnly: true });
    } else {
      accounts = new AccountDatabase(config.databasePath);
      db = accounts.read((database) => database);
    }
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    const before = values["verify-unchanged"] ? fingerprint(db) : undefined;
    // Reject oversized catalogs before loading them into memory.
    const limits = db
      .prepare(
        `
      SELECT count(*) AS merchants FROM merchants
    `,
      )
      .get()!;
    if (Number(limits.merchants) > 10_000)
      throw new Error("Catalog limit exceeded.");
    const index = new MerchantIndex(readMerchantDefinitions(db));
    const count = Number(
      db.prepare("SELECT count(*) AS count FROM finance").get()!.count,
    );
    const results: RecognitionBenchmarkResult[] = [];
    const reports: {
      accountOrdinal: number;
      result?: RecognitionBenchmarkResult;
      error?: string;
    }[] = [];
    let ordinal = 0;
    // The cursor contains only account keys and lengths, never all snapshots.
    for (const item of db
      .prepare(
        "SELECT user_id, length(CAST(state_json AS BLOB)) AS bytes FROM finance ORDER BY user_id",
      )
      .iterate()) {
      ordinal++;
      if (Number(item.bytes) > MAX_FINANCE_BYTES) {
        reports.push({ accountOrdinal: ordinal, error: "snapshot-limit" });
        continue;
      }
      try {
        const row = db
          .prepare("SELECT state_json FROM finance WHERE user_id = ?")
          .get(item.user_id)!;
        const result = evaluateRecognitionBenchmark(
          appStateSchema.parse(JSON.parse(String(row.state_json))),
          index,
          { holdoutFraction: fraction },
        );
        results.push(result);
        reports.push({ accountOrdinal: ordinal, result });
      } catch {
        // Validation errors can contain bank text, IDs and amounts. Never print them.
        reports.push({
          accountOrdinal: ordinal,
          error: "account-evaluation-failed",
        });
      }
    }
    const unchanged = before === undefined ? null : before === fingerprint(db);
    const failed =
      reports.some((report) => report.error) || unchanged === false;
    const aggregate = aggregateRecognitionBenchmarks(results);
    const targetUnmet =
      values["require-target"] &&
      aggregate.temporal.target99 !== "supported-on-labeled-holdout";
    console.log(
      JSON.stringify({
        version: 1,
        accountCount: count,
        evaluatedAccounts: results.length,
        holdoutFraction: fraction,
        databaseMode: values.readonly ? "readonly" : "native-open-query-only",
        financeUnchanged: unchanged,
        aggregate,
        accounts: reports,
        status: failed
          ? "incomplete"
          : targetUnmet
            ? "target-not-supported"
            : "complete",
      }),
    );
    if (failed) process.exitCode = 1;
    else if (targetUnmet) process.exitCode = 2;
  } finally {
    if (accounts) accounts.close();
    else db?.close();
  }
}

try {
  run();
} catch {
  console.log(
    JSON.stringify({ version: 1, status: "failed", error: "benchmark-failed" }),
  );
  process.exitCode = 1;
}
