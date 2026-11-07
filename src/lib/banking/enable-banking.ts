import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";

// Client for the Enable Banking API (PSD2 account information). Own accounts can be used
// free of charge in "restricted mode" – see https://enablebanking.com/docs/api/linked-accounts/
// Reference: https://enablebanking.com/docs/api/reference/

export const ENABLE_BANKING_URL = "https://api.enablebanking.com";
const REQUEST_TIMEOUT_MS = 30_000;
const JWT_TTL_SECONDS = 3600;

export class EnableBankingError extends Error {
  constructor(readonly status: number, message: string, readonly code: string | null = null) {
    super(message);
    this.name = "EnableBankingError";
  }
}

export type EnableBankingConfig = { applicationId: string; privateKey: KeyObject; baseUrl: string; redirectUrl: string | null };

/**
 * Reads ENABLEBANKING_APP_ID plus the RSA private key (ENABLEBANKING_PRIVATE_KEY_PATH or
 * ENABLEBANKING_PRIVATE_KEY as PEM). Returns null when the provider is not configured.
 */
export function readEnableBankingConfig(env: Record<string, string | undefined> = process.env): EnableBankingConfig | null {
  const applicationId = env.ENABLEBANKING_APP_ID?.trim();
  const keyPath = env.ENABLEBANKING_PRIVATE_KEY_PATH?.trim();
  const inlineKey = env.ENABLEBANKING_PRIVATE_KEY?.trim();
  if (!applicationId || (!keyPath && !inlineKey)) return null;
  if (!/^[A-Za-z0-9-]{8,100}$/.test(applicationId)) throw new Error("ENABLEBANKING_APP_ID ist ungültig.");
  const pem = inlineKey ? inlineKey.replace(/\\n/g, "\n") : readFileSync(keyPath!, "utf8");
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "rsa") throw new Error("Der Enable-Banking-Schlüssel muss ein RSA-Schlüssel sein.");
  const baseUrl = (env.ENABLEBANKING_API_URL?.trim() || ENABLE_BANKING_URL).replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl)) throw new Error("ENABLEBANKING_API_URL muss mit https:// beginnen.");
  const redirectUrl = env.ENABLEBANKING_REDIRECT_URL?.trim() || null;
  if (redirectUrl && !/^https?:\/\/[^\s]+$/.test(redirectUrl)) throw new Error("ENABLEBANKING_REDIRECT_URL ist ungültig.");
  return { applicationId, privateKey, baseUrl, redirectUrl };
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export function enableBankingJwt(config: Pick<EnableBankingConfig, "applicationId" | "privateKey">, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: config.applicationId }));
  const body = base64url(JSON.stringify({ iss: "enablebanking.com", aud: "api.enablebanking.com", iat, exp: iat + JWT_TTL_SECONDS }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), config.privateKey);
  return `${header}.${body}.${base64url(signature)}`;
}

const amountSchema = z.object({ currency: z.string(), amount: z.string() }).passthrough();
const accountIdSchema = z.object({ iban: z.string().nullish(), other: z.unknown().nullish() }).passthrough();
const partySchema = z.object({ name: z.string().nullish() }).passthrough();
export const ebAspspSchema = z.object({
  name: z.string().min(1),
  country: z.string().length(2),
  logo: z.string().nullish(),
  bic: z.string().nullish(),
  maximum_consent_validity: z.number().nullish(),
  beta: z.boolean().nullish(),
  psu_types: z.array(z.string()).nullish(),
}).passthrough();
export const ebAccountSchema = z.object({
  uid: z.string().nullish(),
  account_id: accountIdSchema.nullish(),
  account_servicer: z.object({ bic_fi: z.string().nullish(), name: z.string().nullish() }).passthrough().nullish(),
  name: z.string().nullish(),
  details: z.string().nullish(),
  product: z.string().nullish(),
  cash_account_type: z.string().nullish(),
  currency: z.string().nullish(),
  identification_hash: z.string().nullish(),
}).passthrough();
const accessSchema = z.object({ valid_until: z.string().nullish() }).passthrough();
const sessionSchema = z.object({
  session_id: z.string().min(1),
  accounts: z.array(ebAccountSchema),
  aspsp: z.object({ name: z.string(), country: z.string() }).passthrough(),
  access: accessSchema.nullish(),
}).passthrough();
const sessionStatusSchema = z.object({
  status: z.string(),
  accounts: z.array(z.string()).nullish(),
  access: accessSchema.nullish(),
}).passthrough();
export const ebTransactionSchema = z.object({
  entry_reference: z.string().nullish(),
  transaction_amount: amountSchema,
  credit_debit_indicator: z.enum(["CRDT", "DBIT"]),
  status: z.string(),
  booking_date: z.string().nullish(),
  value_date: z.string().nullish(),
  transaction_date: z.string().nullish(),
  creditor: partySchema.nullish(),
  creditor_account: accountIdSchema.nullish(),
  debtor: partySchema.nullish(),
  debtor_account: accountIdSchema.nullish(),
  remittance_information: z.array(z.string()).nullish(),
  reference_number: z.string().nullish(),
  note: z.string().nullish(),
}).passthrough();
const balanceSchema = z.object({
  name: z.string().nullish(),
  balance_amount: amountSchema,
  balance_type: z.string(),
  reference_date: z.string().nullish(),
  last_change_date_time: z.string().nullish(),
}).passthrough();

export type EbAspsp = z.infer<typeof ebAspspSchema>;
export type EbAccount = z.infer<typeof ebAccountSchema>;
export type EbSession = z.infer<typeof sessionSchema>;
export type EbTransaction = z.infer<typeof ebTransactionSchema>;
export type EbBalance = z.infer<typeof balanceSchema>;
type Fetch = typeof fetch;

