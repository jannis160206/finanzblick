import { isAccountMode } from "@/lib/server/config";
import { requestSessionToken } from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";
import { driveAccount } from "@/lib/drive/client";
import { appOrigin, openPendingAuthorization, readStateCookie, stateCookie } from "@/lib/drive/http";
import { DriveAuthError, driveOAuthConfig, exchangeCode } from "@/lib/drive/oauth";
import { saveDriveConnection } from "@/lib/drive/store";

export const runtime = "nodejs";

type Outcome = "verbunden" | "abgelehnt" | "abgelaufen" | "anmeldung" | "drive-fehlt" | "nicht-eingerichtet" | "fehler";

/** Google redirects here after consent; only a matching state for the signed-in account is accepted. */
export async function GET(request: Request): Promise<Response> {
  if (!isAccountMode()) return new Response("Nicht gefunden", { status: 404 });
  const { config, database } = await getAccountRuntime();
  const origin = appOrigin(request, config);
  const done = (outcome: Outcome) => {
    const location = new URL("/einstellungen", origin);
    location.searchParams.set("bereich", "verbindungen");
    location.searchParams.set("drive", outcome);
    location.hash = "google-drive";
    return new Response(null, {
      status: 303,
      headers: { Location: location.toString(), "Cache-Control": "no-store", "Set-Cookie": stateCookie("", config, true), "Referrer-Policy": "no-referrer" },
    });
  };
  try {
    const user = database.currentUser(requestSessionToken(request));
    if (!user) return done("anmeldung");
    const params = new URL(request.url).searchParams;
    const pending = await openPendingAuthorization(database.path, readStateCookie(request));
    if (!pending || pending.user !== user.id || params.get("state") !== pending.state) return done("abgelaufen");
    if (params.get("error")) return done("abgelehnt");
    const code = params.get("code");
    if (!code || code.length > 2048) return done("fehler");
    const oauth = driveOAuthConfig(origin);
    if (!oauth) return done("nicht-eingerichtet");
    const tokens = await exchangeCode({ ...oauth, redirectUri: pending.redirectUri }, code, pending.verifier);
    const account = await driveAccount(tokens.accessToken).catch(() => ({}));
    await saveDriveConnection(database, user.id, tokens, account);
    return done("verbunden");
  } catch (error) {
    if (error instanceof DriveAuthError && error.kind === "denied") return done("drive-fehlt");
    console.error("Google Drive connection failed:", error instanceof DriveAuthError ? error.message : "unexpected error");
    return done("fehler");
  }
}
