import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { resetSecretKeyCache } from "@/lib/server/secrets";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { writeUserSecret } from "@/lib/server/user-secrets";
import { readPayslipLogFile } from "@/lib/server/payslip-log-store";
import type { Payslip } from "@/lib/payslip-schema";
import { addInboxItem, listInbox } from "./inbox";
import type { PayslipRead, PayslipReader } from "./payslip-runtime";
import { mergeServerPayslips, processDriveInbox } from "./payslips";
import { markDriveLink, readDriveLink, saveDriveConnection } from "./store";

const october: Payslip = { year: 2026, month: 10, employer: "Musterbetrieb GmbH", regularGross: 3000, specialGross: 0, monthlyPayroll: true, netPay: 2100 };
let directory: string;
let accounts: AccountDatabase;
let userId: string;

beforeEach(async () => {
  resetSecretKeyCache();
  directory = createTestDirectory();
  accounts = new AccountDatabase(join(directory, "accounts.sqlite"));
  userId = (await accounts.register("alice", "test-only-password-123")).user.id;
  accounts.putFinance(userId, blankTestState(), 0);
  await saveDriveConnection(accounts, userId, { accessToken: "a", accessExpiresAt: 1, refreshToken: "r" }, {});
});
afterEach(() => {
  accounts.close();
  resetSecretKeyCache();
  rmSync(directory, { recursive: true, force: true });
});

async function waiting(...ids: string[]) {
  await markDriveLink(accounts, userId, (link) => ({
    ...link,
    processed: ids.map((id) => ({ id, kind: "payslips" as const, name: `${id}.pdf`, at: 1, outcome: "inbox" as const })),
  }));
  for (const id of ids) await addInboxItem(accounts, userId, { id, name: `${id}.pdf`, size: 4 }, Buffer.from("%PDF"), 1);
}

const reader = (answers: Record<string, PayslipRead | Error | ((passwords: string[]) => PayslipRead)>) => vi.fn<PayslipReader>(async (path, _bytes, passwords) => {
  const answer = answers[path.split(/[\\/]/).at(-1)!.replace(/\.pdf$/, "")];
  if (answer instanceof Error) throw answer;
  return typeof answer === "function" ? answer(passwords) : answer;
});
const ok = (...drafts: unknown[]): PayslipRead => ({ status: "ok", result: { drafts: drafts as Payslip[], issues: [] } });
const outcomes = async () => Object.fromEntries((await readDriveLink(accounts, userId))!.processed!.map((entry) => [entry.id, [entry.outcome, entry.note]]));

it("imports payslips without a browser exactly like an upload and leaves nothing behind", async () => {
  await waiting("slip-october", "steuer-bescheid", "slip-broken");
  const read = reader({ "slip-october": ok(october), "steuer-bescheid": ok(), "slip-broken": new Error("Die PDF konnte nicht gelesen werden.") });
  const before = accounts.getFinance(userId).revision;
  expect(await processDriveInbox(accounts, userId, { read })).toEqual({ imported: 1, waiting: 0, skipped: 1, failed: 1 });
  const { state, revision } = accounts.getFinance(userId);
  expect(revision).toBe(before + 1);
  expect(state?.payslips).toEqual([october]);
  expect(state?.financeRows.find((row) => row.id === "income-salary")?.values["2026-11"]).toBe(2100);
  expect(await listInbox(accounts, userId)).toEqual([]);
  expect(await outcomes()).toEqual({
    "slip-october": ["imported", "Im Hintergrund übernommen."],
    "steuer-bescheid": ["skipped", "Keine Lohnabrechnung erkannt."],
    "slip-broken": ["failed", "Die PDF konnte nicht gelesen werden."],
  });

  await waiting("slip-again");
  await processDriveInbox(accounts, userId, { read: reader({ "slip-again": ok(october) }) });
  expect(accounts.getFinance(userId).revision).toBe(before + 1);
  expect((await outcomes())["slip-again"]).toEqual(["imported", "Bereits vorhanden."]);
});

it("stores 2025 payslips only as reference and logs every background run", async () => {
  await waiting("slip-2025", "slip-locked");
  const read = reader({ "slip-2025": ok({ ...october, year: 2025, month: 12 }), "slip-locked": { status: "locked" } });
  expect(await processDriveInbox(accounts, userId, { read })).toMatchObject({ imported: 1, waiting: 1 });
  const { state } = accounts.getFinance(userId);
  expect(state?.payslips).toEqual([{ ...october, year: 2025, month: 12 }]);
  expect(state?.financeRows.find((row) => row.id === "income-salary")?.values["2026-01"]).toBeUndefined();
  expect((await outcomes())["slip-2025"]).toEqual(["imported", "Als Referenz übernommen – nicht im Budget."]);
  const [entry] = await readPayslipLogFile(accounts, userId);
  expect(entry).toMatchObject({
    source: "drive-background",
    stored: 1,
    reference: ["2025-12"],
    files: [{ name: "slip-2025.pdf", outcome: "imported" }, { name: "slip-locked.pdf", outcome: "waiting", note: "Passwort fehlt." }],
  });
  await processDriveInbox(accounts, userId, { read });
  expect(await readPayslipLogFile(accounts, userId)).toHaveLength(1);
});

it("keeps a protected payslip for the browser until a new stored password opens it", async () => {
  await waiting("slip-locked");
  const read = reader({ "slip-locked": (passwords) => passwords.includes("synthetisch-123") ? ok(october) : { status: "locked" } });
  expect(await processDriveInbox(accounts, userId, { read })).toMatchObject({ waiting: 1, imported: 0 });
  expect(await listInbox(accounts, userId)).toEqual([expect.objectContaining({ id: "slip-locked", waiting: "password", passwordAt: 0 })]);
  await processDriveInbox(accounts, userId, { read });
  expect(read).toHaveBeenCalledOnce();

  await writeUserSecret(accounts, userId, "payslip-password", "synthetisch-123");
  expect(await processDriveInbox(accounts, userId, { read })).toMatchObject({ imported: 1, waiting: 0 });
  expect(read).toHaveBeenLastCalledWith(expect.any(String), 4, ["synthetisch-123"], expect.anything());
  expect(accounts.getFinance(userId).state?.payslips).toEqual([october]);
});

it("never replaces different stored values in the background", async () => {
  accounts.putFinance(userId, { ...blankTestState(), payslips: [{ ...october, regularGross: 2900 }] }, accounts.getFinance(userId).revision);
  const revision = accounts.getFinance(userId).revision;
  await waiting("slip-changed");
  const read = reader({ "slip-changed": ok(october) });
  expect(await processDriveInbox(accounts, userId, { read })).toMatchObject({ waiting: 1 });
  expect(accounts.getFinance(userId)).toMatchObject({ revision, state: { payslips: [{ regularGross: 2900 }] } });
  expect(await listInbox(accounts, userId)).toEqual([expect.objectContaining({ id: "slip-changed", waiting: "conflict" })]);
  await processDriveInbox(accounts, userId, { read });
  expect(read).toHaveBeenCalledOnce();
});

it("merges like the upload: forecasts of that employer and year need a new confirmation", () => {
  const state = { ...blankTestState(), payrollForecasts: [{ year: 2026 as const, employer: "Musterbetrieb GmbH", months: [], standardPayrollConfirmed: true }] };
  const merged = mergeServerPayslips(state, [october]);
  expect("state" in merged && merged.state.payrollForecasts?.[0]).toMatchObject({ standardPayrollConfirmed: false });
  expect("state" in merged && merged.changed).toBe(1);
});
