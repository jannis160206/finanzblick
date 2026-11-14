import { isAccountMode } from "./config";
import { AccountError } from "./errors";
import { requestSessionToken, requireMutationOrigin } from "./http";
import { getAccountRuntime } from "./runtime";

/**
 * Who may use the assistant's feedback and rules endpoints: without accounts (local development) everyone; with accounts
 * signed-in users may write feedback (60 per minute), and only the admin reads the files or switches rules.
 */
export async function assistantCaller(request: Request, access: "write" | "admin" | "admin-write", rateKey = "assistant-feedback") {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") throw new AccountError(403, "Diese Anfrage ist nicht erlaubt.");
  if (!isAccountMode()) return undefined;
  const { config, database } = await getAccountRuntime();
  const user = database.currentUser(requestSessionToken(request));
  if (!user) throw new AccountError(401, "Bitte anmelden.");
  if (access !== "write" && user.role !== "admin") throw new AccountError(403, "Das kann nur der Administrator.");
  if (access !== "admin") {
    requireMutationOrigin(request, config);
    database.consumeRateLimit(`${rateKey}:${user.id}`, 60, 60_000);
  }
  return user;
}
