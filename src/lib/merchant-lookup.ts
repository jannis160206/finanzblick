import { actualBookings, classify, knownMerchantName, merchantName } from "@/lib/calc";
import { ambiguousMerchant, hasTerminalText, merchantText, recoverMerchant, unresolvedTerminal } from "@/lib/import/merchant-description";
import { isSpecificMerchantKey, merchantRuleKey, rememberMerchants } from "@/lib/import/merchant-rules";
import { bookingReviewReason } from "@/lib/import/review";
import { statementFingerprint } from "@/lib/import/identity";
import { merchantLookupQuerySchema, merchantLookupResultSchema, type MerchantLookupResult } from "@/lib/merchant-lookup-schema";
import type { AppState, Transaction } from "@/lib/types";
import { merchantAliasAssignment } from "@/lib/merchant-identity";
import { isAutomationLocked } from "@/lib/automation/locks";

const unknownMerchant = /h(?:ä|ae)ndler\s+unbekannt/i;
type AliasBooking = Omit<Transaction, "amount"> & { amount: number | null };

export function needsMerchantLookup(row: Transaction): boolean {
  if (row.amount >= 0 || row.reviewed || row.merchantAlias) return false;
  const recovered = recoverMerchant(row);
  if (knownMerchantName(merchantText(recovered.description))) return false;
  return ambiguousMerchant(row) || unresolvedTerminal(recovered.description) ||
    unknownMerchant.test(recovered.description) || merchantName(recovered.description) === "Händler unbekannt" ||
    (hasTerminalText(row.rawDescription ?? row.description) &&
      (row.description === recovered.description || classify(row).category === "Prüfen"));
}

// Only merchant/location text crosses the API boundary, never bank references or card details.
function lookupText(text: string): string {
  return merchantText(text
    .replace(/\b(?:iban|bic|auftraggeberreferenz|mandatsreferenz|zahlungsreferenz|bankreferenz|referenz|kontonummer|kartennummer|kundennummer)\b[\s\S]*/i, " ")
    .replace(/\b[A-Z]{2}\s*\d{2}(?:[\s-]*[A-Z0-9]){10,30}\b/gi, " ")
    .replace(/\b\d(?:[\s-]*\d){4,}\b/g, " "))
    .replace(unknownMerchant, "")
    .replace(/[;|]+/g, " ").replace(/\s+/g, " ").trim();
}

export function merchantLookupQuery(row: Transaction): string | undefined {
  const merchant = lookupText(row.merchantAlias ?? recoverMerchant(row).description);
  if (!/\p{L}{2}/u.test(merchant)) return;
  const sources = [row.description, ...(row.rawDetails ?? []), row.rawDescription ?? ""];
  const locations = sources.flatMap((text) => [
    ...[...text.matchAll(/(?:h(?:ä|ae)ndler[\s-]*ort|merchant[\s-]*city|ort|stadt|plz)\s*:\s*([^;|\n:]+?)(?=\s+[\p{L}-]+\s*:|[;|\n]|$)/giu)]
      .map((match) => /^[1-9]\d{3}$/.test(match[1].trim()) ? match[1].trim() : lookupText(match[1])),
    ...[...lookupText(text).matchAll(/\b[1-9]\d{3}\s+[\p{L}][\p{L}.'-]*\b/gu)].map((match) => match[0]),
  ]).filter(Boolean);
  const parts = [merchant];
  for (const location of locations)
    if (!location.toLocaleLowerCase("de-AT").split(/\s+/).every((word) =>
      parts.some((part) => part.toLocaleLowerCase("de-AT").includes(word)))) parts.push(location);
  const query = `${parts.join(", ")}, AT`;
  return merchantLookupQuerySchema.safeParse(query).success ? query : undefined;
}

export function confirmMerchantAlias(state: AppState, selected: Transaction, result: MerchantLookupResult): AppState {
  const alias = merchantLookupResultSchema.parse(result).name;
  const ledger = actualBookings(state);
  const current = ledger.find((row) => row.id === selected.id);
  if (!current || current.merchantAlias !== selected.merchantAlias || merchantRuleKey(current) !== merchantRuleKey(selected))
    throw new Error("Die Buchung wurde inzwischen geändert. Bitte erneut öffnen.");
  const key = merchantRuleKey(current);
  const canMatchTwins = isSpecificMerchantKey(key) &&
    !!lookupText(current.merchantAlias ?? recoverMerchant(current).description) &&
    (!!current.merchantAlias || !unresolvedTerminal(current.description));
  const openIds = new Set((state.reviewQueue ?? []).flatMap((item) =>
    item.kind === "booking" ? [item.draft.id] : item.change.bookings.map((row) => row.id)));
  const matches = (row: AliasBooking) => row.id === selected.id ||
    (canMatchTwins && !isAutomationLocked(row) && row.merchantAlias === current.merchantAlias && !row.reviewed && merchantRuleKey(row) === key &&
      (openIds.has(row.id) || (row.amount !== null && !!bookingReviewReason(state, { ...row, amount: row.amount }))));
  const apply = <T extends AliasBooking>(row: T): T => matches(row)
    ? { ...row, ...merchantAliasAssignment(row, alias),
      ...(row.id !== selected.id ? { merchantNameConfirmed: undefined, merchantMatch: "rule" as const,
        requires_manual_review: true } : {}) }
    : row;
  const updated = {
    ...state,
    transactions: state.transactions.map(apply),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((receipt) => {
      const booking = receipt.booking;
      const updated = receipt.key === selected.id || receipt.key === statementFingerprint(current)
        ? { ...(booking ?? current), ...merchantAliasAssignment(booking ?? current, alias) } : booking && apply(booking);
      return updated && updated !== booking ? { ...receipt, booking: updated, merchantKey: merchantRuleKey(updated) } : receipt;
    }) } : {}),
    ...(state.reviewQueue ? { reviewQueue: state.reviewQueue.map((item) => item.kind === "fixed"
      ? { ...item, change: { ...item.change, bookings: item.change.bookings.map(apply) } }
      : { ...item, draft: apply(item.draft) }) } : {}),
  };
  return rememberMerchants(updated, [{ ...current, ...merchantAliasAssignment(current, alias) }]);
}
