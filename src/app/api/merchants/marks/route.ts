import { AutomationStore } from "@/lib/automation/store";
import {
  accountMerchantNamePresentations,
  accountMerchantPresentations,
} from "@/lib/automation/merchant-logo-presentations";
import {
  MAX_MERCHANT_MARKS_BYTES,
  merchantMarksRequestSchema,
} from "@/lib/automation/merchant-presentation-schema";
import { accountMerchantBookingPresentations } from "@/lib/automation/merchant-booking-presentations";
import { MerchantLogoRequest } from "@/lib/automation/merchant-logo-request";
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
      await readJsonBody(request, MAX_MERCHANT_MARKS_BYTES),
    );
    const { database } = await getAccountRuntime();
    const user = database.currentUser(requestSessionToken(request));
    if (!user) return jsonResponse({ error: "Bitte anmelden." }, 401);
    const store = new AutomationStore(database);
    const logos = new MerchantLogoRequest(store, user.id);
    const [marks, nameMarks, bookingMarks] = await Promise.all([
      accountMerchantPresentations(store, input, user.id, logos),
      input.merchantNames?.length
        ? accountMerchantNamePresentations(
            store,
            input.merchantNames,
            user.id,
            logos,
          )
        : undefined,
      input.bookingIds?.length
        ? accountMerchantBookingPresentations(
            store,
            input.bookingIds,
            user.id,
            logos,
          )
        : undefined,
    ]);
    return jsonResponse({
      marks,
      ...(nameMarks ? { nameMarks } : {}),
      ...(bookingMarks ? { bookingMarks } : {}),
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
