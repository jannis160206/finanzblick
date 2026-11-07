import { z } from "zod";

// Minimal client for the Tink Germany (FinTecSystems) XS2A.api open-banking platform.
// Docs: https://guide.xs2a.com/xs2a/integration-cs/platforms/api – SDK: github.com/FinTecSystems/xs2a-nodejs

export const XS2A_DEFAULT_URL = "https://api.xs2a.com";
const REQUEST_TIMEOUT_MS = 30_000;

export class Xs2aError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "Xs2aError";
  }
}

export type Xs2aConfig = { apiKey: string; baseUrl: string };

export function readXs2aConfig(env: Record<string, string | undefined> = process.env): Xs2aConfig | null {
  const apiKey = env.XS2A_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (env.XS2A_API_URL?.trim() || XS2A_DEFAULT_URL).replace(/\/+$/, "");
  if (!/^https:\/\//.test(baseUrl)) throw new Error("XS2A_API_URL muss mit https:// beginnen.");
  return { apiKey, baseUrl };
}

const bankUserSchema = z.object({ id: z.string().min(1), testmode: z.boolean().optional() }).passthrough();
const accessTokenSchema = z.object({ id: z.string().min(1), token: z.string().min(1), valid_until: z.string().optional() }).passthrough();
const sessionSchema = z.object({ wizard_session_key: z.string().min(1), transaction: z.string().min(1) }).passthrough();
export const xs2aConnectionSchema = z.object({
  id: z.string().min(1),
  transaction: z.string().nullish(),
  bank_name: z.string().nullish(),
  bic: z.string().nullish(),
  country_id: z.string().nullish(),
  sync_mode: z.string().nullish(),
  sync_active: z.boolean().nullish(),
  sync_message: z.string().nullish(),
  sync_fail_counter: z.number().nullish(),
  last_synced: z.string().nullish(),
  consent_valid_until: z.string().nullish(),
  testmode: z.boolean().nullish(),
}).passthrough();
export const xs2aAccountSchema = z.object({
  id: z.string().min(1),
  bank_connection_id: z.string().nullish(),
  holder: z.string().nullish(),
  iban: z.string().nullish(),
  description: z.string().nullish(),
  bic: z.string().nullish(),
  bank_name: z.string().nullish(),
  country_id: z.string().nullish(),
  type: z.string().nullish(),
}).passthrough();
export const xs2aTurnoverSchema = z.object({
  booking_date: z.string().min(10),
  amount: z.number().finite(),
  currency_id: z.string().nullish(),
  currency: z.string().nullish(),
  purpose: z.array(z.string()).or(z.string()).nullish(),
  counter_iban: z.string().nullish(),
  counter_bic: z.string().nullish(),
  counter_holder: z.string().nullish(),
  prebooked: z.boolean().nullish(),
  canceled: z.boolean().nullish(),
  creditor_id: z.string().nullish(),
  category_id: z.string().nullish(),
}).passthrough();
const balanceSchema = z.object({
  available: z.number().nullish(),
  balance: z.number().nullish(),
  currency_id: z.string().nullish(),
  date: z.string().nullish(),
}).passthrough();
const page = <T extends z.ZodTypeAny>(item: T) => z.object({
  data: z.array(item),
  current_page: z.number().optional(),
  last_page: z.number().optional(),
}).passthrough();

export type Xs2aConnection = z.infer<typeof xs2aConnectionSchema>;
export type Xs2aAccount = z.infer<typeof xs2aAccountSchema>;
export type Xs2aTurnover = z.infer<typeof xs2aTurnoverSchema>;
export type Xs2aBalance = z.infer<typeof balanceSchema>;
type Fetch = typeof fetch;

export class Xs2aClient {
  constructor(
    private readonly config: Xs2aConfig,
    private readonly fetcher: Fetch = fetch,
  ) {}

  private async request<T extends z.ZodTypeAny>(
    method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE",
    path: string,
    schema: T,
    options: { secret?: string; body?: unknown; query?: Record<string, string | number> } = {},
  ): Promise<z.infer<T>> {
    const url = new URL(path, this.config.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, String(value));
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`api:${options.secret ?? this.config.apiKey}`).toString("base64")}`,
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Xs2aError(502, "Die Bankschnittstelle (XS2A) ist nicht erreichbar.");
    }
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const message = body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message : `HTTP ${response.status}`;
      throw new Xs2aError(response.status, message.slice(0, 300));
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Xs2aError(502, "Die Bankschnittstelle hat eine unerwartete Antwort geliefert.");
    return parsed.data;
  }

  createUser(name: string, email: string) {
    return this.request("PUT", "/v1/api/users", bankUserSchema, { body: { name, email } });
  }

  createAccessToken(userId: string, validUntil: Date) {
    return this.request("PUT", `/v1/api/users/${encodeURIComponent(userId)}/accesstokens`, accessTokenSchema, {
      body: { valid_until: xs2aDateTime(validUntil) },
    });
  }

  createConnection(token: string, request: { country: string; bic?: string; days: number; language?: string }) {
    return this.request("PUT", "/v1/api/connections", sessionSchema, {
      secret: token,
      body: {
        sync_mode: "full",
        country_id: request.country,
        ...(request.bic ? { bic: request.bic } : {}),
        days: request.days,
        limit_days: request.days,
        account_selection: "all",
        language: request.language ?? "de",
      },
    });
  }

  listConnections(token: string): Promise<Xs2aConnection[]> {
    return this.paged("/v1/api/connections", xs2aConnectionSchema, token);
  }

  syncConnection(token: string, connectionId: string) {
    return this.request("POST", `/v1/api/connections/${encodeURIComponent(connectionId)}/sync`, z.unknown(), { secret: token, body: {} });
  }

  resetConnection(token: string, connectionId: string) {
    return this.request("POST", `/v1/api/connections/${encodeURIComponent(connectionId)}/reset`, sessionSchema, { secret: token, body: {} });
  }

  deleteConnection(token: string, connectionId: string) {
    return this.request("DELETE", `/v1/api/connections/${encodeURIComponent(connectionId)}`, z.unknown(), { secret: token });
  }

  listAccounts(token: string): Promise<Xs2aAccount[]> {
    return this.paged("/v1/api/accounts", xs2aAccountSchema, token);
  }

  async turnovers(token: string, accountId: string, from: string, to: string): Promise<Xs2aTurnover[]> {
    const result = await this.request("GET", `/v1/api/accounts/${encodeURIComponent(accountId)}/turnovers`,
      z.object({ turnovers: z.array(xs2aTurnoverSchema) }).passthrough(), { secret: token, query: { from, to } });
    return result.turnovers;
  }

  balance(token: string, accountId: string) {
    return this.request("GET", `/v1/api/accounts/${encodeURIComponent(accountId)}/balance`, balanceSchema, { secret: token });
  }

  private async paged<T extends z.ZodTypeAny>(path: string, item: T, token: string): Promise<z.infer<T>[]> {
    const items: z.infer<T>[] = [];
    for (let current = 1; current <= 50; current++) {
      const result = await this.request("GET", path, page(item), { secret: token, query: { page: current, per_page: 100 } });
      items.push(...result.data);
      if (!result.last_page || current >= result.last_page) break;
    }
    return items;
  }
}

export function xs2aDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
