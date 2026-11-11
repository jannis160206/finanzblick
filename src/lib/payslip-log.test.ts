import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { appendPayslipLog, PAYSLIP_LOG_LIMIT, payslipLogEntry, readPayslipLog } from "@/lib/payslip-log";
import { appendPayslipLogFile, clearPayslipLogFile, readPayslipLogFile } from "@/lib/server/payslip-log-store";

const draft = { year: 2026, month: 10, employer: "Musterbetrieb GmbH", regularGross: 3000, specialGross: 0, monthlyPayroll: true } as const;

it("logs what an import read: complete and reference drafts, deduplicated issues, clipped texts", () => {
  const entry = payslipLogEntry({
    source: "upload",
    message: "x".repeat(1200),
    at: 5,
    files: [{ name: "Oktober.pdf", outcome: "imported" }],
    report: {
      drafts: [draft, { ...draft, year: 2025, month: 12 }, { year: 2026, month: 11, regularGross: 3100 }],
      issues: ["Kontrollwert unklar.", "Kontrollwert unklar."],
    },
    stored: 2,
  });
  expect(entry.message).toHaveLength(1000);
  expect(entry.issues).toEqual(["Kontrollwert unklar."]);
  expect(entry.reference).toEqual(["2025-12"]);
  expect(entry.drafts?.map(({ period, complete, reference }) => [period, complete, reference ?? false])).toEqual([
    ["2026-10", true, false], ["2025-12", true, true], ["2026-11", false, false],
  ]);
  expect(entry.drafts?.[2].fields).toEqual({ regularGross: 3100 });
  expect(payslipLogEntry({ source: "recheck", message: "" }).message).toBe("Ohne Meldung.");
});

it("keeps only the newest entries and drops damaged ones", () => {
  const entry = payslipLogEntry({ source: "drive", message: "ok", at: 1 });
  const full = Array.from({ length: PAYSLIP_LOG_LIMIT }, (_, index) => ({ ...entry, at: index }));
  expect(appendPayslipLog(full, { ...entry, at: 999 }).map((item) => item.at).slice(-2)).toEqual([PAYSLIP_LOG_LIMIT - 1, 999]);
  expect(appendPayslipLog(full, entry)).toHaveLength(PAYSLIP_LOG_LIMIT);
  expect(readPayslipLog([entry, { at: "kaputt" }, null])).toEqual([entry]);
  expect(readPayslipLog("kein Protokoll")).toEqual([]);
});

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "finanzblick-payslip-log-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("stores the log per user next to the database and survives a damaged file", async () => {
  const host = { path: join(directory, "accounts.sqlite") };
  const entry = payslipLogEntry({ source: "drive-background", message: "1 übernommen", at: 7 });
  await Promise.all([appendPayslipLogFile(host, "alice", entry), appendPayslipLogFile(host, "alice", { ...entry, at: 8 })]);
  expect((await readPayslipLogFile(host, "alice")).map((item) => item.at)).toEqual([7, 8]);
  expect(await readPayslipLogFile(host, "bob")).toEqual([]);
  expect(JSON.parse(await readFile(join(directory, "payslip-logs", "alice.json"), "utf8"))).toHaveLength(2);
  await writeFile(join(directory, "payslip-logs", "alice.json"), "{kaputt");
  expect(await readPayslipLogFile(host, "alice")).toEqual([]);
  await clearPayslipLogFile(host, "alice");
  expect(await readPayslipLogFile(host, "alice")).toEqual([]);
  await expect(readPayslipLogFile(host, "../alice")).rejects.toThrow();
});
