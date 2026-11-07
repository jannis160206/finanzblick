import { readFile, readdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { transactionSchema, type Transaction } from "@/lib/types";
import { AutomationStore } from "@/lib/automation/store";
import { parseServerStatement } from "@/lib/automation/parse";
import { BANK_SYNC_FORMAT, bankAccountTarget, parseBankSync, type BankSyncFile } from "@/lib/import/bank-sync";
import { deduplicateStatements } from "@/lib/import/statements";
import { RAIFFEISEN_ACCOUNT } from "@/lib/accounts";
import { readXs2aConfig, Xs2aClient, Xs2aError } from "./xs2a";
import { autoSyncDue, bankStatus, linkedBankUsers, syncBank } from "./sync";

const encode = (file: BankSyncFile) => new TextEncoder().encode(JSON.stringify(file));
const raiffeisenAccount = { id: "bac_1", bankName: "Raiffeisenbank Kärnten", bic: "RZKTAT2K123", iban: "AT611904300234573201", description: "Girokonto", type: "giro" };
const syncFile = (turnovers: BankSyncFile["accounts"][number]["turnovers"], extra: Partial<BankSyncFile["accounts"][number]> = {}): BankSyncFile => ({
  format: BANK_SYNC_FORMAT, version: 1, provider: "xs2a", fetchedAt: "2026-11-10T08:00:00.000Z",
  accounts: [{ ...raiffeisenAccount, turnovers, ...extra }],
});
const turnover = (date: string, amount: number, purpose: string[], extra: Record<string, unknown> = {}) => ({
  booking_date: `${date}T00:00:00Z`, amount, currency_id: "EUR", purpose, counter_holder: "SPAR Klagenfurt", ...extra,
});

describe("bank sync parser", () => {
  it("maps Raiffeisen turnovers onto the existing giro account and skips pending/cancelled ones", () => {
    const result = parseBankSync(encode(syncFile([
      turnover("2026-11-05", -23.45, ["Einkauf", "Karte 1234"]),
      turnover("2026-11-06", -10, ["vorgemerkt"], { prebooked: true }),
      turnover("2026-11-06", -11, ["storniert"], { canceled: true }),
      turnover("2026-11-07", 2500, ["Gehalt November"], { counter_holder: "Arbeitgeber GmbH", counter_iban: "AT021100000012345678" }),
    ])), "Bankabruf-2026-11-10.bank.json");
    expect(result.source).toBe("Bank");
    expect(result.skipped).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ date: "2026-11-05", bank: "Raiffeisen", pocket: RAIFFEISEN_ACCOUNT, amount: -23.45, category: "Lebensmittel" });
    expect(result.rows[0].bankReference).toMatch(/^xs2a:[0-9a-f]{24}$/);
    expect(result.rows[1].rawDetails).toEqual(expect.arrayContaining(["Gehalt November", "IBAN AT021100000012345678", "Bankverbindung (XS2A)"]));
    for (const row of result.rows) expect(transactionSchema.safeParse(row).success).toBe(true);
  });

  it("creates stable references and distinguishes identical bookings on one day", () => {
    const file = syncFile([turnover("2026-11-05", -2.5, ["Kaffee"]), turnover("2026-11-05", -2.5, ["Kaffee"])]);
    const first = parseBankSync(encode(file), "a.bank.json").rows.map((row) => row.bankReference);
    const second = parseBankSync(encode(file), "b.bank.json").rows.map((row) => row.bankReference);
    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(2);
    expect(first[1]).toMatch(/#2$/);
  });

  it("prefers the bank's transaction_id for the reference", () => {
    const a = parseBankSync(encode(syncFile([turnover("2026-11-05", -2.5, ["Kaffee"], { transaction_id: "tx-1" })])), "a.bank.json").rows[0];
    const b = parseBankSync(encode(syncFile([turnover("2026-11-05", -2.5, ["Kaffee Bar"], { transaction_id: "tx-1" })])), "b.bank.json").rows[0];
    const c = parseBankSync(encode(syncFile([turnover("2026-11-05", -2.5, ["Kaffee"], { transaction_id: "tx-2" })])), "c.bank.json").rows[0];
    expect(a.bankReference).toBe(b.bankReference);
    expect(a.bankReference).not.toBe(c.bankReference);
  });

  it("skips days already covered by CSV imports and reports foreign currencies", () => {
    const result = parseBankSync(encode(syncFile([
      turnover("2026-11-01", -5, ["alt"]),
      turnover("2026-11-03", -6, ["neu"]),
      turnover("2026-11-04", -7, ["USD"], { currency_id: "USD" }),
    ], { coveredUntil: "2026-11-01" })), "x.bank.json");
    expect(result.rows.map((row) => row.date)).toEqual(["2026-11-03"]);
    expect(result.skipped).toBe(1);
    expect(result.issues).toEqual([expect.objectContaining({ reason: "foreign-currency", action: "reupload" })]);
  });

  it("rejects foreign JSON files and is reachable through the server parser", async () => {
    expect(() => parseBankSync(new TextEncoder().encode('{"hello":1}'), "x.bank.json")).toThrow(/unbekanntes Format/);
    const result = await parseServerStatement(encode(syncFile([turnover("2026-11-05", -1, ["Test"])])), "Bankabruf.bank.json");
    expect(result.rows).toHaveLength(1);
  });

  it("maps Revolut and unknown banks to readable accounts", () => {
    expect(bankAccountTarget({ bankName: "Revolut Bank UAB", bic: "REVOLT21", description: null, iban: null })).toEqual({ bank: "Revolut", pocket: "Persönliches Konto" });
    expect(bankAccountTarget({ bankName: "Erste Bank", bic: "GIBAATWW", description: null, iban: "AT00 1234 5678 9012 3456" })).toEqual({ bank: "Erste Bank", pocket: "Konto …3456" });
  });
});

