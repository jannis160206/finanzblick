import { createHash } from "node:crypto";
import { z } from "zod";
import { classifyStatementRows, round } from "@/lib/calc";
import { RAIFFEISEN_ACCOUNT } from "@/lib/accounts";
import { transactionSchema } from "@/lib/types";
import { MAX_STATEMENT_ROWS } from "@/lib/import/limits";
import { numberStatementRows } from "./identity";
import { recoverMerchant } from "./merchant-description";
import type { StatementResult } from "./statements";
import { BANK_REFERENCE_PREFIX } from "./bank-identity";
import { TRADE_REPUBLIC_BANK, TRADE_REPUBLIC_POCKET } from "./trade-republic";
export { accountIdentity, coveredUntilByAccount, isBankSyncRow, BANK_REFERENCE_PREFIX } from "./bank-identity";

export const BANK_SYNC_FORMAT = "finanzblick-bank-sync";
export const BANK_SYNC_MARKER = "Bankverbindung (XS2A)";
const PROVIDER_MARKERS = { xs2a: BANK_SYNC_MARKER, enablebanking: "Bankverbindung (Enable Banking)" } as const;

const turnoverSchema = z.object({
  booking_date: z.string().min(10),
  amount: z.number().finite(),
  currency_id: z.string().nullish(),
  currency: z.string().nullish(),
  purpose: z.array(z.string()).or(z.string()).nullish(),
  counter_iban: z.string().nullish(),
  counter_bic: z.string().nullish(),
  counter_holder: z.string().nullish(),
  prebooked: z.boolean().nullish(),
  canceled: z.boolean().nullish(),
  creditor_id: z.string().nullish(),
  transaction_id: z.string().max(200).nullish(),
}).passthrough();

export const bankSyncAccountSchema = z.object({
  id: z.string().min(1).max(200),
  bankName: z.string().max(200).nullish(),
  bic: z.string().max(20).nullish(),
  iban: z.string().max(50).nullish(),
  description: z.string().max(200).nullish(),
  type: z.string().max(50).nullish(),
  /** Pocket assigned to this bank account (matched against existing CSV pockets). */
  pocket: z.string().min(1).max(100).nullish(),
  /** Bookings on or before this date are already covered by other imports for this account. */
  coveredUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  turnovers: z.array(turnoverSchema).max(MAX_STATEMENT_ROWS),
});

export const bankSyncFileSchema = z.object({
  format: z.literal(BANK_SYNC_FORMAT),
  version: z.literal(1),
  provider: z.enum(["xs2a", "enablebanking"]),
  fetchedAt: z.string(),
  accounts: z.array(bankSyncAccountSchema).max(100),
});

export type BankSyncFile = z.infer<typeof bankSyncFileSchema>;
export type BankSyncAccount = z.infer<typeof bankSyncAccountSchema>;
type Turnover = z.infer<typeof turnoverSchema>;

export function isBankSyncName(name: string): boolean {
  return /\.bank\.json$/i.test(name);
}

const compact = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/**
 * PayPal only shows the shop behind payments that Raiffeisen, Revolut or the card already book as "…/PAYPAL",
 * so its bookings name those payments instead of being imported a second time.
 */
export function isPaypalAccount(account: { bankName?: string | null; bic?: string | null }): boolean {
  return /pay\s*pal/i.test(compact(account.bankName)) || /^PPLX/i.test(compact(account.bic));
}

/** Maps a bank account to the bank/pocket names the dashboard already uses for CSV imports. */
export function bankAccountTarget(account: Pick<BankSyncAccount, "bankName" | "bic" | "description" | "iban"> & { pocket?: string | null }): { bank: string; pocket: string | null } {
  const assigned = compact(account.pocket);
  if (assigned) return { bank: bankAccountTarget({ ...account, pocket: null }).bank, pocket: assigned.slice(0, 100) };
  const bankName = compact(account.bankName);
  const bic = compact(account.bic).toUpperCase();
  const description = compact(account.description);
  if (/raiffeisen/i.test(bankName) || /^(RZ|RLB|RVS)[A-Z]{2}/.test(bic)) {
    const savings = /spar|online.?sparen|sparbuch/i.test(description);
    return savings ? { bank: "Raiffeisen", pocket: description.slice(0, 100) } : { bank: "Raiffeisen", pocket: RAIFFEISEN_ACCOUNT };
  }
  if (/revolut/i.test(bankName) || /^REVO/.test(bic)) return { bank: "Revolut", pocket: "Persönliches Konto" };
  if (isPaypalAccount(account)) return { bank: "PayPal", pocket: "PayPal" };
  if (/trade\s*republic/i.test(bankName) || /^TRBK/.test(bic)) return { bank: TRADE_REPUBLIC_BANK, pocket: TRADE_REPUBLIC_POCKET };
  const bank = (bankName || bic || "Bank").slice(0, 100);
  const ibanTail = compact(account.iban).replace(/\s/g, "").slice(-4);
  return { bank, pocket: (description || (ibanTail ? `Konto …${ibanTail}` : "Girokonto")).slice(0, 100) };
}

