import { type AppState, type Transaction, type ReviewItem } from "@/lib/types";
import { amexBookingKey, amexCardholder, isAmexScreenshot, statementFingerprint } from "./identity";
import { merchantRuleKey } from "./merchant-rules";

const normalized = (text: string) => text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const holder = amexCardholder;
const source = (row: Transaction) => row.amexSource ?? (isAmexScreenshot(row) ? "screenshot" :
  amexBookingKey(row) ? "pdf" : undefined);
const screenshotKey = (row: Transaction) => `${amexBookingKey(row)}|${row.occurrence ?? 1}`;
type MerchantText = Pick<Transaction, "description" | "rawDescription" | "rawDetails">;
const text = (row: MerchantText) => row.rawDescription ?? row.description;
const order = (row: MerchantText) => {
  const codes = new Set([text(row), ...(row.rawDetails ?? [])].flatMap((line) => {
    const match = /\b(AMAZON\.[A-Z.]+|AMZN\s+MKTP\s+[A-Z]{2}|AIRBNB)\s*\*\s*([A-Z0-9]{6,})\b/i.exec(line);
    return match ? [`${normalized(match[1])}|${match[2].toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0")}`] : [];
  }));
  return codes.size === 1 ? [...codes][0] : null;
};
const store = (value: string) => {
  if (!/^(?:spar|billa|mcdonalds|mueller|ikea)\b/.test(value) || !/\b\d{2,}\b/.test(value)) return null;
  return [...new Set(value.split(" ").filter((word) => !["fil", "filiale"].includes(word)))].sort().join(" ");
};
export { order as amexOrderKey, sameMerchant as sameAmexMerchant };
function sameMerchant(a: MerchantText, b: MerchantText) {
  const leftOrder = order(a), rightOrder = order(b);
  if (leftOrder && rightOrder) return leftOrder === rightOrder;
  if (leftOrder || rightOrder) {
    const base = (leftOrder ?? rightOrder)!.split("|")[0];
    const uncoded = normalized(text(leftOrder ? b : a));
    return uncoded === base || uncoded.startsWith(`${base} `);
  }
  const left = normalized(text(a)), right = normalized(text(b));
  if (left === right) return true;
  if (store(left) && store(left) === store(right)) return true;
  // PDF city/address suffixes may enrich an identifiable merchant, not a provider alone.
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  return shorter.length >= 10 && shorter.split(" ").length >= 2 &&
    !/^(?:paypal|mollie|sumup|stripe|klarna|amex|american express)$/.test(shorter) &&
    longer.startsWith(`${shorter} `);
}
const daysApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
function sameBooking(a: Transaction, b: Transaction, correction: boolean) {
  if (!holder(a) || holder(a) !== holder(b) || !sameMerchant(a, b)) return false;
  if (Math.sign(a.amount) !== Math.sign(b.amount) &&
    !(correction && /\b(?:gutschrift|refund)\b/i.test(text(a)) &&
      /\b(?:gutschrift|refund)\b/i.test(text(b)))) return false;
  if (a.date === b.date && a.amount === b.amount) return true;
  if (!correction) return false;
  if (!!order(a) !== !!order(b) && a.amount !== b.amount && a.amexStatus !== "pending") return false;
  // A changed amount needs an exact day; only a unique order or a pending charge
  // can move to the PDF's final booking day.
  return a.date === b.date || (daysApart(a.date, b.date) <= 3 &&
    ((!!order(a) && !!order(b)) || (a.amexStatus === "pending" &&
      (source(b) === "pdf" || b.amexStatus === "posted"))));
}
function updateBooking(old: Transaction, incoming: Transaction): Transaction {
  const details = [...new Set([
    ...(incoming.rawDetails ?? []),
    ...(order(old) && !order(incoming) ? [`Amex-App-Referenz: ${text(old)}`.slice(0, 1000)] : []),
    ...(old.rawDetails ?? []).filter((line) => line !== "Amex-Screenshot" && line !== "Amex-PDF"),
  ])].slice(0, 20);
  const trackScreenshots = !!incoming.amexSource || !!old.amexSource || !!old.amexScreenshotKeys;
  const screenshotKeys = [...new Set([...(old.amexScreenshotKeys ?? []),
    ...(trackScreenshots && source(old) === "screenshot" ? [screenshotKey(old)] : []),
    ...(trackScreenshots && source(incoming) === "screenshot" ? [screenshotKey(incoming)] : []),
  ])].slice(-20);
  return {
    ...old, date: incoming.date, amount: incoming.amount,
    description: incoming.description,
    ...(incoming.rawDescription ? { rawDescription: incoming.rawDescription } :
      old.rawDescription ? { rawDescription: incoming.description } : {}),
    ...(old.rawDetails || incoming.rawDetails ? { rawDetails: details } : {}),
    ...(incoming.amexSource ? { amexSource: incoming.amexSource } : {}),
    ...(incoming.amexStatus ? { amexStatus: incoming.amexStatus } : {}),
    ...(incoming.amexCapturedAt ? { amexCapturedAt: incoming.amexCapturedAt } : {}),
    ...(incoming.amexPeriodStart ? { amexPeriodStart: incoming.amexPeriodStart } : {}),
    ...(screenshotKeys.length ? { amexScreenshotKeys: screenshotKeys } : {}),
    ...(incoming.time ? { time: incoming.time } : {}),
    ...(incoming.bankReference ? { bankReference: incoming.bankReference } : {}),
  };
}

