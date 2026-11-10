import { z } from "zod";
import { isAccountMode, type AccountConfig } from "@/lib/server/config";
import { AccountError } from "@/lib/server/errors";
import { requestSessionToken } from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";
import { masterKey, openSecret, sealSecret } from "@/lib/server/secrets";
import { dirname } from "node:path";
import { CALLBACK_PATH, driveOAuthConfig } from "./oauth";

const STATE_CONTEXT = "finanzblick:google-oauth-state";
const STATE_SECONDS = 600;

export const stateCookieName = () =>
  process.env.NODE_ENV === "production" ? "__Secure-finanzblick_google_oauth" : "finanzblick_google_oauth";

export const appOrigin = (request: Request, config: Pick<AccountConfig, "origin">) => config.origin ?? new URL(request.url).origin;

export async function driveRequestContext(request: Request) {
  if (!isAccountMode()) throw new AccountError(404, "Google Drive benötigt ein Benutzerkonto.");
  const runtime = await getAccountRuntime();
  const user = runtime.database.currentUser(requestSessionToken(request));
  if (!user) throw new AccountError(401, "Bitte anmelden.");
  if (request.headers.get("X-Finanzblick-Account") !== user.id)
    throw new AccountError(401, "Das Konto hat sich geändert. Bitte neu laden.");
  const oauth = driveOAuthConfig(appOrigin(request, runtime.config));
  return { ...runtime, user, oauth };
}

const pendingSchema = z.object({
  state: z.string().min(20).max(200),
  verifier: z.string().min(43).max(128),
  user: z.string().min(1).max(100),
  redirectUri: z.string().url().max(500),
  expires: z.number().int(),
});
export type PendingAuthorization = z.infer<typeof pendingSchema>;

export async function sealPendingAuthorization(databasePath: string, pending: PendingAuthorization) {
  return sealSecret(JSON.stringify(pending), await masterKey(dirname(databasePath)), STATE_CONTEXT);
}

export async function openPendingAuthorization(databasePath: string, value: string | null, now = Date.now()): Promise<PendingAuthorization | null> {
  if (!value) return null;
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(openSecret(value, await masterKey(dirname(databasePath)), STATE_CONTEXT)));
    return parsed.success && parsed.data.expires > now ? parsed.data : null;
  } catch {
    return null;
  }
}

export function stateCookie(value: string, config: Pick<AccountConfig, "secureCookies">, clear = false) {
  return [
    `${stateCookieName()}=${clear ? "" : value}`,
    `Path=${CALLBACK_PATH}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${clear ? 0 : STATE_SECONDS}`,
    ...(config.secureCookies || process.env.NODE_ENV === "production" ? ["Secure"] : []),
  ].join("; ");
}

export function readStateCookie(request: Request): string | null {
  const prefix = `${stateCookieName()}=`;
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(prefix))?.slice(prefix.length) || null;
}

export const STATE_TTL_MS = STATE_SECONDS * 1000;
