import { generateKeyPairSync, verify } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { parseBankSync, type BankSyncFile } from "@/lib/import/bank-sync";
import { RAIFFEISEN_ACCOUNT } from "@/lib/accounts";
import {
  EnableBankingClient, EnableBankingError, enableBankingJwt, pickBalances, readEnableBankingConfig, toTurnover, type EbTransaction,
} from "./enable-banking";
import {
  autoSyncDue, bankStatus, completeBankAuthorization, configuredBankProvider, removeBankConnection, renewBankConnection, startBankConnection, syncBank,
} from "./sync";
import { callbackRedirect, localCallbackPlan } from "./https-callback";

describe("local https bank callback", () => {
  it("only starts for a local https redirect on a separate port", () => {
    expect(localCallbackPlan({})).toBeNull();
    expect(localCallbackPlan({ ENABLEBANKING_REDIRECT_URL: "https://finanzen.example.com/api/bank/callback" })).toBeNull();
    expect(localCallbackPlan({ ENABLEBANKING_REDIRECT_URL: "https://localhost:3000/api/bank/callback" })).toBeNull();
    expect(localCallbackPlan({ ENABLEBANKING_REDIRECT_URL: "https://localhost:3443/api/bank/callback" }))
      .toEqual({ port: 3443, hostname: "127.0.0.1", target: "http://127.0.0.1:3000/api/bank/callback" });
  });
  it("forwards code and state to the app and rejects other paths", () => {
    expect(callbackRedirect("/api/bank/callback?code=a&state=b", "http://127.0.0.1:3000/api/bank/callback"))
      .toEqual({ status: 303, location: "http://127.0.0.1:3000/api/bank/callback?code=a&state=b" });
    expect(callbackRedirect("/other", "http://127.0.0.1:3000/api/bank/callback")).toEqual({ status: 404 });
  });
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const APP_ID = "0f8e7c6a-1234-4abc-9def-001122334455";
const config = { applicationId: APP_ID, privateKey, baseUrl: "https://api.enablebanking.com", redirectUrl: null };

const tx = (extra: Partial<EbTransaction> = {}): EbTransaction => ({
  entry_reference: "E1",
  transaction_amount: { currency: "EUR", amount: "23.45" },
  credit_debit_indicator: "DBIT",
  status: "BOOK",
  booking_date: "2026-11-05",
  creditor: { name: "SPAR Klagenfurt" },
  creditor_account: { iban: "AT021100000012345678" },
  debtor: { name: "Alice" },
  remittance_information: ["Einkauf", "Karte 1234"],
  ...extra,
});

describe("enable banking client", () => {
  it("reads the configuration and rejects incomplete or insecure settings", () => {
    expect(readEnableBankingConfig({})).toBeNull();
    expect(readEnableBankingConfig({ ENABLEBANKING_APP_ID: APP_ID })).toBeNull();
    const parsed = readEnableBankingConfig({ ENABLEBANKING_APP_ID: APP_ID, ENABLEBANKING_PRIVATE_KEY: pem.replace(/\n/g, "\\n") });
    expect(parsed).toMatchObject({ applicationId: APP_ID, baseUrl: "https://api.enablebanking.com", redirectUrl: null });
    expect(() => readEnableBankingConfig({ ENABLEBANKING_APP_ID: APP_ID, ENABLEBANKING_PRIVATE_KEY: pem, ENABLEBANKING_API_URL: "http://x" })).toThrow();
    expect(() => readEnableBankingConfig({ ENABLEBANKING_APP_ID: "bad id!", ENABLEBANKING_PRIVATE_KEY: pem })).toThrow();
  });

  it("signs an RS256 JWT with the application id as key id", () => {
    const now = Date.parse("2026-11-10T08:00:00Z");
    const [header, body, signature] = enableBankingJwt(config, now).split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ typ: "JWT", alg: "RS256", kid: APP_ID });
    expect(JSON.parse(Buffer.from(body, "base64url").toString())).toEqual({
      iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now / 1000, exp: now / 1000 + 3600,
    });
    expect(verify("RSA-SHA256", Buffer.from(`${header}.${body}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("follows continuation keys and sends the bearer token", async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo) => {
      const key = new URL(String(url)).searchParams.get("continuation_key");
      return Response.json(key ? { transactions: [tx({ entry_reference: "E2" })], continuation_key: null } : { transactions: [tx()], continuation_key: "next" });
    });
    const client = new EnableBankingClient(config, fetcher as unknown as typeof fetch);
    expect((await client.transactions("uid-1", "2026-11-01", "2026-11-10")).map((entry) => entry.entry_reference)).toEqual(["E1", "E2"]);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/accounts/uid-1/transactions");
    expect(url.searchParams.get("date_from")).toBe("2026-11-01");
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("turns API errors into EnableBankingError", async () => {
    const client = new EnableBankingClient(config, (async () => Response.json({ message: "Session expired", error: "EXPIRED_SESSION" }, { status: 422 })) as unknown as typeof fetch);
    await expect(client.session("s")).rejects.toEqual(new EnableBankingError(422, "Session expired", "EXPIRED_SESSION"));
  });

  it("maps transactions to signed turnovers", () => {
    expect(toTurnover(tx())).toEqual({
      booking_date: "2026-11-05", amount: -23.45, currency_id: "EUR", purpose: ["Einkauf", "Karte 1234"],
      counter_holder: "SPAR Klagenfurt", counter_iban: "AT021100000012345678", prebooked: false, canceled: false, transaction_id: "E1",
    });
    expect(toTurnover(tx({ credit_debit_indicator: "CRDT", debtor: { name: "Arbeitgeber" }, debtor_account: { iban: "AT99" } })))
      .toMatchObject({ amount: 23.45, counter_holder: "Arbeitgeber", counter_iban: "AT99" });
    expect(toTurnover(tx({ status: "PDNG", booking_date: null, value_date: "2026-11-06" }))).toMatchObject({ prebooked: true, booking_date: "2026-11-06" });
  });

  it("prefers the booked balance and reports the available amount", () => {
    expect(pickBalances([
      { balance_amount: { currency: "EUR", amount: "100.50" }, balance_type: "ITAV" },
      { balance_amount: { currency: "EUR", amount: "120.00" }, balance_type: "CLBD", reference_date: "2026-11-09" },
    ])).toEqual({ balance: 120, available: 100.5, date: "2026-11-09" });
    expect(pickBalances([])).toEqual({ balance: null, available: null, date: null });
  });
});

describe("enable banking sync service", () => {
  let directory: string;
  let accounts: AccountDatabase;
  let userId: string;
  const user = () => ({ id: userId, username: "alice" });
  const now = Date.parse("2026-11-10T08:00:00Z");
  beforeEach(async () => {
    directory = createTestDirectory();
    accounts = new AccountDatabase(join(directory, "bank.sqlite"));
    userId = (await accounts.register("alice", "test-only-password-123")).user.id;
    vi.stubEnv("ENABLEBANKING_APP_ID", APP_ID);
    vi.stubEnv("ENABLEBANKING_PRIVATE_KEY", pem);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    accounts.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function fakeApi() {
    return {
      redirectUrl: null,
      aspsps: vi.fn(async () => [{ name: "Raiffeisen", country: "AT", maximum_consent_validity: 7_776_000 }]),
      startAuthorization: vi.fn(async () => ({ url: "https://tilisy.enablebanking.com/welcome?x=1", authorization_id: "a1" })),
      createSession: vi.fn(async () => ({
        session_id: "sess-1",
        aspsp: { name: "Raiffeisen", country: "AT" },
        access: { valid_until: "2027-02-08T08:00:00+00:00" },
        accounts: [{ uid: "uid-1", account_id: { iban: "AT611904300234573201" }, name: "Girokonto", account_servicer: { bic_fi: "RZKTAT2K", name: "Raiffeisenbank Kärnten" } }],
      })),
      session: vi.fn(async () => ({ status: "AUTHORIZED", accounts: ["uid-1"], access: { valid_until: "2027-02-08T08:00:00+00:00" } })),
      deleteSession: vi.fn(async () => null),
      transactions: vi.fn(async () => [tx(), tx({ entry_reference: "E2", status: "PDNG" })]),
      balances: vi.fn(async () => [{ balance_amount: { currency: "EUR", amount: "1234.56" }, balance_type: "CLBD", reference_date: "2026-11-10" }]),
    } as unknown as EnableBankingClient;
  }

  async function connect(api: EnableBankingClient) {
    const started = await startBankConnection(accounts, user(), { country: "AT", aspsp: "Raiffeisen", origin: "http://127.0.0.1:3000" }, { enableBanking: api, now });
    expect(started).toEqual({ redirectUrl: "https://tilisy.enablebanking.com/welcome?x=1" });
    const request = vi.mocked(api.startAuthorization).mock.calls.at(-1)![0];
    return request;
  }

  it("prefers Enable Banking and runs the full redirect, session and sync flow", async () => {
    expect(configuredBankProvider()).toBe("enablebanking");
    expect((await bankStatus(accounts, userId)).provider).toBe("enablebanking");
    const api = fakeApi();
    const request = await connect(api);
    expect(request).toMatchObject({ aspsp: { name: "Raiffeisen", country: "AT" }, redirectUrl: "http://127.0.0.1:3000/api/bank/callback" });
    expect(request.validUntil.getTime()).toBeLessThanOrEqual(now + 7_776_000_000);
    await expect(completeBankAuthorization(accounts, userId, { state: "wrong-state-0000000", code: "c" }, { enableBanking: api, now }))
      .rejects.toThrow(/abgelaufen oder ungültig/);
    await expect(completeBankAuthorization(accounts, userId, { state: request.state, code: "c" }, { enableBanking: api, now: now + 31 * 60_000 }))
      .rejects.toThrow(/abgelaufen/);
    const status = await completeBankAuthorization(accounts, userId, { state: request.state, code: "code-1" }, { enableBanking: api, now });
    expect(status.connections).toEqual([expect.objectContaining({ id: "sess-1", bankName: "Raiffeisen", country: "AT", consentValidUntil: "2027-02-08T08:00:00+00:00" })]);
    await expect(completeBankAuthorization(accounts, userId, { state: request.state, code: "code-1" }, { enableBanking: api, now }))
      .rejects.toThrow(/ungültig/);

    const result = await syncBank(accounts, user(), { enableBanking: api, now });
    expect(result).toMatchObject({ queued: true, rows: 2, lastError: null });
    expect(result.accounts[0]).toMatchObject({ id: "uid-1", bank: "Raiffeisen", pocket: RAIFFEISEN_ACCOUNT, balance: 1234.56, iban: "AT61 •••• 3201" });
    const uploads = await readdir(join(dirname(accounts.path), "statement-uploads"));
    const payload = JSON.parse(await readFile(join(dirname(accounts.path), "statement-uploads", uploads[0]), "utf8")) as BankSyncFile;
    expect(payload.provider).toBe("enablebanking");
    const parsed = parseBankSync(new TextEncoder().encode(JSON.stringify(payload)), "x.bank.json");
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
    expect(parsed.rows[0]).toMatchObject({ amount: -23.45, bank: "Raiffeisen" });
    expect(parsed.rows[0].rawDetails).toContain("Bankverbindung (Enable Banking)");
    expect(await autoSyncDue(accounts, userId, now + 7 * 3_600_000)).toBe(true);

    vi.mocked(api.session).mockResolvedValue({ status: "EXPIRED", accounts: [], access: null });
    const expired = await syncBank(accounts, user(), { enableBanking: api, now: now + 7 * 3_600_000 });
    expect(expired.lastError).toMatch(/Freigabe erneuern/);
    expect(expired.connections[0]).toMatchObject({ syncActive: false });
    expect(expired.accounts[0]).toMatchObject({ id: "uid-1", balance: 1234.56 });
    expect(await autoSyncDue(accounts, userId, now + 20 * 3_600_000)).toBe(false);
  });

  it("matches each account once to its CSV pocket and keeps the assignment", async () => {
    const api = fakeApi();
    vi.mocked(api.createSession).mockResolvedValueOnce({
      session_id: "sess-r", aspsp: { name: "Revolut", country: "AT" }, access: { valid_until: "2027-05-01T00:00:00+00:00" },
      accounts: [{ uid: "vault-1", name: "Jannis Brühl", cash_account_type: "SVGS" }, { uid: "vault-2", name: "Jannis Brühl", cash_account_type: "SVGS" }],
    });
    vi.mocked(api.transactions).mockImplementation(async (id: string) => id === "vault-1"
      ? [tx({ entry_reference: "v1a", booking_date: "2026-11-08", transaction_amount: { currency: "EUR", amount: "250.00" }, credit_debit_indicator: "CRDT" }),
        tx({ entry_reference: "v1b", booking_date: "2026-11-09", transaction_amount: { currency: "EUR", amount: "10.00" }, credit_debit_indicator: "DBIT" })]
      : []);
    const existing = [
      { bank: "Revolut", pocket: "Sparen", date: "2026-11-08", amount: 250 },
      { bank: "Revolut", pocket: "Sparen", date: "2026-11-09", amount: -10 },
    ];
    vi.spyOn(accounts, "getFinance").mockReturnValue({ state: { transactions: existing }, revision: 1 } as unknown as ReturnType<AccountDatabase["getFinance"]>);
    await completeBankAuthorization(accounts, userId, { state: (await connect(api)).state, code: "c" }, { enableBanking: api, now });
    const first = await syncBank(accounts, user(), { enableBanking: api, now });
    expect(first.accounts.find((account) => account.id === "vault-1")).toMatchObject({ bank: "Revolut", pocket: "Sparen", label: "Sparen" });
    expect(first.accounts.find((account) => account.id === "vault-2")).toMatchObject({ pocket: "Persönliches Konto" });
    const transactionCalls = vi.mocked(api.transactions).mock.calls;
    expect(transactionCalls[0][1]).toBe("2026-08-12");

    vi.mocked(accounts.getFinance).mockReturnValue({ state: { transactions: [] }, revision: 1 } as unknown as ReturnType<AccountDatabase["getFinance"]>);
    const second = await syncBank(accounts, user(), { enableBanking: api, now: now + 7 * 3_600_000 });
    expect(second.accounts.find((account) => account.id === "vault-1")).toMatchObject({ pocket: "Sparen" });
    expect(transactionCalls.at(-2)![1]).toBe("2026-11-03");
  });

  it("stores synced balances as account snapshots for the assistant and forecast", async () => {
    accounts.putFinance(userId, blankTestState(), 0);
    const api = fakeApi();
    await completeBankAuthorization(accounts, userId, { state: (await connect(api)).state, code: "c" }, { enableBanking: api, now });
    await syncBank(accounts, user(), { enableBanking: api, now });
    expect(accounts.getFinance(userId).state?.accountSnapshots).toEqual([
      { bank: "Raiffeisen", name: RAIFFEISEN_ACCOUNT, date: "2026-11-10", balance: 1234.56 }]);
    const revision = accounts.getFinance(userId).revision;
    await syncBank(accounts, user(), { enableBanking: api, now: now + 7 * 3_600_000 });
    expect(accounts.getFinance(userId).revision).toBe(revision);
  });

  it("assigns an unmatched Revolut account by a unique CSV balance and skips unassigned ones", async () => {
    accounts.putFinance(userId, { ...blankTestState(), accountSnapshots: [
      { bank: "Revolut", name: "Pro", date: "2026-11-06", balance: 4.03 },
      { bank: "Revolut", name: "Sparen", date: "2026-11-06", balance: 50 },
    ] }, 0);
    const api = fakeApi();
    vi.mocked(api.createSession).mockResolvedValueOnce({
      session_id: "sess-r", aspsp: { name: "Revolut", country: "AT" }, access: { valid_until: "2027-05-01T00:00:00+00:00" },
      accounts: [{ uid: "pro", name: "Jannis Brühl", cash_account_type: "CACC" }, { uid: "other", name: "Jannis Brühl", cash_account_type: "SVGS" }],
    });
    vi.mocked(api.transactions).mockResolvedValue([]);
    vi.mocked(api.balances).mockImplementation(async (id: string) => [{ balance_amount: { currency: "EUR", amount: id === "pro" ? "4.03" : "12.00" }, balance_type: "CLBD", reference_date: "2026-11-10" }]);
    await completeBankAuthorization(accounts, userId, { state: (await connect(api)).state, code: "c" }, { enableBanking: api, now });
    const result = await syncBank(accounts, user(), { enableBanking: api, now });
    expect(result.accounts.find((account) => account.id === "pro")).toMatchObject({ pocket: "Pro" });
    const snapshots = accounts.getFinance(userId).state?.accountSnapshots ?? [];
    expect(snapshots).toContainEqual({ bank: "Revolut", name: "Pro", date: "2026-11-10", balance: 4.03 });
    expect(snapshots.filter((item) => item.date === "2026-11-10")).toHaveLength(1);
  });

  it("renews a session by replacing it and removes connections at the bank", async () => {
    const api = fakeApi();
    await completeBankAuthorization(accounts, userId, { state: (await connect(api)).state, code: "c" }, { enableBanking: api, now });
    const renewed = await renewBankConnection(accounts, user(), "sess-1", "http://127.0.0.1:3000", { enableBanking: api, now });
    expect(renewed).toEqual({ redirectUrl: expect.stringContaining("enablebanking") });
    const state = vi.mocked(api.startAuthorization).mock.calls.at(-1)![0].state;
    vi.mocked(api.createSession).mockResolvedValueOnce({
      session_id: "sess-2", aspsp: { name: "Raiffeisen", country: "AT" }, access: { valid_until: "2027-05-01T00:00:00+00:00" },
      accounts: [{ uid: "uid-2", account_id: { iban: "AT611904300234573201" }, name: "Girokonto" }],
    });
    const status = await completeBankAuthorization(accounts, userId, { state, code: "c2" }, { enableBanking: api, now });
    expect(api.deleteSession).toHaveBeenCalledWith("sess-1");
    expect(status.connections.map((connection) => connection.id)).toEqual(["sess-2"]);
    const removed = await removeBankConnection(accounts, user(), "sess-2", { enableBanking: api });
    expect(removed.connections).toEqual([]);
    expect(api.deleteSession).toHaveBeenCalledWith("sess-2");
  });
});
