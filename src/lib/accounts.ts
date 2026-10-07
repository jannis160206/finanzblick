type Account = { bank: string; pocket: string | null };

export const RAIFFEISEN_ACCOUNT = "Raiffeisen Giro";

const clean = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
const raiffeisenBanks = new Set(["raiffeisen", "raiffeisen giro", "raiffeisen hauptkonto"]);
const raiffeisenAccounts = new Set([
  "", "hauptkonto", "giro", "girokonto", "raiffeisen giro", "raiffeisen hauptkonto",
]);
const revolutMainAccounts = new Set([
  "", "hauptkonto", "hauptkonto (eur)", "revolut hauptkonto", "eur",
  "persönliches konto", "persönliches konto (eur)", "personal account", "personal account (eur)",
]);

export function isRevolutMainAccount(account: Account): boolean {
  return clean(account.bank) === "revolut" && revolutMainAccounts.has(clean(account.pocket ?? ""));
}

export function isRaiffeisenBank(bank: string): boolean {
  return raiffeisenBanks.has(clean(bank));
}

export function normalizeAccount<T extends Account>(account: T): T {
  if (!isRaiffeisenBank(account.bank)) return account;
  // Only known main-account aliases are equivalent; currency and named accounts stay separate.
  const pocket = raiffeisenAccounts.has(clean(account.pocket ?? ""))
    ? RAIFFEISEN_ACCOUNT
    : account.pocket;
  return account.bank === "Raiffeisen" && account.pocket === pocket
    ? account
    : { ...account, bank: "Raiffeisen", pocket };
}

export function isRaiffeisenMainAccount(account: Account): boolean {
  const normalized = normalizeAccount(account);
  return normalized.bank === "Raiffeisen" && normalized.pocket === RAIFFEISEN_ACCOUNT;
}

export function accountLabel(account: Account): string {
  const normalized = normalizeAccount(account);
  const pocket = isRaiffeisenMainAccount(normalized)
    ? "Girokonto"
    : normalized.pocket ?? "Hauptkonto";
  return `${normalized.bank} · ${pocket}`;
}
