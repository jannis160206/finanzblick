import type { Transaction } from "@/lib/types";
import { isRevolutMainAccount } from "@/lib/accounts";
import { pocketKey } from "@/lib/goals";

type NamedBooking = Pick<Transaction, "description"> &
  Partial<Pick<Transaction, "rawDescription" | "merchantAlias">>;

export function isNamedTransfer(row: NamedBooking): boolean {
  // Merchant text only: cardholder headers in OCR details are not transfer names.
  return [row.description, row.rawDescription, row.merchantAlias].some((value) => {
    const text = (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    return /einzahlung|transfer/.test(text) ||
      /\b(?:jannis bru(?:e)?hl|bru(?:e)?hl jannis)\b/.test(text);
  });
}

export function applyNamedTransfer<T extends NamedBooking & Partial<Pick<Transaction,
  "category" | "includeInPlan" | "fixedCost" | "sharedWithRaphael" | "sharedPaidManually">>>(row: T): T {
  if (!isNamedTransfer(row)) return row;
  if (row.category === "Transfer" && row.includeInPlan === false &&
    !row.fixedCost && !row.sharedWithRaphael && !row.sharedPaidManually) return row;
  return { ...row, category: "Transfer", includeInPlan: false,
    ...(row.fixedCost !== undefined ? { fixedCost: false } : {}),
    ...(row.sharedWithRaphael !== undefined ? { sharedWithRaphael: false } : {}),
    ...(row.sharedPaidManually !== undefined ? { sharedPaidManually: false } : {}),
  };
}

const transferText = (value: string) => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/->|\u2192|\u21d2/g, " zu ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
const automaticSavings = /\b(?:round ?ups?|aufrundung(?:en)?|wechselgeld|spare change)\b/;
const savingsDestination = /^um eur (?:(?:zu|in) eur )?(?:sparen|sparkonto)(?: von eur)? ein(?:zu)?stecken$|^(?:sparen|sparkonto)$|\b(?:ziel(?:konto|pocket)?|an|auf|in|zu|to) (?:das |mein |eur )?(?:sparen|sparkonto)(?: eur)?(?=$| (?:von|vom|from)\b)/;
const explicitMainSource = /\b(?:von|vom|from) (?:(?:dem|meinem|the) )?(?:revolut )?(?:hauptkonto|personliches konto|personal account)(?: eur)?(?=$| (?:an|auf|aufs|in|ins|zu|to)\b)/;

export function revolutSavingsTransferAmount(rows: readonly Transaction[], month: string, asOf: string): number {
  const eligible = rows.filter((row) => row.bank.trim().toLowerCase() === "revolut" && row.date <= asOf);
  const mainDebits = new Map<string, number>();
  let total = 0;
  for (const row of eligible) {
    const texts = [row.description, row.rawDescription, ...(row.rawDetails ?? [])].filter((text) => text !== undefined).map(transferText);
    if (row.amount >= 0 || !isRevolutMainAccount(row) || [...texts, transferText(row.sourceCategory ?? "")].some((text) => automaticSavings.test(text)) ||
      !texts.some((text) => savingsDestination.test(text))) continue;
    const cents = Math.round(-row.amount * 100);
    const key = `${row.date}|${cents}`;
    mainDebits.set(key, (mainDebits.get(key) ?? 0) + 1);
    if (row.date.startsWith(month)) total += cents;
  }
  // A credit alone needs an explicit main-account source; generic "von EUR" is
  // also used for other pockets and round-ups. Never count both statement legs.
  for (const row of eligible) {
    if (row.amount <= 0 || !row.date.startsWith(month) || pocketKey(row.pocket) !== "sparkonto") continue;
    const texts = [row.description, row.rawDescription, ...(row.rawDetails ?? [])].filter((text) => text !== undefined).map(transferText);
    if ([...texts, transferText(row.sourceCategory ?? "")].some((text) => automaticSavings.test(text)) || !texts.some((text) => explicitMainSource.test(text))) continue;
    const cents = Math.round(row.amount * 100);
    // Prefer the same date, allowing adjacent statement dates for the other leg.
    const dates = [row.date, ...[-1, 1].map((offset) => new Date(Date.parse(row.date) + offset * 86_400_000).toISOString().slice(0, 10))];
    const key = dates.map((date) => `${date}|${cents}`).find((key) => (mainDebits.get(key) ?? 0) > 0);
    if (key) mainDebits.set(key, mainDebits.get(key)! - 1);
    else total += cents;
  }
  return total / 100;
}
