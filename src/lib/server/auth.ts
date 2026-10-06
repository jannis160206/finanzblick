import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { AccountUser } from "@/lib/account-schema";
import { isAccountMode } from "./config";
import { getAccountRuntime } from "./runtime";
import {
  accountErrorResponse,
  jsonResponse,
  requestSessionToken,
  requireMutationOrigin,
  sessionCookieName,
} from "./http";

export { isAccountMode, registrationEnabled } from "./config";

export async function getCurrentUser(): Promise<AccountUser | null> {
  if (!isAccountMode()) return null;
  const { database } = await getAccountRuntime();
  const store = await cookies();
  return database.currentUser(store.get(sessionCookieName())?.value);
}

export async function requireAccount(): Promise<AccountUser> {
  if (!isAccountMode()) return { id: "local", username: "local", role: "user" };
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function authorizeApi(request: Request): Promise<Response | null> {
  try {
    if (!isAccountMode()) return null;
    const { config, database } = await getAccountRuntime();
    if (!database.currentUser(requestSessionToken(request))) {
      return jsonResponse({ error: "Bitte anmelden." }, 401);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method))
      requireMutationOrigin(request, config);
    return null;
  } catch (error) {
    return accountErrorResponse(error);
  }
}
