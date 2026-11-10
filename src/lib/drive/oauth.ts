import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const CALLBACK_PATH = "/api/auth/callback/google";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const TIMEOUT_MS = 15_000;

export type Fetcher = typeof fetch;
export type DriveOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string };

/** Google OAuth settings only from the environment; the redirect URI must match the one in the Google Cloud Console. */
export function driveOAuthConfig(origin: string, env: Record<string, string | undefined> = process.env): DriveOAuthConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: env.GOOGLE_REDIRECT_URI?.trim() || `${origin}${CALLBACK_PATH}` };
}

export class DriveAuthError extends Error {
  /** "expired": the refresh token is no longer valid and the user has to connect again. */
  constructor(message: string, readonly kind: "expired" | "denied" | "failed" = "failed") {
    super(message);
  }
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

export function createAuthorization(config: DriveOAuthConfig) {
  const state = base64url(randomBytes(32));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), state, verifier };
}

const tokenSchema = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().positive().max(86_400),
  refresh_token: z.string().min(1).max(4096).optional(),
  scope: z.string().max(4096).optional(),
  token_type: z.string().max(40).optional(),
});

export type DriveTokens = { accessToken: string; accessExpiresAt: number; refreshToken: string };

async function tokenRequest(fetcher: Fetcher, body: Record<string, string>) {
  let response: Response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new DriveAuthError("Google ist gerade nicht erreichbar. Bitte später erneut versuchen.");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : "";
    if (code === "invalid_grant") throw new DriveAuthError("Die Google-Drive-Freigabe ist abgelaufen. Bitte erneut verbinden.", "expired");
    throw new DriveAuthError("Google hat die Anmeldung abgelehnt. Bitte erneut verbinden.");
  }
  const parsed = tokenSchema.safeParse(payload);
  if (!parsed.success) throw new DriveAuthError("Unerwartete Antwort von Google.");
  return parsed.data;
}

export async function exchangeCode(config: DriveOAuthConfig, code: string, verifier: string, fetcher: Fetcher = fetch, now = Date.now()): Promise<DriveTokens> {
  const token = await tokenRequest(fetcher, {
    code, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectUri,
    grant_type: "authorization_code", code_verifier: verifier,
  });
  if (!token.scope?.split(" ").includes(DRIVE_SCOPE))
    throw new DriveAuthError("Der Lesezugriff auf Google Drive wurde nicht erlaubt. Bitte beim Verbinden das Häkchen für Drive setzen.", "denied");
  if (!token.refresh_token)
    throw new DriveAuthError("Google hat keinen dauerhaften Zugriff erteilt. Bitte die Verbindung trennen und erneut verbinden.");
  return { accessToken: token.access_token, accessExpiresAt: now + token.expires_in * 1000, refreshToken: token.refresh_token };
}

export async function refreshAccessToken(config: DriveOAuthConfig, refreshToken: string, fetcher: Fetcher = fetch, now = Date.now()) {
  const token = await tokenRequest(fetcher, {
    refresh_token: refreshToken, client_id: config.clientId, client_secret: config.clientSecret, grant_type: "refresh_token",
  });
  return { accessToken: token.access_token, accessExpiresAt: now + token.expires_in * 1000 };
}

/** Best effort: the connection is removed locally even when Google cannot be reached. */
export async function revokeToken(token: string, fetcher: Fetcher = fetch): Promise<boolean> {
  try {
    const response = await fetcher(REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