export type AmexReconciliation = { rows: Transaction[]; validationDate?: string };

export function screenshotPendingBalance(
  state: AppState, rows: Transaction[], matchedIds: Map<string, string>, date: string,
) {
  const known = new Map<string, Transaction>();
  for (const row of [...state.transactions, ...(state.fixedReceipts ?? []).flatMap((item) => item.booking ? [item.booking] : [])])
    if (!known.has(row.id)) known.set(row.id, row);
  const amount = rows.filter((row) => row.amexStatus === "pending").reduce((sum, row) => {
    const matchedId = matchedIds.get(row.id);
    const final = matchedId ? known.get(matchedId) : undefined;
    return sum - (final && source(final) === "pdf" ? (final.date <= date ? final.amount : 0) : row.amount);
  }, 0);
  return Math.round(amount * 100) / 100;
}

export function reconcileAmexImports(state: AppState, evidence: AmexReconciliation) {
  const validating = !!evidence.validationDate && !state.amexScreenshotValidation;
  const existing = new Map<string, Transaction>();
  for (const row of [...state.transactions, ...(state.fixedReceipts ?? []).flatMap((item) => item.booking ? [item.booking] : [])])
    if (source(row) && !existing.has(statementFingerprint(row))) existing.set(statementFingerprint(row), row);
  const originals = [...existing.values()];
  const unique = new Map<string, Transaction>();
  for (const row of evidence.rows) {
    const key = screenshotKey(row);
    if (source(row) && holder(row) && !unique.has(key)) unique.set(key, row);
  }
  const incoming = [...unique.values()];
  const matches = new Map<Transaction, Transaction>();
  const used = new Set<Transaction>();
  const disputed = new Set<Transaction>();
  const canCorrect = (old: Transaction, row: Transaction) =>
    source(old) === "screenshot" && (source(row) === "pdf" ||
      (source(row) === "screenshot" && (validating || old.amexStatus === "pending" ||
        (row.amexCapturedAt === state.amexScreenshotValidation?.date &&
          !!row.amexCapturedAt && (!old.amexCapturedAt || old.amexCapturedAt < row.amexCapturedAt))) &&
        (!old.amexCapturedAt || !row.amexCapturedAt || row.amexCapturedAt >= old.amexCapturedAt)));
  for (const correction of [false, true]) {
    const pending = incoming.filter((row) => !matches.has(row) && !disputed.has(row));
    const available = originals.filter((old) => !used.has(old));
    const choices = new Map(pending.map((row) => [row, available.filter((old) =>
      (source(old) === "pdf" && source(row) === "screenshot" && old.amexScreenshotKeys?.includes(screenshotKey(row))) ||
      ((!correction || canCorrect(old, row)) && sameBooking(old, row, correction) &&
        (correction || (old.occurrence ?? 1) === (row.occurrence ?? 1))))]));
    for (const [row, targets] of choices) {
      if (targets.length === 1 && [...choices.values()].filter((group) => group.includes(targets[0])).length === 1) {
        matches.set(row, targets[0]); used.add(targets[0]);
      } else if (targets.length) disputed.add(row);
    }
  }
  const replacements = new Map<string, Transaction>();
  for (const [row, old] of matches) {
    if ((source(old) === "pdf" && source(row) !== "pdf") ||
      (!canCorrect(old, row) && (old.date !== row.date || old.amount !== row.amount))) continue;
    if (source(row) === "screenshot" && old.amexCapturedAt && row.amexCapturedAt && row.amexCapturedAt < old.amexCapturedAt) continue;
    replacements.set(statementFingerprint(old), updateBooking(old, row));
  }
  const replace = (row: Transaction) => replacements.get(statementFingerprint(row)) ?? row;
  const keyChanges = new Map([...replacements].map(([key, row]) => [key, statementFingerprint(row)]));
  const reviews: ReviewItem[] = [...disputed].map((row) => ({
    kind: "booking", id: row.id, draft: row,
    message: "Amex: Mehrere passende Buchungen. Bitte die Zuordnung prüfen; der Bestand wurde nicht verändert.",
  }));
  let snapshots = state.amexBalanceSnapshots;
  for (const [row, old] of matches) {
    if (old.amexStatus !== "pending" || !replacements.has(statementFingerprint(old)) ||
      (old.amount === row.amount && old.date === row.date)) continue;
    snapshots = snapshots?.map((snapshot) => snapshot.date === old.amexCapturedAt && snapshot.pendingBalance !== undefined
      ? { ...snapshot, pendingBalance: Math.round((snapshot.pendingBalance + old.amount -
        (row.date <= snapshot.date ? row.amount : 0)) * 100) / 100 }
      : snapshot);
  }
  const updated: AppState = {
    ...state, transactions: state.transactions.map(replace),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((item) => {
      if (!item.booking) return item;
      const booking = replace(item.booking);
      return booking === item.booking ? item : { ...item, booking, key: statementFingerprint(booking),
        date: booking.date, amount: booking.amount, merchantKey: merchantRuleKey(booking) };
    }) } : {}),
    ...(state.ignoredStatementKeys ? { ignoredStatementKeys: state.ignoredStatementKeys.map((key) => keyChanges.get(key) ?? key) } : {}),
    ...(state.reviewQueue ? { reviewQueue: state.reviewQueue.flatMap((item): ReviewItem[] => {
      if (item.kind !== "booking" || !isAmexScreenshot(item.draft)) return [item];
      const draft = item.draft;
      const corrected = draft.amount !== null ? replacements.get(statementFingerprint({ ...draft, amount: draft.amount })) : undefined;
      if (corrected) return [{ ...item, draft: corrected }];
      if (draft.reviewed || draft.manualCategory || draft.categoryOverride || draft.merchantAlias ||
        draft.fixedCost !== undefined || draft.rawDetails?.includes("OCR-Händler unklar")) return [item];
      const resolved = incoming.filter((row) => !disputed.has(row) && holder(row) === holder(draft) &&
        sameMerchant(row, draft) && (draft.date ? row.date === draft.date : !!order(draft)) &&
        (draft.amount === null || row.amount === draft.amount));
      return resolved.length === 1 && (!draft.date || draft.amount === null || resolved[0].category !== "Prüfen") ? [] : [item];
    }) } : {}),
    ...(snapshots ? { amexBalanceSnapshots: snapshots } : {}),
    ...(validating ? { amexScreenshotValidation: { version: 1, date: evidence.validationDate! } } : {}),
  };
  const survivor = new Map(incoming.map((row) => [screenshotKey(row), row]));
  return { state: updated,
    rows: evidence.rows.filter((row) => !matches.has(row) && !disputed.has(row) &&
      (!source(row) || survivor.get(screenshotKey(row)) === row)).map((row) =>
        row.amexSource === "screenshot" && !row.amexScreenshotKeys
          ? { ...row, amexScreenshotKeys: [screenshotKey(row)] } : row),
    review: reviews, duplicates: matches.size + evidence.rows.filter((row) => source(row) && holder(row)).length - incoming.length,
    matchedIds: new Map([...matches].map(([row, old]) => [row.id, old.id])),
  };
}
