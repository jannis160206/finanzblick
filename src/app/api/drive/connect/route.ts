import { AccountError } from "@/lib/server/errors";
import { accountErrorResponse, jsonResponse, requireMutationOrigin } from "@/lib/server/http";
import { createAuthorization } from "@/lib/drive/oauth";
import { appOrigin, driveRequestContext, sealPendingAuthorization, STATE_TTL_MS, stateCookie } from "@/lib/drive/http";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const { config, database, user, oauth } = await driveRequestContext(request);
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`drive-connect:${user.id}`, 10, 60_000);
    if (!oauth) throw new AccountError(503, "Google Drive ist auf diesem Server nicht eingerichtet (GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET fehlen).");
    const authorization = createAuthorization(oauth, appOrigin(request, config));
    const sealed = await sealPendingAuthorization(database.path, {
      state: authorization.state, verifier: authorization.verifier, user: user.id,
      redirectUri: oauth.redirectUri, expires: Date.now() + STATE_TTL_MS,
    });
    const response = jsonResponse({ url: authorization.url });
    response.headers.append("Set-Cookie", stateCookie(sealed, config));
    return response;
  } catch (error) {
    return accountErrorResponse(error);
  }
}
