import type { AccountUser, FinanceSnapshot } from "@/lib/account-schema";
import type { AppState } from "@/lib/types";
import { getAccountRuntime } from "./runtime";

// Larger ledgers keep loading on the client so the HTML of every page stays small.
const MAX_INLINE_CHARS = 1_500_000;

/** The signed-in account's stored finance state for the first render; undefined lets the client load it as before. */
export async function serverFinanceSnapshot(user: AccountUser, read?: () => FinanceSnapshot): Promise<{ state: AppState; revision: number } | undefined> {
  try {
    const snapshot = read ? read() : (await getAccountRuntime()).database.getFinance(user.id);
    if (!snapshot.state || JSON.stringify(snapshot.state).length > MAX_INLINE_CHARS) return undefined;
    return { state: snapshot.state, revision: snapshot.revision };
  } catch {
    return undefined;
  }
}
