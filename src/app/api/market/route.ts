import { authorizeApi } from "@/lib/server/auth";
import { jsonResponse } from "@/lib/server/http";
import { fetchMarketSnapshot } from "@/lib/web/mcp-client";

export const runtime = "nodejs";

// Public market data via the finanzblick-web MCP server. Only currency codes are passed on, never personal data.
export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeApi(request);
  if (denied) return denied;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return jsonResponse({ error: "Nicht erlaubt." }, 403);
  const currencies = (new URL(request.url).searchParams.get("currencies") ?? "").split(",")
    .map((code) => code.trim().toUpperCase()).filter((code) => /^[A-Z]{3}$/.test(code)).slice(0, 10);
  try {
    return jsonResponse(await fetchMarketSnapshot(currencies));
  } catch {
    return jsonResponse({ error: "Marktdaten sind gerade nicht erreichbar." }, 502);
  }
}