export class EnableBankingClient {
  constructor(
    private readonly config: EnableBankingConfig,
    private readonly fetcher: Fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {}

  get redirectUrl(): string | null {
    return this.config.redirectUrl;
  }

  private async request<T extends z.ZodTypeAny>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    schema: T,
    options: { body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<z.infer<T>> {
    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Bearer ${enableBankingJwt(this.config, this.clock())}`,
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new EnableBankingError(502, "Enable Banking ist nicht erreichbar.");
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const message = typeof record.message === "string" ? record.message : `HTTP ${response.status}`;
      const detail = typeof record.detail === "string" ? ` (${record.detail})` : "";
      throw new EnableBankingError(response.status, `${message}${detail}`.slice(0, 300), typeof record.error === "string" ? record.error : null);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new EnableBankingError(502, "Enable Banking hat eine unerwartete Antwort geliefert.");
    return parsed.data;
  }

  async aspsps(country: string): Promise<EbAspsp[]> {
    const result = await this.request("GET", "/aspsps", z.object({ aspsps: z.array(ebAspspSchema) }).passthrough(),
      { query: { country, service: "AIS" } });
    return result.aspsps;
  }

  startAuthorization(request: { aspsp: { name: string; country: string }; validUntil: Date; state: string; redirectUrl: string; language?: string }) {
    return this.request("POST", "/auth", z.object({ url: z.string().url(), authorization_id: z.string().nullish() }).passthrough(), {
      body: {
        access: { valid_until: request.validUntil.toISOString(), balances: true, transactions: true },
        aspsp: request.aspsp,
        state: request.state,
        redirect_url: request.redirectUrl,
        psu_type: "personal",
        language: request.language ?? "de",
      },
    });
  }

  createSession(code: string): Promise<EbSession> {
    return this.request("POST", "/sessions", sessionSchema, { body: { code } });
  }

  session(sessionId: string) {
    return this.request("GET", `/sessions/${encodeURIComponent(sessionId)}`, sessionStatusSchema);
  }

  deleteSession(sessionId: string) {
    return this.request("DELETE", `/sessions/${encodeURIComponent(sessionId)}`, z.unknown());
  }

  async transactions(accountId: string, from: string, to: string): Promise<EbTransaction[]> {
    const items: EbTransaction[] = [];
    let continuation: string | undefined;
    for (let page = 0; page < 50; page++) {
      const result = await this.request("GET", `/accounts/${encodeURIComponent(accountId)}/transactions`,
        z.object({ transactions: z.array(ebTransactionSchema), continuation_key: z.string().nullish() }).passthrough(),
        { query: { date_from: from, date_to: to, continuation_key: continuation } });
      items.push(...result.transactions);
      continuation = result.continuation_key ?? undefined;
      if (!continuation) break;
    }
    return items;
  }

  async balances(accountId: string): Promise<EbBalance[]> {
    const result = await this.request("GET", `/accounts/${encodeURIComponent(accountId)}/balances`, z.object({ balances: z.array(balanceSchema) }).passthrough());
    return result.balances;
  }
}

const BALANCE_PREFERENCE = ["CLBD", "ITBD", "XPCD", "ITAV", "CLAV", "OPBD", "PRCD", "OTHR"];

/** Picks the booked balance (or the closest available type) and the available amount. */
export function pickBalances(balances: EbBalance[]): { balance: number | null; available: number | null; date: string | null } {
  const euro = balances.filter((entry) => entry.balance_amount.currency === "EUR");
  const rank = (type: string) => { const index = BALANCE_PREFERENCE.indexOf(type); return index < 0 ? 99 : index; };
  const booked = [...euro].sort((a, b) => rank(a.balance_type) - rank(b.balance_type))[0];
  const available = euro.find((entry) => entry.balance_type === "ITAV" || entry.balance_type === "CLAV" || entry.balance_type === "XPCD");
  const value = (entry: EbBalance | undefined) => {
    const amount = entry ? Number(entry.balance_amount.amount) : NaN;
    return Number.isFinite(amount) ? amount : null;
  };
  return { balance: value(booked), available: value(available), date: booked?.reference_date ?? booked?.last_change_date_time?.slice(0, 10) ?? null };
}

/** Converts an Enable Banking transaction into the provider-neutral turnover format of the bank-sync file. */
export function toTurnover(transaction: EbTransaction) {
  const raw = Number(transaction.transaction_amount.amount);
  const magnitude = Number.isFinite(raw) ? Math.abs(raw) : 0;
  const outgoing = transaction.credit_debit_indicator === "DBIT";
  const counterparty = outgoing ? transaction.creditor : transaction.debtor;
  const counterAccount = outgoing ? transaction.creditor_account : transaction.debtor_account;
  const date = transaction.booking_date ?? transaction.value_date ?? transaction.transaction_date ?? "";
  const purpose = [...(transaction.remittance_information ?? []), ...(transaction.reference_number ? [transaction.reference_number] : [])];
  return {
    booking_date: date,
    amount: outgoing ? -magnitude : magnitude,
    currency_id: transaction.transaction_amount.currency,
    purpose,
    counter_holder: counterparty?.name ?? null,
    counter_iban: counterAccount?.iban ?? null,
    prebooked: transaction.status !== "BOOK",
    canceled: transaction.status === "CNCL" || transaction.status === "RJCT",
    transaction_id: transaction.entry_reference ?? null,
  };
}
