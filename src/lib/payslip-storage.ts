import { payslipKey, payslipSchema, type Payslip } from "@/lib/payslip-schema";

export type PayslipReview = { key: string; expected: Payslip | null }[];

export function capturePayslipReview(existing: Payslip[], incoming: Payslip[]): PayslipReview {
  return [...new Set(incoming.map(payslipKey))].map((key) => {
    const entry = existing.find((value) => payslipKey(value) === key);
    return { key, expected: entry ? payslipSchema.parse(entry) : null };
  });
}

export class PayslipMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayslipMutationError";
  }
}

export class PayslipChangedError extends PayslipMutationError {
  constructor() {
    super("Abrechnung inzwischen geändert oder entfernt. Bitte abbrechen und die aktuelle Abrechnung erneut prüfen bzw. die PDF erneut hochladen.");
    this.name = "PayslipChangedError";
  }
}

export function assertPayslipReview(existing: Payslip[], review: PayslipReview): void {
  for (const { key, expected } of review) {
    const matches = existing.filter((entry) => payslipKey(entry) === key);
    if (expected === null ? matches.length > 0
      : matches.length !== 1 ||
        JSON.stringify(payslipSchema.parse(matches[0])) !== JSON.stringify(expected))
      throw new PayslipChangedError();
  }
}

export function removeReviewedPayslip(existing: Payslip[], expected: Payslip): Payslip[] {
  const key = payslipKey(expected);
  assertPayslipReview(existing, [{ key, expected: payslipSchema.parse(expected) }]);
  return existing.filter((entry) => payslipKey(entry) !== key);
}

const netFields = ["netPay", "specialTax", "onCallGross", "holidayWorkGross"] as const;

function isEnrichment(old: Payslip, entry: Payslip): boolean {
  if (netFields.some((field) => old[field] !== undefined)) return false;
  const stripped = { ...entry };
  for (const field of netFields) delete stripped[field];
  return JSON.stringify(old) === JSON.stringify(payslipSchema.parse(stripped));
}

export function preparePayslipMerge(existing: Payslip[], incoming: Payslip[]) {
  const byKey = new Map(existing.map((entry) => [payslipKey(entry), entry]));
  const unique = new Map<string, Payslip>();
  let duplicates = 0;
  const conflicts: string[] = [];
  const changed: Payslip[] = [];
  for (const value of incoming) {
    const entry = payslipSchema.parse(value);
    const key = payslipKey(entry);
    const earlier = unique.get(key);
    if (earlier) {
      if (JSON.stringify(earlier) !== JSON.stringify(entry))
        throw new PayslipMutationError("Mehrere unterschiedliche Abrechnungen für denselben Arbeitgeber und Monat. Bitte nur die gültige Fassung übernehmen.");
      duplicates++;
      continue;
    }
    unique.set(key, entry);
    const old = byKey.get(key);
    if (old && JSON.stringify(payslipSchema.parse(old)) === JSON.stringify(entry)) {
      duplicates++;
      continue;
    }
    // Re-uploading an older stored payslip only adds the net-pay fields; that is no conflicting value.
    if (old && !isEnrichment(payslipSchema.parse(old), entry)) conflicts.push(key);
    byKey.set(key, entry);
    changed.push(entry);
  }
  if (byKey.size > 240) throw new PayslipMutationError("Es können höchstens 240 Lohnabrechnungen gespeichert werden.");
  return { entries: [...byKey.values()].sort((a, b) => payslipKey(a).localeCompare(payslipKey(b))), duplicates, conflicts, changed };
}
