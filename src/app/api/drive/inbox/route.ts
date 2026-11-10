import { accountErrorResponse, jsonResponse } from "@/lib/server/http";
import { driveRequestContext } from "@/lib/drive/http";
import { listInbox } from "@/lib/drive/inbox";
import { readDriveLink } from "@/lib/drive/store";

export const runtime = "nodejs";

/** Payslips from Google Drive that the browser still has to read, and whether the Google approval has ended. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { database, user } = await driveRequestContext(request);
    const [items, link] = await Promise.all([listInbox(database, user.id), readDriveLink(database, user.id)]);
    return jsonResponse({ items, ...(link?.expired ? { expired: true } : {}) });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
