import { AsyncLocalStorage } from "node:async_hooks";

// The names of the user never go to DeepSeek: they are masked like a person in every cloud call and revealed again in the
// answer. Server only: an API request runs in a scope with the signed-in account's name; the model client reads it through a
// global hook (`requestNames`), so it stays importable in the browser bundle without Node modules.

const scope = new AsyncLocalStorage<string[]>();
const hook = globalThis as typeof globalThis & { finanzblickRequestNames?: () => string[] };
hook.finanzblickRequestNames ??= () => scope.getStore() ?? [];

const technical = new Set(["admin", "administrator", "local", "user", "test", "demo", "root", "guest", "finanzblick"]);

/** A login name that looks like a person's name ("anna", "anna.berger"); technical accounts and e-mail domains stay out. */
export function accountName(username: string | undefined): string[] {
  const local = (username ?? "").split("@")[0].trim();
  if (!/^\p{L}[\p{L}'’ ._-]{2,}$/u.test(local) || technical.has(local.toLowerCase())) return [];
  // Written like a name, so the answer shows "Anna Berger" when the placeholder is put back.
  const parts = local.split(/[._\s-]+/).filter((part) => part.length >= 2).map((part) => part.charAt(0).toLocaleUpperCase("de-AT") + part.slice(1));
  return parts.length ? [parts.join(" ")] : [];
}

/** Runs one request with the user's names in scope, so every model call inside masks them. */
export const withPrivateNames = <T>(names: string[], run: () => T): T => scope.run(names, run);
