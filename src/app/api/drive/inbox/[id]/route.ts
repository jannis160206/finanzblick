import { z } from "zod";
import { AccountError } from "@/lib/server/errors";
import { accountErrorResponse, jsonResponse, readJsonBody, requireMutationOrigin } from "@/lib/server/http";
import { driveRequestContext } from "@/lib/drive/http";
import { readInboxFile, removeInboxItem } from "@/lib/drive/inbox";
import { recordInboxOutcome } from "@/lib/drive/sync";

export const runtime = "nodejs";

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{6,200}$/);
const outcomeSchema = z.object({ outcome: z.enum(["imported", "skipped", "failed"]), note: z.string().max(300).optional() });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { database, user } = await driveRequestContext(request);
    const id = idSchema.parse((await params).id);
    const file = await readInboxFile(database, user.id, id);
    if (!file) throw new AccountError(404, "Datei nicht mehr vorhanden.");
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(file.bytes.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "attachment",
      },
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

/** The browser read the file: remember the outcome and drop it from the inbox. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { config, database, user } = await driveRequestContext(request);
    requireMutationOrigin(request, config);
    const id = idSchema.parse((await params).id);
    const { outcome, note } = outcomeSchema.parse(await readJsonBody(request, 1024));
    await recordInboxOutcome(database, user.id, id, outcome, note);
    await removeInboxItem(database, user.id, id);
    return jsonResponse({ ok: true });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
