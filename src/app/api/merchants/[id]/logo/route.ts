import { AutomationStore } from "@/lib/automation/store";
import { readPrivateMerchantLogo } from "@/lib/automation/merchant-logo";
import { merchantLogoVersion } from "@/lib/automation/merchant-logo-version";
import { readAuthorizedMerchantLogo } from "@/lib/automation/merchant-logo-grants";
import { authorizeApi, isAccountMode } from "@/lib/server/auth";
import { accountErrorResponse } from "@/lib/server/http";
import { requestSessionToken } from "@/lib/server/http";
import { getAccountRuntime } from "@/lib/server/runtime";

export const runtime = "nodejs";

function missingLogo() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const denied = await authorizeApi(request);
  if (denied) return denied;
  try {
    if (!isAccountMode()) return missingLogo();
    const { id } = await params;
    if (!id || id.length > 80 || /[\x00-\x1f]/.test(id)) return missingLogo();
    const { database } = await getAccountRuntime();
    const user = database.currentUser(requestSessionToken(request));
    if (!user) return missingLogo();
    const store = new AutomationStore(database);
    const version = new URL(request.url).searchParams.get("v");
    if (version !== null && !/^[a-f0-9]{64}$/.test(version))
      return missingLogo();
    const grant = /^[a-zA-Z0-9_-]{1,80}$/.test(id)
      ? store.authorizedLogo(user.id, id, version ?? undefined)
      : null;
    if (grant) {
      const data = await readAuthorizedMerchantLogo(
        database.path,
        user.id,
        grant.logo,
      );
      if (!data) return missingLogo();
      return new Response(new Uint8Array(data), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": version
            ? "private, max-age=86400, immutable"
            : "private, no-store",
          Vary: "Cookie",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Merchant-Logo-Permission": grant.logo.permission,
          "X-Merchant-Logo-Attribution": encodeURIComponent(
            grant.logo.attribution,
          ),
        },
      });
    }
    const merchant = store.getMerchant(id);
    const logo = merchant?.logo;
    if (version !== null && (!logo || version !== merchantLogoVersion(logo)))
      return missingLogo();
    const data = await readPrivateMerchantLogo(database.path, logo);
    if (!data || !logo) return missingLogo();
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": version
          ? "private, max-age=86400, immutable"
          : "private, no-store",
        Vary: "Cookie",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Merchant-Logo-License": logo.license,
        "X-Merchant-Logo-Attribution": encodeURIComponent(logo.attribution),
        "X-Merchant-Logo-Source": new URL(logo.sourceUrl).href,
      },
    });
  } catch (error) {
    return accountErrorResponse(error);
  }
}
