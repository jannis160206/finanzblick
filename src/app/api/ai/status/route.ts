import { aiStatus, aiUsage } from "@/lib/ai/client";
import { authorizeApi } from "@/lib/server/auth";
import { jsonResponse } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeApi(request);
  if (denied) return denied;
  // The token counters since the server started; the admin view estimates the cloud costs from them.
  return jsonResponse({ ...await aiStatus(), usage: aiUsage() });
}
