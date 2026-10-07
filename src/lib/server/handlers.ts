import {
  accountCredentialsSchema,
  accountLoginCredentialsSchema,
  financeUpdateSchema,
} from "@/lib/account-schema";
import { isAccountMode } from "./config";
import { MAX_FINANCE_BYTES } from "./database";
import { AccountError } from "./errors";
import {
  accountErrorResponse,
  attachSessionCookie,
  clientAddress,
  jsonResponse,
  readJsonBody,
  requestSessionToken,
  requireMutationOrigin,
} from "./http";
import { getAccountRuntime } from "./runtime";

function requireMode(): void {
  if (!isAccountMode())
    throw new AccountError(404, "Im lokalen Modus sind Konten deaktiviert.");
}

export async function credentialsHandler(
  request: Request,
  action: "login" | "register",
): Promise<Response> {
  try {
    requireMode();
    const { config, database } = await getAccountRuntime();
    requireMutationOrigin(request, config);
    if (action === "register" && !config.registrationEnabled) {
      throw new AccountError(403, "Die Registrierung ist deaktiviert.");
    }
    const scope = `${config.origin ?? new URL(request.url).origin}|${clientAddress(request, config)}`;
    const window = action === "register" ? 60 * 60_000 : 15 * 60_000;
    database.consumeRateLimit(
      `${action}:address:${scope}`,
      action === "register" ? 5 : 30,
      window,
    );
    const schema = action === "register" ? accountCredentialsSchema : accountLoginCredentialsSchema;
    const credentials = schema.parse(
      await readJsonBody(request, 2048),
    );
    database.consumeRateLimit(
      `${action}:username:${credentials.username}`,
      action === "register" ? 3 : 10,
      window,
    );
    if (action === "register")
      database.consumeRateLimit("register:global", 50, 60 * 60_000);
    const oldToken = requestSessionToken(request);
    const session =
      action === "register"
        ? await database.register(
            credentials.username,
            credentials.password,
            oldToken,
          )
        : await database.login(
            credentials.username,
            credentials.password,
            oldToken,
          );
    return attachSessionCookie(
      jsonResponse({ user: session.user }, action === "register" ? 201 : 200),
      config,
      session,
    );
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function sessionHandler(request: Request): Promise<Response> {
  try {
    requireMode();
    const { database } = await getAccountRuntime();
    const user = database.currentUser(requestSessionToken(request));
    return user
      ? jsonResponse({ user })
      : jsonResponse({ error: "Bitte anmelden." }, 401);
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function logoutHandler(request: Request): Promise<Response> {
  try {
    requireMode();
    const { config, database } = await getAccountRuntime();
    requireMutationOrigin(request, config);
    database.logout(requestSessionToken(request));
    return attachSessionCookie(jsonResponse({ ok: true }), config, null);
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function financeHandler(request: Request): Promise<Response> {
  try {
    requireMode();
    const { config, database } = await getAccountRuntime();
    const user = database.currentUser(requestSessionToken(request));
    if (!user) return jsonResponse({ error: "Bitte anmelden." }, 401);
    if (request.headers.get("X-Finanzblick-Account") !== user.id) {
      return jsonResponse(
        {
          error:
            "Das angemeldete Konto hat sich geändert. Bitte die Seite neu laden.",
        },
        401,
      );
    }
    if (request.method === "GET")
      return jsonResponse(database.getFinance(user.id));
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`finance:write:${user.id}`, 60, 60_000);
    const update = financeUpdateSchema.parse(
      await readJsonBody(request, MAX_FINANCE_BYTES),
    );
    if (database.currentUser(requestSessionToken(request))?.id !== user.id) {
      return jsonResponse({ error: "Bitte erneut anmelden." }, 401);
    }
    return jsonResponse(
      database.putFinance(user.id, update.state, update.revision),
    );
  } catch (error) {
    return accountErrorResponse(error);
  }
}
