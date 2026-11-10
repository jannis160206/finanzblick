import { accountErrorResponse, jsonResponse, requireMutationOrigin } from "@/lib/server/http";
import { driveRequestContext } from "@/lib/drive/http";
import { disconnectDrive, driveStatus } from "@/lib/drive/store";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  try {
    const { database, user, oauth } = await driveRequestContext(request);
    return jsonResponse(await driveStatus(database, user.id, oauth));
  } catch (error) {
    return accountErrorResponse(error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const { config, database, user, oauth } = await driveRequestContext(request);
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`drive:${user.id}`, 10, 60_000);
    await disconnectDrive(database, user.id);
    return jsonResponse(await driveStatus(database, user.id, oauth));
  } catch (error) {
    return accountErrorResponse(error);
  }
}
