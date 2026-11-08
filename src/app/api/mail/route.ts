import { z } from "zod";
import { isAccountMode } from "@/lib/server/config";
import { AccountError } from "@/lib/server/errors";
import { accountErrorResponse, jsonResponse, readJsonBody, requestSessionToken, requireMutationOrigin } from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";
import { connectMail, disconnectMail, mailStatus, syncMail } from "@/lib/mail/sync";

export const runtime = "nodejs";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("connect"), email: z.string().trim().email().max(200), password: z.string().min(8).max(200) }),
  z.object({ action: z.literal("sync") }),
]);

async function authorized(request: Request) {
  if (!isAccountMode()) throw new AccountError(404, "Die E-Mail-Anbindung benötigt ein Benutzerkonto.");
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
    return jsonResponse(await mailStatus(database, user.id));
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { config, database, user } = await authorized(request);
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`mail:${user.id}`, 10, 60_000);
    const body = actionSchema.parse(await readJsonBody(request, 4096));
    if (body.action === "connect") return jsonResponse(await connectMail(database, user.id, body.email, body.password));
    return jsonResponse(await syncMail(database, user.id));
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const { config, database, user } = await authorized(request);
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`mail:${user.id}`, 10, 60_000);
    return jsonResponse(await disconnectMail(database, user.id));
  } catch (error) {
    return accountErrorResponse(error);
  }
}
