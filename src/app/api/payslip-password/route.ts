import { z } from "zod";
import { isAccountMode } from "@/lib/server/config";
import { AccountError } from "@/lib/server/errors";
import { accountErrorResponse, jsonResponse, readJsonBody, requestSessionToken, requireMutationOrigin } from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";
import { deleteUserSecret, readUserSecret, userSecretInfo, writeUserSecret } from "@/lib/server/user-secrets";

export const runtime = "nodejs";

const SECRET = "payslip-password";
const bodySchema = z.object({ password: z.string().min(1).max(200) });

async function authorized(request: Request) {
  if (!isAccountMode()) throw new AccountError(404, "Gespeicherte Passwörter benötigen ein Benutzerkonto.");
  const runtime = await getAccountRuntime();
  const user = runtime.database.currentUser(requestSessionToken(request));
  if (!user) throw new AccountError(401, "Bitte anmelden.");
  if (request.headers.get("X-Finanzblick-Account") !== user.id)
    throw new AccountError(401, "Das Konto hat sich geändert. Bitte neu laden.");
  runtime.database.consumeRateLimit(`payslip-password:${user.id}`, 30, 60_000);
  return { ...runtime, user };
}

export async function GET(request: Request): Promise<Response> {
  try {
    const { database, user } = await authorized(request);
    if (new URL(request.url).searchParams.get("reveal") === "1") {
      const password = await readUserSecret(database, user.id, SECRET);
      return jsonResponse(password === null ? { stored: false } : { stored: true, password });
    }
    const info = await userSecretInfo(database, user.id, SECRET);
    return jsonResponse(info ? { stored: true, updatedAt: info.updatedAt } : { stored: false });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const { config, database, user } = await authorized(request);
    requireMutationOrigin(request, config);
    const { password } = bodySchema.parse(await readJsonBody(request, 1024));
    const { updatedAt } = await writeUserSecret(database, user.id, SECRET, password);
    return jsonResponse({ stored: true, updatedAt });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const { config, database, user } = await authorized(request);
    requireMutationOrigin(request, config);
    await deleteUserSecret(database, user.id, SECRET);
    return jsonResponse({ stored: false });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
