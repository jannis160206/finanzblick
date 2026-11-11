import { currency } from "@/lib/format";
import { payrollPattern } from "@/lib/payroll-pattern";
import { isReferencePayslip, payrollEmployerKey, payslipKey, type Payslip } from "@/lib/payslip-schema";

/** "error" keeps a payslip out of the budget until the user confirms it; "warning" and "info" are only logged. */
export type PayslipCheckLevel = "error" | "warning" | "info";
export type PayslipCheck = { id: string; level: PayslipCheckLevel; message: string };
export type PayslipValidation = {
  period: string;
  employer: string;
  /** No contradiction: the payslip may go into the budget automatically. */
  consistent: boolean;
  /** Findings, most severe first. */
  checks: PayslipCheck[];
  /** Checks that ran and fit. */
  passed: string[];
};

const cents = (value: number) => Math.round(value * 100);
const sum = (...values: (number | undefined)[]) => values.reduce<number>((total, value) => total + cents(value ?? 0), 0) / 100;
const period = (entry: Pick<Payslip, "year" | "month">) => `${entry.year}-${String(entry.month).padStart(2, "0")}`;
const index = (entry: Pick<Payslip, "year" | "month">) => entry.year * 12 + entry.month;
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const levelOrder: Record<PayslipCheckLevel, number> = { error: 0, warning: 1, info: 2 };
// Sonderzahlungen within the Jahressechstel: 6 % after SV, the first 620 € a year tax-free; small totals stay below the Freigrenze.
const SIXTH_RATE = 0.06;
const SIXTH_ALLOWANCE = 620;
const FREE_LIMIT = 2675;

/**
 * Checks that the numbers of one payslip fit together. Only clear arithmetic contradictions are errors: a printed net
 * that does not follow from gross minus deductions, transfers that do not add up to the net, gross components above the
 * gross, an impossible tax rate. Everything unusual but possible (an extra-hours month, a payment outside the usual
 * months, a tax above the sixth) is a warning or a hint. `history` are the other stored payslips, for patterns.
 */
