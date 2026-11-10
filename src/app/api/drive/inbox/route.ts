import { accountErrorResponse, jsonResponse } from "@/lib/server/http";
import { driveRequestContext } from "@/lib/drive/http";
import { listInbox } from "@/lib/drive/inbox";

export const runtime = "nodejs";

/** Payslips from Google Drive that the browser still has to read. */
export async function GET(request: Request): Promise<Response> {
  try {
    const { database, user } = await driveRequestContext(request);
    return jsonResponse({ items: await listInbox(database, user.id) });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
