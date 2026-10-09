import { AutomationStore } from "@/lib/automation/store";
import { merchantPresentations } from "@/lib/automation/merchant-presentation";
import { authorizeApi, isAccountMode } from "@/lib/server/auth";
import {
  accountErrorResponse,
  jsonResponse,
  readJsonBody,
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
    return jsonResponse({
      marks: await merchantPresentations(new AutomationStore(database), input),
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