export function validatePayslip(entry: Payslip, history: readonly Payslip[] = []): PayslipValidation {
  const checks: PayslipCheck[] = [];
  const passed: string[] = [];
  const add = (id: string, level: PayslipCheckLevel, message: string) => checks.push({ id, level, message });
  const bonus = entry.unresolvedSixthBonus ?? 0;
  const gross = sum(entry.regularGross, entry.specialGross, bonus);
  const net = entry.netPay;

  if (net !== undefined) {
    if (net <= 0 || cents(net) > cents(gross) + 100) add("net-range", "error", `Netto ${currency(net)} liegt außerhalb des Bruttos ${currency(gross)}.`);
    else passed.push("net-range");
  }

  const specialKnown = entry.specialGross === 0 || (entry.specialSv !== undefined && entry.specialTax !== undefined);
  const bonusKnown = !bonus || entry.specialSv !== undefined;
  if (net !== undefined && entry.regularSv !== undefined && entry.regularTax !== undefined && specialKnown && bonusKnown) {
    const rest = sum(gross, -entry.regularSv, -entry.regularTax, -(entry.specialSv ?? 0), -(entry.specialTax ?? 0), -net);
    const limit = Math.max(50, gross * 0.02);
    if (Math.abs(rest) > limit) {
      add("net-balance", "error", `Brutto − SV − Lohnsteuer ergibt ${currency(sum(net, rest))}, gedruckt sind ${currency(net)} Netto (Differenz ${currency(rest)}).`);
    } else if (Math.abs(rest) > 25) {
      add("net-balance", "warning", `${rest > 0 ? "Sonstige Abzüge" : "Sonstige steuerfreie Bezüge"} von ${currency(Math.abs(rest))} zwischen Brutto und Netto.`);
    } else passed.push("net-balance");
  }

  if (net !== undefined && entry.advancePay !== undefined && entry.payout !== undefined) {
    const rest = sum(net, -entry.advancePay, -entry.payout);
    if (rest < -1) add("transfers", "error", `Akonto und Auszahlung (${currency(sum(entry.advancePay, entry.payout))}) sind höher als das Netto ${currency(net)}.`);
    else if (rest > Math.max(50, net * 0.02)) add("transfers", "error", `Akonto und Auszahlung decken das Netto nicht: ${currency(rest)} fehlen.`);
    else passed.push("transfers");
  }

  const parts = sum(entry.baseSalary, entry.onCallGross, entry.holidayWorkGross);
  if (entry.baseSalary !== undefined || entry.onCallGross !== undefined || entry.holidayWorkGross !== undefined) {
    if (cents(parts) > cents(entry.regularGross) + 100) {
      add("components", "error", `Grundgehalt, Rufbereitschaft und Feiertagsarbeit (${currency(parts)}) übersteigen das laufende Brutto ${currency(entry.regularGross)}.`);
    } else passed.push("components");
  }

  if (entry.regularTax !== undefined) {
    const base = sum(entry.regularGross, bonus);
    if (base > 0 && entry.regularTax > base * 0.5) add("tax-rate", "error", `Lohnsteuer ${currency(entry.regularTax)} ist mehr als die Hälfte des laufenden Bruttos.`);
    else passed.push("tax-rate");
  }

  if (entry.regularSv !== undefined && entry.regularGross >= 600) {
    const rate = entry.regularSv / entry.regularGross;
    if (rate > 0.22 || (rate < 0.1 && entry.regularGross < 6000)) {
      add("sv-rate", "warning", `SV-Anteil von ${(rate * 100).toFixed(1).replace(".", ",")} % ist ungewöhnlich (üblich rund 18 %).`);
    } else passed.push("sv-rate");
  }

  if (entry.specialGross > 0 && entry.specialSv !== undefined && entry.specialTax !== undefined) {
    const base = Math.max(0, sum(entry.specialGross, -entry.specialSv));
    const low = Math.max(0, base - SIXTH_ALLOWANCE) * SIXTH_RATE;
    const high = base * SIXTH_RATE;
    const tax = entry.specialTax;
    if ((tax >= low - 1 && tax <= high + 1) || (tax === 0 && entry.specialGross <= FREE_LIMIT)) passed.push("special-sixth");
    else add("special-sixth", "warning", `Lohnsteuer der Sonderzahlung ${currency(tax)} entspricht nicht den 6 % im Jahressechstel (erwartet ${currency(low)}–${currency(high)}); ein Teil liegt vermutlich über dem Sechstel.`);
  }

  if (entry.reportedSixth !== undefined && entry.regularGrossYtd !== undefined && entry.month < 12) {
    const expected = entry.regularGrossYtd / entry.month * 2;
    if (Math.abs(entry.reportedSixth - expected) > Math.max(1, expected * 0.005)) {
      add("sixth", "warning", `Gedrucktes Jahressechstel ${currency(entry.reportedSixth)} weicht vom kumulierten Brutto ab (${currency(expected)}).`);
    } else passed.push("sixth");
  }

  const employer = payrollEmployerKey(entry.employer);
  const own = history.filter((other) => payrollEmployerKey(other.employer) === employer && payslipKey(other) !== payslipKey(entry));
  const before = own.filter((other) => index(other) < index(entry)).sort((a, b) => index(a) - index(b));
  const previous = before.at(-1);

  if (entry.regularGrossYtd !== undefined && previous?.regularGrossYtd !== undefined && previous.year === entry.year && index(previous) === index(entry) - 1) {
    const rest = sum(entry.regularGrossYtd, -previous.regularGrossYtd, -entry.regularGross);
    if (Math.abs(rest) > 1) add("ytd", "warning", `Kumuliertes Brutto passt nicht zum Vormonat (Differenz ${currency(rest)}).`);
    else passed.push("ytd");
  }

  if (previous?.baseSalary !== undefined && entry.baseSalary !== undefined && entry.baseSalary < previous.baseSalary * 0.99) {
    add("base-salary", "warning", `Grundgehalt ${currency(entry.baseSalary)} ist niedriger als zuvor (${currency(previous.baseSalary)}).`);
  }

  const pattern = payrollPattern([...own, entry]);
  const normal = pattern.normalOnCallGross;
  if (normal && (entry.onCallGross ?? 0) > normal * 2.5) {
    add("on-call", "warning", `Rufbereitschaft ${currency(entry.onCallGross!)} ist ein Vielfaches der üblichen Pauschale ${currency(normal)}; der Teil darüber zählt als Feiertagsarbeit.`);
  }

  if (entry.specialGross > 0) {
    const usual = new Set([6, 11, 12, ...own.filter((other) => other.specialGross > 0).map((other) => other.month)]);
    if (!usual.has(entry.month)) add("special-month", "warning", `Sonderzahlung ${currency(entry.specialGross)} außerhalb der üblichen Monate; bitte prüfen, ob es keine Rufbereitschaft oder Prämie ist.`);
    if (entry.baseSalary && entry.specialGross > entry.baseSalary * 2.5) {
      add("special-size", "warning", `Sonderzahlung ${currency(entry.specialGross)} ist mehr als das 2,5-Fache des Grundgehalts.`);
    }
  }

  const recent = own.filter((other) => index(other) > index(entry) - 13).map((other) => other.regularGross).filter((value) => value > 0);
  if (recent.length >= 3 && entry.regularGross > median(recent) * 1.5) {
    add("regular-spike", "info", `Laufendes Brutto ${currency(entry.regularGross)} liegt deutlich über dem Üblichen (${currency(median(recent))}) – viele Überstunden oder Feiertagsdienste.`);
  }

  checks.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);
  return { period: period(entry), employer: entry.employer, consistent: !checks.some((check) => check.level === "error"), checks, passed };
}

/** Validation of every incoming payslip against the stored ones (without its own earlier version). */
export function validatePayslips(entries: readonly Payslip[], stored: readonly Payslip[] = []): PayslipValidation[] {
  const incoming = new Set(entries.map(payslipKey));
  const history = [...stored.filter((entry) => !incoming.has(payslipKey(entry))), ...entries];
  return entries.map((entry) => validatePayslip(entry, history));
}

/** Stable fingerprint of a payslip's values: a confirmation applies to exactly these values. */
export function payslipFingerprint(entry: Payslip): string {
  const text = JSON.stringify(Object.keys(entry).sort().map((key) => [key, entry[key as keyof Payslip]]));
  let hash = 0x811c9dc5;
  for (let position = 0; position < text.length; position++) {
    hash ^= text.charCodeAt(position);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${payslipKey(entry)}#${hash.toString(16).padStart(8, "0")}`;
}

/**
 * The validation of a payslip that must not go into the budget automatically: it contradicts itself and the user has
 * not confirmed exactly these values. Reference payslips (2025) never go into the budget anyway.
 */
export function payslipHold(entry: Payslip, history: readonly Payslip[], confirmed: readonly string[] = []): PayslipValidation | undefined {
  if (isReferencePayslip(entry)) return undefined;
  const validation = validatePayslip(entry, history);
  if (validation.consistent || confirmed.includes(payslipFingerprint(entry))) return undefined;
  return validation;
}