describe("cross-source duplicates", () => {
  const csvRow = (date: string, amount: number, description: string): Transaction => transactionSchema.parse({
    id: crypto.randomUUID(), date, bank: "Raiffeisen", pocket: RAIFFEISEN_ACCOUNT, description, category: "Lebensmittel", amount, includeInPlan: true,
  });
  it("treats a synced booking as known when the CSV already has it, and vice versa", () => {
    const synced = parseBankSync(encode(syncFile([turnover("2026-11-05", -23.45, ["Bezahlung Karte"]), turnover("2026-11-05", -9.99, ["Netflix"])])), "x.bank.json").rows;
    const existing = [csvRow("2026-11-05", -23.45, "SPAR DANKT 1234 KLAGENFURT")];
    const fromBank = deduplicateStatements(synced, existing);
    expect(fromBank.duplicates).toBe(1);
    expect(fromBank.rows.map((row) => row.amount)).toEqual([-9.99]);
    const fromCsv = deduplicateStatements([csvRow("2026-11-05", -9.99, "NETFLIX.COM")], synced);
    expect(fromCsv.duplicates).toBe(1);
  });
  it("only consumes one match per booking", () => {
    const synced = parseBankSync(encode(syncFile([turnover("2026-11-05", -2.5, ["Kaffee"]), turnover("2026-11-05", -2.5, ["Kaffee"])])), "x.bank.json").rows;
    const result = deduplicateStatements(synced, [csvRow("2026-11-05", -2.5, "CAFE")]);
    expect(result.duplicates).toBe(1);
    expect(result.rows).toHaveLength(1);
  });
});

