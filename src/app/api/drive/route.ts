import { z } from "zod";
import { AccountError } from "@/lib/server/errors";
import { jsonResponse, readJsonBody, requireMutationOrigin } from "@/lib/server/http";
import { driveErrorResponse, driveRequestContext } from "@/lib/drive/http";
import { clearInbox } from "@/lib/drive/inbox";
import { chooseDriveFolder, driveOverview, recheckDrivePayslips, retryDriveFiles, syncDrive } from "@/lib/drive/sync";
import { disconnectDrive, driveFolderKinds } from "@/lib/drive/store";

export const runtime = "nodejs";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync") }),
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("recheck") }),
  z.object({ action: z.literal("folder"), kind: z.enum(driveFolderKinds), id: z.string().regex(/^[A-Za-z0-9_-]{6,200}$/) }),
]);

export async function GET(request: Request): Promise<Response> {
  try {
    const { database, user, oauth } = await driveRequestContext(request);
    return jsonResponse(await driveOverview(database, user.id, oauth));
  } catch (error) {
    return driveErrorResponse(error);
  }
}

/**
 * "sync": check the folders now; "retry": fetch skipped or failed files again; "recheck": fetch every payslip again;
 * "folder": pick one of several same-named folders. Each ends with a check.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const { config, database, user, oauth } = await driveRequestContext(request);
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`drive:${user.id}`, 10, 60_000);
    const body = actionSchema.parse(await readJsonBody(request, 512));
    if (!oauth) throw new AccountError(503, "Google Drive ist auf diesem Server nicht eingerichtet.");
    if (body.action === "retry") await retryDriveFiles(database, user.id);
    if (body.action === "recheck" && !await recheckDrivePayslips(database, user.id))
      throw new AccountError(409, "Google Drive ist nicht verbunden.");
    if (body.action === "folder") await chooseDriveFolder(database, user.id, body.kind, body.id);
    const result = await syncDrive(database, user.id, oauth);
    return jsonResponse({ result, status: await driveOverview(database, user.id, oauth) });
  } catch (error) {
    return driveErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const { config, database, user, oauth } = await driveRequestContext(request);
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`drive:${user.id}`, 10, 60_000);
    await disconnectDrive(database, user.id);
    await clearInbox(database, user.id);
    return jsonResponse(await driveOverview(database, user.id, oauth));
  } catch (error) {
    return driveErrorResponse(error);
  }
}
