import { authorizeApi } from "@/lib/server/auth";
import { jsonResponse } from "@/lib/server/http";
import { fetchKnowledge } from "@/lib/web/mcp-client";

export const runtime = "nodejs";

// General knowledge via the finanzblick-web MCP server. Only the looked-up term is passed on, never personal data.
export async function GET(request: Request): Promise<Response> {
  const denied = await authorizeApi(request);
  if (denied) return denied;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return jsonResponse({ error: "Nicht erlaubt." }, 403);
  const query = (new URL(request.url).searchParams.get("q") ?? "").replace(/\s+/g, " ").trim();
  if (query.length < 2 || query.length > 80 || /\d{4,}|@/.test(query)) return jsonResponse({ error: "Ungültiger Begriff." }, 400);
  try {
    // general=1: a plain fact question, which may use any article (places, people), not only finance terms.
    return jsonResponse({ hit: await fetchKnowledge(query, undefined, new URL(request.url).searchParams.get("general") === "1") });
  } catch {
    return jsonResponse({ error: "Das Nachschlagen ist gerade nicht möglich." }, 502);
  }
}
