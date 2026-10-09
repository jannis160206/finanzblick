import { AutomationStore } from "@/lib/automation/store";
import { accountMerchantPresentations } from "@/lib/automation/merchant-logo-presentations";
import { authorizeApi, isAccountMode } from "@/lib/server/auth";
import {
  accountErrorResponse,
  jsonResponse,
  readJsonBody,
  requestSessionToken,
} from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const denied = await authorizeApi(request);
  if (denied) return denied;
  try {
    if (!isAccountMode()) return jsonResponse({ marks: [] });
    const input = await readJsonBody(request, 16 * 1024);
    const { database } = await getAccountRuntime();
    const user = database.currentUser(requestSessionToken(request));
    if (!user) return jsonResponse({ error: "Bitte anmelden." }, 401);
    return jsonResponse({
      marks: await accountMerchantPresentations(
        new AutomationStore(database),
        input,
        user.id,
      ),
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