function purposeLines(turnover: Turnover): string[] {
  const raw = Array.isArray(turnover.purpose) ? turnover.purpose : turnover.purpose ? [turnover.purpose] : [];
  return raw.map(compact).filter(Boolean).slice(0, 15).map((line) => line.slice(0, 1000));
}

/**
 * Trade Republic shares only date and amount over PSD2. Its monthly interest is a small credit on the first
 * days of the month and gets the CSV export's text, so the usual rules sort it; anything else stays recognisable.
 */
function textlessDescription(bank: string, date: string, amount: number): string {
  if (bank !== TRADE_REPUBLIC_BANK) return "Bankumsatz";
  if (amount > 0 && amount < 100 && Number(date.slice(8, 10)) <= 2) return "Zinsgutschrift Trade Republic";
  return "Trade Republic · Umsatz ohne Buchungstext";
}

export function parseBankSync(bytes: Uint8Array, file: string): StatementResult {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Die Bankabruf-Datei ist kein gültiges JSON.");
  }
  const parsed = bankSyncFileSchema.safeParse(json);
  if (!parsed.success) throw new Error("Die Bankabruf-Datei hat ein unbekanntes Format.");
  const result: StatementResult = { source: "Bank", file, rows: [], skipped: 0, issues: [] };
  const seen = new Map<string, number>();
  for (const account of parsed.data.accounts) {
    const target = bankAccountTarget(account);
    account.turnovers.forEach((turnover, index) => {
      const line = index + 1;
      const date = turnover.booking_date.slice(0, 10);
      if (turnover.prebooked || turnover.canceled || turnover.amount === 0) {
        result.skipped++;
        return;
      }
      if (account.coveredUntil && date <= account.coveredUntil) {
        result.skipped++;
        return;
      }
      const purpose = purposeLines(turnover);
      const holder = compact(turnover.counter_holder).slice(0, 200);
      const description = (compact([holder, purpose.join(" ")].filter(Boolean).join(" · ")) || textlessDescription(target.bank, date, turnover.amount)).slice(0, 1000);
      const amount = round(turnover.amount);
      const transactionId = compact(turnover.transaction_id);
      const fingerprint = transactionId
        ? ["tx", account.id, transactionId].join("\u0001")
        : [account.id, date, amount.toFixed(2), purpose.join("|"), compact(turnover.counter_iban), holder].join("\u0001");
      const hash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
      const repeat = (seen.get(hash) ?? 0) + 1;
      seen.set(hash, repeat);
      const bankReference = `${BANK_REFERENCE_PREFIX}${hash}${repeat > 1 ? `#${repeat}` : ""}`;
      const rawDetails = [
        ...purpose,
        ...(turnover.counter_iban ? [`IBAN ${compact(turnover.counter_iban)}`] : []),
        ...(turnover.creditor_id ? [`Gläubiger-ID ${compact(turnover.creditor_id)}`] : []),
        PROVIDER_MARKERS[parsed.data.provider],
      ].slice(0, 20);
      const currency = compact(turnover.currency_id ?? turnover.currency ?? "EUR").toUpperCase() || "EUR";
      if (currency !== "EUR") {
        result.issues.push({
          file, line,
          message: `Fremdwährung ${currency}: nicht als Euro importiert.`,
          action: "reupload", reason: "foreign-currency",
          evidence: `${date} · ${amount} ${currency} · ${description}`.slice(0, 2000),
        });
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        result.issues.push({ file, line, message: "Ungültiges Buchungsdatum vom Bankabruf." });
        return;
      }
      const candidate = transactionSchema.safeParse(recoverMerchant({
        id: crypto.randomUUID(),
        date,
        bank: target.bank,
        pocket: target.pocket,
        description,
        rawDetails,
        bankReference,
        category: "Prüfen",
        amount,
        includeInPlan: true,
      }));
      if (!candidate.success) {
        result.issues.push({ file, line, message: candidate.error.issues.map((issue) => issue.message).join(", ") });
        return;
      }
      result.rows.push(candidate.data);
      if (result.rows.length > MAX_STATEMENT_ROWS) throw new Error("Ein Import darf höchstens 100.000 Buchungen enthalten.");
    });
  }
  result.rows = numberStatementRows(classifyStatementRows(result.rows));
  return result;
}
