import { z } from "zod";
import { isAccountMode } from "@/lib/server/config";
import { AccountError } from "@/lib/server/errors";
import { accountErrorResponse, jsonResponse, readJsonBody, requestSessionToken, requireMutationOrigin } from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";
import { bankStatus, removeBankConnection, renewBankConnection, startBankConnection, syncBank } from "@/lib/banking/sync";

export const runtime = "nodejs";

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("connect"),
    country: z.string().regex(/^[A-Z]{2}$/).default("AT"),
    bic: z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/).optional(),
  }),
  z.object({ action: z.literal("renew"), connection: z.string().min(1).max(200) }),
  z.object({ action: z.literal("sync") }),
]);

async function authorized(request: Request) {
  if (!isAccountMode()) throw new AccountError(404, "Die Bankverbindung benötigt ein Benutzerkonto.");
  const runtime = await getAccountRuntime();
  const user = runtime.database.currentUser(requestSessionToken(request));
  if (!user) throw new AccountError(401, "Bitte anmelden.");
  if (request.headers.get("X-Finanzblick-Account") !== user.id)
    throw new AccountError(401, "Das Konto hat sich geändert. Bitte neu laden.");
  return { ...runtime, user };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { database, user } = await authorized(request);
    return jsonResponse(await bankStatus(database, user.id));
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { config, database, user } = await authorized(request);
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`bank:${user.id}`, 20, 60_000);
    const body = actionSchema.parse(await readJsonBody(request, 4096));
    if (body.action === "connect")
      return jsonResponse(await startBankConnection(database, user, { country: body.country, ...(body.bic ? { bic: body.bic } : {}) }));
    if (body.action === "renew")
      return jsonResponse(await renewBankConnection(database, user, body.connection));
    return jsonResponse(await syncBank(database, user, { refresh: true }));
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const { config, database, user } = await authorized(request);
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`bank:${user.id}`, 20, 60_000);
    const connection = z.string().min(1).max(200).parse(new URL(request.url).searchParams.get("connection"));
    return jsonResponse(await removeBankConnection(database, user, connection));
  } catch (error) {
    return accountErrorResponse(error);
  }
}
