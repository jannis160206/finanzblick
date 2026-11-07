import { z } from "zod";
import { isAccountMode } from "@/lib/server/config";
import { isAccountError } from "@/lib/server/errors";
import { requestSessionToken } from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";
import { cancelBankAuthorization, completeBankAuthorization } from "@/lib/banking/sync";

export const runtime = "nodejs";

const paramSchema = z.object({
  state: z.string().min(16).max(200),
  code: z.string().min(1).max(4000).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(500).optional(),
});

function back(origin: string, result: "connected" | "error", message?: string): Response {
  const url = new URL("/einstellungen", origin);
  url.searchParams.set("bank", result);
  if (message) url.searchParams.set("message", message.slice(0, 200));
  url.hash = "bankverbindung";
  return new Response(null, { status: 303, headers: { Location: url.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

/** Return point after the bank authorisation at Enable Banking (?code&state or ?error&state). */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  let origin = url.origin;
  try {
    if (!isAccountMode()) return back(origin, "error", "Die Bankverbindung benötigt ein Benutzerkonto.");
    const runtime = await getAccountRuntime();
    origin = runtime.config.origin ?? origin;
    const user = runtime.database.currentUser(requestSessionToken(request));
    if (!user) return back(origin, "error", "Bitte zuerst anmelden und die Bank erneut verbinden.");
    const params = paramSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!params.success) return back(origin, "error", "Ungültige Antwort der Bank.");
    runtime.database.consumeRateLimit(`bank:${user.id}`, 20, 60_000);
    if (params.data.error || !params.data.code) {
      const message = params.data.error === "access_denied"
        ? "Die Freigabe wurde abgebrochen."
        : `Die Bank meldet: ${params.data.error_description || params.data.error || "kein Code"}`;
      await cancelBankAuthorization(runtime.database, user.id, params.data.state, message);
      return back(origin, "error", message);
    }
    await completeBankAuthorization(runtime.database, user.id, { state: params.data.state, code: params.data.code });
    return back(origin, "connected");
  } catch (error) {
    return back(origin, "error", isAccountError(error) ? error.message : "Die Bankverbindung konnte nicht abgeschlossen werden.");
  }
}
