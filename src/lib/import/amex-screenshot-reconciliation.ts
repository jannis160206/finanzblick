import type { ReviewItem, Transaction } from "@/lib/types";
import { amexBookingKey, amexCardholder } from "./identity";
import { amexOrderKey, sameAmexMerchant } from "./amex-reconciliation";
import type { StatementResult } from "./statements";

type Draft = Extract<ReviewItem, { kind: "booking" }>["draft"];
export const groupedScreenshotIssueKey = (draft: Draft) => JSON.stringify([
  draft.amexCapturedAt, draft.pocket, draft.date, draft.amount,
  draft.rawDescription ?? draft.description, draft.rawDetails,
]);
const untouched = (draft: Draft) => !draft.reviewed && !draft.manualCategory && !draft.categoryOverride &&
  draft.fixedCost === undefined && !draft.merchantAlias && !draft.rawDetails?.includes("OCR-Händler unklar");
const compatible = (draft: Draft, row: Transaction) => amexCardholder(draft) === amexCardholder(row) &&
  sameAmexMerchant(draft, row) && (draft.occurrence ?? 1) === (row.occurrence ?? 1) &&
  (!draft.bankReference || draft.bankReference === row.bankReference) &&
  (draft.amount === null || draft.amount === row.amount) && (!draft.date || draft.date === row.date);

export function resolveGroupedScreenshotIssues(results: StatementResult[]) {
  const grouped = results.filter((result) => result.amexScreenshot?.layout === "grouped");
  const resolved = new Map<string, Draft>();
  for (const result of grouped) {
    const metadata = result.amexScreenshot!;
    if (!metadata.card) continue;
    const others = grouped.filter((other) => other !== result && other.amexScreenshot?.card === metadata.card &&
      other.amexScreenshot.capturedAt === metadata.capturedAt);
    const drafts = result.issues.flatMap((issue) => issue.draft ? [issue.draft] : []);
    for (const draft of drafts) {
      if (!untouched(draft) || draft.amount !== null || !draft.date || !amexOrderKey(draft)) continue;
      const matches = others.flatMap((other) => other.rows).filter((row) => compatible(draft, row) &&
        amexOrderKey(draft) === amexOrderKey(row));
      if (new Set(matches.map((row) => `${amexBookingKey(row)}|${row.occurrence ?? 1}`)).size === 1)
        resolved.set(draft.id, draft);
    }
    const order = metadata.bookingOrder ?? [];
    const sourceRows = new Map(result.rows.map((row) => [row.id, row]));
    const sourceDrafts = new Map(drafts.map((draft) => [draft.id, draft]));
    for (let start = 0; start < order.length; start++) {
      const cropped: Draft[] = [];
      let end = start;
      while (end < order.length) {
        const draft = sourceDrafts.get(order[end]);
        if (!draft || draft.date || draft.amount === null || !untouched(draft) || !amexCardholder(draft)) break;
        cropped.push(draft); end++;
      }
      // An isolated same-price merchant is not proof of a missing day. Require
      // an ordered overlap and its following dated anchor in another image.
      const anchor = sourceRows.get(order[end]);
      if (cropped.length < 2 || !anchor) continue;
      const matches = new Set<string>();
      for (const other of others) {
        const rows = new Map(other.rows.map((row) => [row.id, row]));
        const sequence = other.amexScreenshot?.bookingOrder ?? [];
        for (let offset = 0; offset + cropped.length < sequence.length; offset++) {
          const span = sequence.slice(offset, offset + cropped.length + 1).map((id) => rows.get(id));
          if (span.some((row) => !row)) continue;
          if (cropped.every((draft, index) => compatible(draft, span[index]!)) && compatible(anchor, span.at(-1)!))
            matches.add(JSON.stringify(span.map((row) => [amexBookingKey(row!), row!.occurrence ?? 1])));
        }
      }
      if (matches.size === 1) for (const draft of cropped) resolved.set(draft.id, draft);
      start = end;
    }
  }
  return { ids: new Set(resolved.keys()), keys: [...new Set([...resolved.values()].map(groupedScreenshotIssueKey))] };
}
