import { AutomationStore } from "@/lib/automation/store";
import {
  accountMerchantNamePresentations,
  accountMerchantPresentations,
} from "@/lib/automation/merchant-logo-presentations";
import { merchantMarksRequestSchema } from "@/lib/automation/merchant-presentation-schema";
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
    const input = merchantMarksRequestSchema.parse(
      await readJsonBody(request, 16 * 1024),
    );
    const { database } = await getAccountRuntime();
    const user = database.currentUser(requestSessionToken(request));
    if (!user) return jsonResponse({ error: "Bitte anmelden." }, 401);
    const store = new AutomationStore(database);
    return jsonResponse({
      marks: await accountMerchantPresentations(store, input, user.id),
      ...(input.merchantNames?.length
        ? {
            nameMarks: await accountMerchantNamePresentations(
              store,
              input.merchantNames,
              user.id,
            ),
          }
        : {}),
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
