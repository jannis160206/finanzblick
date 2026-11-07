import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const CALLBACK_PATH = "/api/bank/callback";

/** Local https endpoint for ENABLEBANKING_REDIRECT_URL=https://localhost:<port>/api/bank/callback. */
export function localCallbackPlan(env: Record<string, string | undefined> = process.env): { port: number; hostname: string; target: string } | null {
  const raw = env.ENABLEBANKING_REDIRECT_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.pathname !== CALLBACK_PATH || !url.port) return null;
  const appOrigin = (env.FINANZBLICK_ORIGIN?.trim() || `http://127.0.0.1:${env.PORT?.trim() || "3000"}`).replace(/\/+$/, "");
  if (new URL(appOrigin).port === url.port) return null;
  return { port: Number(url.port), hostname: url.hostname === "localhost" ? "127.0.0.1" : url.hostname, target: `${appOrigin}${CALLBACK_PATH}` };
}

/** Forwards the bank's return (code/state) from the https URL to the regular Finanzblick server. */
export function callbackRedirect(requestUrl: string, target: string): { status: number; location?: string } {
  const url = new URL(requestUrl, "https://localhost");
  if (url.pathname !== CALLBACK_PATH) return { status: 404 };
  return { status: 303, location: `${target}${url.search}` };
}

const globalState = globalThis as typeof globalThis & { finanzblickBankCallback?: boolean };

export function startLocalBankCallback(env: Record<string, string | undefined> = process.env): void {
  const plan = localCallbackPlan(env);
  if (!plan || globalState.finanzblickBankCallback) return;
  const pfxPath = env.ENABLEBANKING_TLS_PFX?.trim() || ".local-data/bank-callback.pfx";
  let pfx: Buffer;
  try {
    pfx = readFileSync(pfxPath);
  } catch {
    console.warn(`Bank-Rücksprung: Zertifikat ${pfxPath} fehlt (scripts/bank-callback-cert.ps1 ausführen).`);
    return;
  }
  globalState.finanzblickBankCallback = true;
  const server = createServer({ pfx, passphrase: env.ENABLEBANKING_TLS_PASSPHRASE ?? "finanzblick" }, (request, response) => {
    const result = request.method === "GET" ? callbackRedirect(request.url ?? "/", plan.target) : { status: 405 };
    response.writeHead(result.status, {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...(result.location ? { Location: result.location } : { "Content-Type": "text/plain; charset=utf-8" }),
    });
    response.end(result.location ? undefined : "Nicht gefunden");
  });
  server.on("error", (error) => {
    globalState.finanzblickBankCallback = false;
    console.warn("Bank-Rücksprung (https) nicht gestartet:", error.message);
  });
  server.listen(plan.port, plan.hostname, () => console.info(`Bank-Rücksprung bereit: https://localhost:${plan.port}${CALLBACK_PATH}`));
  server.unref();
}
