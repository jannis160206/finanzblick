import { transactionSchema, type ReviewItem, type Transaction } from "@/lib/types";
import { screenshotAmount, screenshotDate, screenshotPocket } from "./amex-screenshot";
import { amexBookingKey, isAmexScreenshot } from "./identity";

type Draft = Extract<ReviewItem, { kind: "booking" }>["draft"];
const clean = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const repayment = /^zahlung\s*\/\s*überweisung\s+erhalten\b/i;
const untouched = (row: Draft) => !row.reviewed && !row.manualCategory &&
  !row.categoryOverride && row.fixedCost === undefined && row.merchantAlias === undefined;

export function legacyScreenshotIssues(items: ReviewItem[], issues: string[]): Map<string, string[]> {
  const byMessage = new Map<string, string | null>();
  for (const item of items) {
    if (item.kind !== "booking" || !isAmexScreenshot(item.draft)) continue;
    byMessage.set(item.message, byMessage.has(item.message) ? null : item.id);
  }
  const linked = new Map<string, string[]>();
  for (const [message, id] of byMessage) {
    if (id === null || !message.startsWith("Amex-Screenshot:")) continue;
    const matches = issues.filter((issue) => issue.endsWith(`: ${message}`));
    if (matches.length === 1) linked.set(id, matches);
  }
  return linked;
}

function screenshotDetails(row: Draft) {
  if (!isAmexScreenshot(row) || row.rawDetails?.includes("OCR-Händler unklar")) return null;
  const details = row.rawDetails!.filter((text) => text !== "Amex-Screenshot");
  const amounts = details.filter((text) => screenshotAmount(text) !== null);
  if (amounts.length !== 1) return null;
  const amount = screenshotAmount(amounts[0])!;
  if (row.amount !== null && row.amount !== amount) return null;
  return { amount, lines: details.filter((text) => text !== amounts[0]) };
}

function screenshotFacts(row: Draft, legacy = false): Transaction | null {
  const details = screenshotDetails(row);
  if (!details) return null;
  const dates = details.lines.filter((text) => screenshotDate(text) !== null);
  if (dates.length !== 1) return null;
  const date = screenshotDate(dates[0])!;
  if (row.date && row.date !== date) return null;
  const description = details.lines.filter((text) => text !== dates[0]).join(" ").trim();
  if (!/\p{L}/u.test(description)) return null;
  const original = clean(row.rawDescription ?? row.description);
  if (original !== clean(description) &&
    !(legacy && !row.date && original === clean(details.lines.join(" ")))) return null;
  const pocket = screenshotPocket(dates[0]);
  if (pocket === "AMEX ungeklärt") return null;
  const facts = { ...row, date, amount: details.amount, description, rawDescription: undefined, pocket };
  const previousPocket = clean(row.pocket ?? "");
  // The old parser swallowed the date/holder into the merchant and defaulted to Amex.
  const legacyDefault = legacy && !row.date && ["", "amex"].includes(previousPocket);
  if (!legacyDefault && amexBookingKey({ ...facts, pocket: row.pocket }) !== amexBookingKey(facts)) return null;
  return facts;
}

function croppedOrderKey(row: Draft): string | null {
  const details = screenshotDetails(row);
  if (!details || details.lines.some((line) => screenshotDate(line) !== null)) return null;
  const description = details.lines.join(" ").trim();
  if (!/\b(?:AMAZON\.[A-Z.]+|AMZN\s+MKTP\s+[A-Z]{2}|AIRBNB)\s*\*\s*[A-Z0-9]{6,}\b/i.test(description) ||
    clean(row.rawDescription ?? row.description) !== clean(description)) return null;
  const key = amexBookingKey({ ...row, date: "", amount: details.amount });
  return key ? JSON.stringify([key, row.occurrence ?? 1, row.bankReference ?? null, row.rawDetails]) : null;
}

export function confirmedScreenshotDateMatcher(candidates: Transaction[]): (row: Draft) => boolean {
  const dates = new Map<string, Set<string>>();
  for (const row of candidates) {
    if (!row.reviewed || !(row.manualCategory || row.categoryOverride) || !transactionSchema.safeParse(row).success) continue;
    const key = croppedOrderKey(row);
    if (!key) continue;
    const values = dates.get(key) ?? new Set<string>();
    values.add(row.date);
    dates.set(key, values);
  }
  // Only reuse a confirmed date correction for the same raw, identifiable order.
  // Same merchant/amount alone must never resolve another cropped purchase.
  return (row) => !row.date && dates.get(croppedOrderKey(row) ?? "")?.size === 1;
}

// Re-reads untouched incomplete screenshot drafts whose raw OCR lines are now parseable
// (e.g. the date/holder separator was misread as "+"). Exact duplicates collapse to one.
export function repairScreenshotReviewDrafts(items: ReviewItem[], ledger: Transaction[]): { items: ReviewItem[]; repaired: Set<string> } {
  const repaired = new Set<string>();
  // A same-looking booking may be a second identical purchase or a duplicate – never guess.
  const booked = new Set(ledger.map((row) => amexBookingKey(row)).filter(Boolean));
  const seen = new Set<string>();
  const result = items.flatMap((item): ReviewItem[] => {
    // Filling a readable date/holder never overrides a category or alias, so only explicit user review blocks it.
    if (item.kind !== "booking" || item.sourceRepair || item.draft.reviewed || item.draft.manualCategory || item.draft.date ||
      transactionSchema.safeParse(item.draft).success) return [item];
    const facts = screenshotFacts(item.draft, true);
    if (!facts || !transactionSchema.safeParse(facts).success || booked.has(amexBookingKey(facts))) return [item];
    const key = JSON.stringify([amexBookingKey(facts), facts.occurrence ?? 1, facts.bankReference ?? null]);
    if (seen.has(key)) return [];
    seen.add(key);
    repaired.add(item.id);
    return [{ ...item, draft: facts }];
  });
  return { items: result, repaired };
}

export function reconcileScreenshotReviews(items: ReviewItem[], candidates: Transaction[]): ReviewItem[] {
  const confirmedDate = confirmedScreenshotDateMatcher(candidates);
  const keys = new Set(candidates.flatMap((row) => {
    if (!isAmexScreenshot(row) || !transactionSchema.safeParse(row).success) return [];
    const facts = screenshotFacts(row);
    return facts ? [JSON.stringify([amexBookingKey(facts), row.occurrence ?? 1, row.bankReference ?? null])] : [];
  }));
  return items.filter((item) => {
    if (item.kind !== "booking" || !untouched(item.draft) ||
      transactionSchema.safeParse(item.draft).success) return true;
    const row = item.draft;
    if (confirmedDate(row)) return false;
    const details = screenshotDetails(row);
    if (!details) return true;
    // A confirmed incoming card repayment is never income, even without a readable date.
    if (row.amount !== null && details.amount > 0 && repayment.test(row.description) &&
      repayment.test(details.lines.join(" "))) return false;
    const facts = screenshotFacts(row, true);
    return !facts || !keys.has(JSON.stringify([amexBookingKey(facts), row.occurrence ?? 1, row.bankReference ?? null]));
  });
}
