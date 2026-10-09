import { AutomationStore } from "@/lib/automation/store";
import { readPrivateMerchantLogo } from "@/lib/automation/merchant-logo";
import { merchantLogoVersion } from "@/lib/automation/merchant-logo-version";
import { authorizeApi, isAccountMode } from "@/lib/server/auth";
import { accountErrorResponse } from "@/lib/server/http";
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
    const merchant = new AutomationStore(database).getMerchant(id);
    const logo = merchant?.logo;
    const version = new URL(request.url).searchParams.get("v");
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
