import { isAccountMode } from "@/lib/server/config";
import { AccountError } from "@/lib/server/errors";
import { accountErrorResponse, jsonResponse, readJsonBody, requestSessionToken, requireMutationOrigin } from "@/lib/server/http";
import { appendPayslipLogFile, clearPayslipLogFile, readPayslipLogFile } from "@/lib/server/payslip-log-store";
import { getAccountRuntime } from "@/lib/server/runtime";
import { payslipLogEntrySchema } from "@/lib/payslip-log";

export const runtime = "nodejs";

async function authorized(request: Request) {
  if (!isAccountMode()) throw new AccountError(404, "Das Import-Protokoll auf dem Server benötigt ein Benutzerkonto.");
  const runtime = await getAccountRuntime();
  const user = runtime.database.currentUser(requestSessionToken(request));
  if (!user) throw new AccountError(401, "Bitte anmelden.");
  if (request.headers.get("X-Finanzblick-Account") !== user.id)
    throw new AccountError(401, "Das Konto hat sich geändert. Bitte neu laden.");
  runtime.database.consumeRateLimit(`payslip-log:${user.id}`, 60, 60_000);
  return { ...runtime, user };
}

/** Structured import results for debugging: what was read, stored, kept as reference or skipped. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { database, user } = await authorized(request);
    return jsonResponse({ entries: await readPayslipLogFile(database, user.id) });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { config, database, user } = await authorized(request);
    requireMutationOrigin(request, config);
    const entry = payslipLogEntrySchema.parse(await readJsonBody(request, 256 * 1024));
    await appendPayslipLogFile(database, user.id, entry);
    return jsonResponse({ stored: true });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const { config, database, user } = await authorized(request);
    requireMutationOrigin(request, config);
    await clearPayslipLogFile(database, user.id);
    return jsonResponse({ entries: [] });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
