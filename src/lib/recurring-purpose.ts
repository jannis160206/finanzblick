import type { Category } from "./categories";
import { isWorkingDay } from "./holidays-at-kaernten";
import { merchantText } from "./import/merchant-description";
import type { Transaction } from "./types";

export function merchantPurposeSourceCategory(category: string | undefined) {
  // This legacy import bucket combines purposes; it is not a second merchant.
  return /^hotspot\s*\/\s*trafik$/i.test(category?.trim() ?? "")
    ? undefined
    : category;
}

export function recurringLunchCategory(
  description: string,
  date: string | undefined,
  amount: number,
): Category | undefined {
  if (amount >= 0 || description.length > 1024 || !date) return;
  const text = merchantText(description).toLocaleLowerCase("de-AT");
  const bipa = /^bipa\b/.test(text);
  if (!bipa && !/^(?:hotspot|mensa|mensen)$/.test(text)) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
  const parsed = new Date(`${date}T12:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    return;
  return isWorkingDay(date) ? "Mittagessen" : bipa ? "Drogerie" : "Restaurants";
}

export function recurringAmazonCategory(
  description: string,
): Category | undefined {
  const text = merchantText(description).toLocaleLowerCase("de-AT");
  return /^(?:amazon\s+prime|amznprime)(?:\s|$)/.test(text)
    ? "Abonnements"
    : undefined;
}

export function unnamedFuelPurpose(
  description: string,
  amount: number,
): boolean {
  return (
    amount < 0 &&
    /^(?:tankstelle(?:\s*\d+)?|diskont(?:\s*\d+)?(?:\s+villach)?(?:\s+\d+)?)$/i.test(
      merchantText(description),
    )
  );
}

export function hasRecurringFuelEvidence(
  row: Pick<Transaction, "description"> &
    Partial<
      Pick<Transaction, "rawDescription" | "sourceCategory" | "rawDetails">
    >,
): boolean {
  const text = [
    row.description,
    row.rawDescription,
    row.sourceCategory,
    ...(row.rawDetails ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
  if (
    /\b(?:\p{L}*(?:shop|wasch|waesch)\p{L}*|car\s*wash|cafes?|coffee|snacks?|gastronomie|restaurants?|lebensmittel|groceries|merchandise|strom|charging|fahrzeugwartung|reparatur(?:en)?|maintenance)\b/iu.test(
      text,
    )
  )
    return false;
  return (row.rawDetails ?? []).every((detail) => {
    const mcc = /^(?:mcc|merchant\s*category\s*code)\s*[:=]?\s*(.*)$/i.exec(
      detail.trim(),
    );
    return !mcc || /^(?:5541|5542)$/.test(mcc[1].trim());
  });
}
