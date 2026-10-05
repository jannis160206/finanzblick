import { transactionSchema, type ReviewItem, type Transaction } from "@/lib/types";
import { screenshotAmount, screenshotDate, screenshotPocket } from "./amex-screenshot";
import { amexBookingKey, isAmexScreenshot } from "./identity";

type Draft = Extract<ReviewItem, { kind: "booking" }>["draft"];
const clean = (text: string) => text.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const repayment = /^zahlung\s*\/\s*überweisung\s+erhalten\b/i;
const untouched = (row: Draft) => !row.reviewed && !row.manualCategory &&
  !row.categoryOverride && row.fixedCost === undefined && row.merchantAlias === undefined;

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

export function reconcileScreenshotReviews(items: ReviewItem[], candidates: Transaction[]): ReviewItem[] {
  const keys = new Set(candidates.flatMap((row) => {
    if (!isAmexScreenshot(row) || !transactionSchema.safeParse(row).success) return [];
    const facts = screenshotFacts(row);
    return facts ? [JSON.stringify([amexBookingKey(facts), row.occurrence ?? 1, row.bankReference ?? null])] : [];
  }));
  return items.filter((item) => {
    if (item.kind !== "booking" || !untouched(item.draft) ||
      transactionSchema.safeParse(item.draft).success) return true;
    const row = item.draft;
    const details = screenshotDetails(row);
    if (!details) return true;
    // A confirmed incoming card repayment is never income, even without a readable date.
    if (row.amount !== null && details.amount > 0 && repayment.test(row.description) &&
      repayment.test(details.lines.join(" "))) return false;
    const facts = screenshotFacts(row, true);
    return !facts || !keys.has(JSON.stringify([amexBookingKey(facts), row.occurrence ?? 1, row.bankReference ?? null]));
  });
}
