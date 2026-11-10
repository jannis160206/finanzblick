import { z } from "zod";
import { bankLogoDirectory, resolveBankLogo } from "@/lib/banks/logo";
import { authorizeApi, isAccountMode } from "@/lib/server/auth";
import { accountErrorResponse, requestSessionToken } from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";

export const runtime = "nodejs";

const querySchema = z.object({
  name: z.string().trim().min(1).max(120),
  country: z.string().regex(/^[A-Z]{2}$/).default("AT"),
  v: z.string().regex(/^[a-f0-9]{16}$/).optional(),
});

const SAFE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// Unknown banks may be cached for an hour so lists do not ask again on every render.
function missingLogo(cacheControl = "private, max-age=3600") {
  return new Response(null, {
    status: 404,
    headers: { ...SAFE_HEADERS, "Cache-Control": cacheControl, Vary: "Cookie" },
  });
}

export async function GET(request: Request) {
  const denied = await authorizeApi(request);
  if (denied) return denied;
  try {
    if (!isAccountMode()) return missingLogo();
    const params = new URL(request.url).searchParams;
    const query = querySchema.safeParse({
      name: params.get("name") ?? undefined,
      country: params.get("country") ?? undefined,
      v: params.get("v") ?? undefined,
    });
    if (!query.success)
      return new Response(null, {
        status: 400,
        headers: { ...SAFE_HEADERS, "Cache-Control": "private, no-store" },
      });
    const { database } = await getAccountRuntime();
    const user = database.currentUser(requestSessionToken(request));
    if (!user) return missingLogo("private, no-store");
    const { name, country, v: version } = query.data;
    const logo = await resolveBankLogo(
      { name, country },
      {
        directory: bankLogoDirectory(database.path),
        beforeLookup: () =>
          database.consumeRateLimit(`bank-logo:${user.id}`, 30, 60_000),
      },
    );
    if (!logo) return missingLogo();
    if (version !== undefined && version !== logo.version)
      return missingLogo("private, no-store");
    const headers = {
      ...SAFE_HEADERS,
      "Cache-Control": version
        ? "private, max-age=86400, immutable"
        : "private, max-age=86400",
      ETag: `"${logo.version}"`,
      Vary: "Cookie",
      "X-Bank-Logo-Version": logo.version,
    };
    const cached = request.headers
      .get("If-None-Match")
      ?.split(",")
      .some((tag) => tag.trim().replace(/^W\//, "") === headers.ETag);
    if (cached) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(logo.png), {
      headers: { ...headers, "Content-Type": "image/png" },
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
