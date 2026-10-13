import { isIP } from "node:net";
import { ZodError } from "zod";
import { AccountError, isAccountConfigError, isAccountError, isSqliteContentionError } from "./errors";
import type { AccountConfig } from "./config";
import { SESSION_SECONDS, type AccountSession } from "./database";

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function accountErrorResponse(error: unknown): Response {
  if (isSqliteContentionError(error)) {
    const response = jsonResponse(
      { error: "Der Server ist vorübergehend ausgelastet. Bitte kurz warten und erneut versuchen." },
      503,
    );
    response.headers.set("Retry-After", "5");
    return response;
  }
  if (isAccountConfigError(error)) {
    console.error("Account configuration unavailable:", error.message);
    return jsonResponse(
      { error: "Die Kontoanmeldung ist momentan nicht verfügbar." },
      503,
    );
  }
  if (isAccountError(error)) {
    const response = jsonResponse({ error: error.message }, error.status);
    if (error.status === 429) response.headers.set("Retry-After", "900");
    return response;
  }
  if (error instanceof ZodError) {
    return jsonResponse({ error: "Ungültige Eingaben." }, 400);
  }
  // Never log request bodies, tokens, SQL parameters, or arbitrary exception messages.
  console.error(
    "Account operation failed:",
    error instanceof Error ? error.name : "UnknownError",
  );
  return jsonResponse(
    { error: "Die Anfrage konnte nicht verarbeitet werden." },
    500,
  );
}

export function sessionCookieName(): string {
  return process.env.NODE_ENV === "production"
    ? "__Host-finanzblick_session"
    : "finanzblick_session";
}

export function requestSessionToken(request: Request): string | null {
  const cookies = request.headers.get("cookie")?.split(";") ?? [];
  const prefix = `${sessionCookieName()}=`;
  return (
    cookies
      .map((value) => value.trim())
      .find((value) => value.startsWith(prefix))
      ?.slice(prefix.length) ?? null
  );
}

export function attachSessionCookie(
  response: Response,
  config: AccountConfig,
  session: AccountSession | null,
): Response {
  const attributes = [
    `${sessionCookieName()}=${session?.token ?? ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${session ? SESSION_SECONDS : 0}`,
    `Expires=${new Date(session?.expiresAt ?? 0).toUTCString()}`,
  ];
  if (config.secureCookies) attributes.push("Secure");
  response.headers.set("Set-Cookie", attributes.join("; "));
  return response;
}

export function requireMutationOrigin(
  request: Request,
  config: AccountConfig,
): void {
  const url = new URL(request.url);
  let expected = config.origin;
  if (!expected) {
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !["http:", "https:"].includes(url.protocol)
    ) {
      throw new AccountError(
        403,
        "Für diesen Host muss FINANZBLICK_ORIGIN konfiguriert werden.",
      );
    }
    const host = request.headers.get("host");
    if (host && host.toLowerCase() !== url.host.toLowerCase()) {
      throw new AccountError(403, "Ungültiger Anfragehost.");
    }
    expected = url.origin;
  }
  if (request.headers.get("origin") !== expected) {
    throw new AccountError(
      403,
      "Die Anfrage stammt nicht vom erlaubten Ursprung.",
    );
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site")
    throw new AccountError(
      403,
      "Website-übergreifende Anfragen sind nicht erlaubt.",
    );
}

export function clientAddress(request: Request, config: AccountConfig): string {
  // Trust only an explicitly configured, loopback-bound reverse proxy that overwrites X-Forwarded-For.
  if (config.trustProxy) {
    const forwarded = request.headers
      .get("x-forwarded-for")
      ?.split(",")[0]
      ?.trim();
    if (forwarded && isIP(forwarded)) return forwarded;
  }
  return "untrusted";
}

export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;.*)?$/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) {
    throw new AccountError(415, "Content-Type muss application/json sein.");
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)
  ) {
    throw new AccountError(413, "Die Anfrage ist zu groß.");
  }
  if (!request.body)
    throw new AccountError(400, "Ein JSON-Anfrageinhalt ist erforderlich.");
  const reader = request.body.getReader();
  let buffer = Buffer.allocUnsafe(Math.min(4096, maxBytes));
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const nextBytes = bytes + chunk.value.byteLength;
      if (nextBytes > maxBytes) {
        await reader.cancel();
        throw new AccountError(413, "Die Anfrage ist zu groß.");
      }
      if (nextBytes > buffer.length) {
        const grown = Buffer.allocUnsafe(
          Math.min(maxBytes, Math.max(nextBytes, buffer.length * 2)),
        );
        buffer.copy(grown, 0, 0, bytes);
        buffer = grown;
      }
      buffer.set(chunk.value, bytes);
      bytes = nextBytes;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytes),
      ),
    );
  } catch {
    throw new AccountError(400, "Ungültiges JSON.");
  }
}
