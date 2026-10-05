import { readLocalAmexBalanceRecovery } from "@/lib/import/amex-local-recovery";

export const runtime = "nodejs";

function matchesRequestOrigin(request: Request, origin: string) {
  const url = new URL(request.url);
  const host = request.headers.get("host");
  if (host === null) return origin === url.origin;
  try {
    const incoming = new URL(`${url.protocol}//${host}`);
    if (incoming.username || incoming.password || incoming.pathname !== "/" || incoming.search || incoming.hash)
      return false;
    return origin === incoming.origin;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store" };
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (
    (origin !== null && !matchesRequestOrigin(request, origin)) ||
    (site !== null && site !== "same-origin" && site !== "none")
  ) {
    return Response.json({ error: "Diese lokale Amex-Saldo-Wiederherstellung ist nicht erlaubt." }, { status: 403, headers });
  }
  try {
    const recoveries = await readLocalAmexBalanceRecovery();
    return Response.json({ recoveries }, { headers });
  } catch (error) {
    console.error("Lokale Amex-Saldo-Wiederherstellung fehlgeschlagen:", error);
    return Response.json(
      { error: "Der lokale Amex-Saldo konnte nicht wiederhergestellt werden. Bitte erneut versuchen." },
      { status: 500, headers },
    );
  }
}