describe("xs2a client", () => {
  it("reads configuration from the environment", () => {
    expect(readXs2aConfig({})).toBeNull();
    expect(readXs2aConfig({ XS2A_API_KEY: " key " })).toEqual({ apiKey: "key", baseUrl: "https://api.xs2a.com" });
    expect(() => readXs2aConfig({ XS2A_API_KEY: "k", XS2A_API_URL: "http://insecure" })).toThrow();
  });
  it("authenticates with basic auth and paginates", async () => {
    const fetcher = vi.fn(async (...args: [URL | RequestInfo, RequestInit?]) => {
      const page = Number(new URL(String(args[0])).searchParams.get("page"));
      return Response.json({ data: [{ id: `bac_${page}` }], current_page: page, last_page: 2 });
    });
    const client = new Xs2aClient({ apiKey: "secret", baseUrl: "https://api.xs2a.com" }, fetcher as unknown as typeof fetch);
    expect((await client.listAccounts("token")).map((account) => account.id)).toEqual(["bac_1", "bac_2"]);
    const init = fetcher.mock.calls[0][1]!;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("api:token").toString("base64")}`);
  });
  it("turns API errors into Xs2aError", async () => {
    const client = new Xs2aClient({ apiKey: "secret", baseUrl: "https://api.xs2a.com" },
      (async () => Response.json({ message: "Invalid api key" }, { status: 401 })) as unknown as typeof fetch);
    await expect(client.createUser("a", "b@c.d")).rejects.toEqual(new Xs2aError(401, "Invalid api key"));
  });
  it("reports when a sync needs user interaction (202) and accepts 204", async () => {
    const respond = (response: () => Response) => new Xs2aClient({ apiKey: "k", baseUrl: "https://api.xs2a.com" }, (async () => response()) as unknown as typeof fetch);
    expect(await respond(() => new Response(null, { status: 204 })).syncConnection("t", "bcn_1")).toBeNull();
    expect(await respond(() => Response.json({ wizard_session_key: "w", transaction: "x" }, { status: 202 })).syncConnection("t", "bcn_1"))
      .toMatchObject({ wizard_session_key: "w" });
  });
});

describe("bank sync service", () => {
  let directory: string;
  let accounts: AccountDatabase;
  let userId: string;
  beforeEach(async () => {
    directory = createTestDirectory();
    accounts = new AccountDatabase(join(directory, "bank.sqlite"));
    userId = (await accounts.register("alice", "test-only-password-123")).user.id;
    vi.stubEnv("XS2A_API_KEY", "test-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    accounts.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function fakeApi() {
    return {
      createUser: vi.fn(async () => ({ id: "bus_1" })),
      createAccessToken: vi.fn(async () => ({ id: "tok_1", token: "access" })),
      listConnections: vi.fn(async () => [{ id: "bcn_1", bank_name: "Raiffeisen", sync_active: true, consent_valid_until: "2027-02-01 00:00:00" }]),
      syncConnection: vi.fn(async () => null),
      listAccounts: vi.fn(async () => [{ id: "bac_1", bank_connection_id: "bcn_1", bank_name: "Raiffeisenbank Kärnten", bic: "RZKTAT2K", iban: "AT611904300234573201", description: "Girokonto" }]),
      turnovers: vi.fn(async () => [turnover("2026-11-02", -4, ["alt"]), turnover("2026-11-05", -23.45, ["neu"])]),
      balance: vi.fn(async () => ({ balance: 1234.56, available: 1200, date: "2026-11-10" })),
    } as unknown as Xs2aClient;
  }

  it("requires a connection before syncing", async () => {
    await expect(syncBank(accounts, { id: userId, username: "alice" }, { api: fakeApi() })).rejects.toThrow(/Noch keine Bank/);
    expect((await bankStatus(accounts, userId)).configured).toBe(true);
  });

  it("queues fetched turnovers as an import with the CSV coverage date and stores balances", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const linkDir = join(dirname(accounts.path), "bank-links");
    await mkdir(linkDir, { recursive: true });
    await writeFile(join(linkDir, `${userId}.json`), JSON.stringify({ version: 1, bankUserId: "bus_1", token: null }));
    accounts.putFinance(userId, { ...blankTestState(), transactions: [transactionSchema.parse({
      id: crypto.randomUUID(), date: "2026-11-03", bank: "Raiffeisen", pocket: RAIFFEISEN_ACCOUNT, description: "CSV", category: "Prüfen", amount: -1, includeInPlan: true,
    })] }, 0);
    const api = fakeApi();
    const now = Date.parse("2026-11-10T08:00:00Z");
    const result = await syncBank(accounts, { id: userId, username: "alice" }, { api, now, refresh: true });
    expect(result).toMatchObject({ queued: true, rows: 2, lastSyncRows: 2 });
    expect(result.accounts[0]).toMatchObject({ bank: "Raiffeisen", pocket: RAIFFEISEN_ACCOUNT, balance: 1234.56, iban: "AT61 •••• 3201" });
    expect(result.connections[0]).toMatchObject({ id: "bcn_1", consentValidUntil: "2027-02-01 00:00:00" });
    expect(api.syncConnection).toHaveBeenCalledWith("access", "bcn_1");
    const uploads = await readdir(join(dirname(accounts.path), "statement-uploads"));
    expect(uploads).toHaveLength(1);
    const payload = JSON.parse(await readFile(join(dirname(accounts.path), "statement-uploads", uploads[0]), "utf8")) as BankSyncFile;
    expect(payload.accounts[0].coveredUntil).toBe("2026-11-03");
    const parsed = parseBankSync(new TextEncoder().encode(JSON.stringify(payload)), "x.bank.json");
    expect(parsed.rows.map((row) => row.date)).toEqual(["2026-11-05"]);
    expect(new AutomationStore(accounts).filePath(uploads[0])).toContain("statement-uploads");
    expect(await linkedBankUsers(accounts)).toEqual([userId]);
    expect(await autoSyncDue(accounts, userId, now + 60_000)).toBe(false);
    expect(await autoSyncDue(accounts, userId, now + 7 * 3_600_000)).toBe(true);
    const link = await readFile(join(linkDir, `${userId}.json`), "utf8");
    expect(JSON.parse(link)).toMatchObject({ token: { token: "access" }, lastSync: now, lastError: null });
    const consent = fakeApi();
    vi.mocked(consent.syncConnection).mockResolvedValue({ wizard_session_key: "w", transaction: "x" });
    const again = await syncBank(accounts, { id: userId, username: "alice" }, { api: consent, now: now + 3_600_000, refresh: true });
    expect(again.lastError).toMatch(/Freigabe erneuern/);
  });
});
