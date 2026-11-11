import { currency, monthLabel } from "@/lib/format";
import { analyzePayrollAutomatically, successBonusPercent } from "@/lib/payroll-analysis";
import { payrollBreakdown } from "@/lib/payroll-overview";
import { payrollPattern } from "@/lib/payroll-pattern";
import { sixthPaymentLabel, type SixthPayment } from "@/lib/payroll-sixth";
import { payslipIncome } from "@/lib/payslip-income";
import { isReferencePayslip, payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";
import { salaryForecast } from "@/lib/salary-forecast";
import type { AppState } from "@/lib/types";
import type { AgentResult } from "./agent";

// "Wie viel netto bekomme ich im Dezember?", "Was bleibt vom Weihnachtsgeld?", "Wie viel vom Successbonus wird voll versteuert?"
const payslipWords = /lohnzettel|lohnabrechnung|gehaltsabrechnung|gehaltszettel|sonderzahlung|urlaubszuschuss|urlaubsgeld|weihnachtsgeld|weihnachtsremuneration|jahressechstel|\bsechstel|successbonus|\b1[34]\.\s*(?:gehalt|monatsgehalt)/;
const salaryWords = /\b(?:gehalt|gehalts\w*|lohn|brutto|netto)\b/;
const askingWords = /\b(?:wie ?viel|wie hoch|was|wann|welche\w*|bekomm\w*|krieg\w*|verdien\w*|bleib\w*|abzüge|abzuege|abgezogen|steuer\w*|versteuer\w*|zeig|erklär\w*)\b/;
// A bonus is a payroll question once its taxes or net are asked for ("Wie viel Steuer zahle ich auf meine Prämie?").
const bonusTax = (lower: string) => /\b(?:prämie|praemie|bonus)\w*/.test(lower) && /steuer|versteuer|netto|brutto|abzüg|abzug|bleibt/.test(lower);
export const payrollQuestion = (lower: string) =>
  !/\b(?:merk|vergiss|nettovermögen|schon (?:da|gekommen|eingegangen|drauf))\b/.test(lower) &&
  (payslipWords.test(lower) || salaryWords.test(lower) && askingWords.test(lower) || bonusTax(lower));

const period = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
const monthName = (month: number) => new Intl.DateTimeFormat("de-AT", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, month - 1, 15)));
const payout = (entry: Pick<Payslip, "year" | "month">) => entry.month === 12 ? period(entry.year + 1, 1) : period(entry.year, entry.month + 1);

function latestPayslip(state: AppState): Payslip | undefined {
  return (state.payslips ?? []).filter((entry) => !isReferencePayslip(entry))
    .sort((left, right) => left.year - right.year || left.month - right.month).at(-1);
}

function payrollView(state: AppState) {
  const latest = latestPayslip(state);
  if (!latest) return undefined;
  const payslips = state.payslips ?? [];
  const own = payslips.filter((entry) => payrollEmployerKey(entry.employer) === payrollEmployerKey(latest.employer));
  const income = payslipIncome(latest, payrollPattern(own));
  const breakdown = payrollBreakdown(latest);
  const analysis = analyzePayrollAutomatically(payslips, latest.year >= 2027 ? 2027 : 2026, latest.employer,
    { successBonusPercent: successBonusPercent(state.settings) });
  const next: SixthPayment | undefined = analysis.specialPayments.find((payment) => payment.source === "forecast");
  return { latest, net: income?.net ?? breakdown.net, breakdown, next, sixth: analysis.actual?.sixth };
}

const specialText = (payment: SixthPayment) => {
  const { tax } = payment;
  if (tax.overflowGross <= 0) return `${currency(tax.gross)} brutto, ganz im Jahressechstel zu 6 %`;
  if (tax.eligibleGross <= 0) return `${currency(tax.gross)} brutto, ganz über dem Sechstel und voll versteuert`;
  return `${currency(tax.gross)} brutto: ${currency(tax.eligibleGross)} zu 6 %, ${currency(tax.overflowGross)} voll versteuert`;
};

// Only the parts that exist: "ganz zu 6 %", "ganz voll versteuert" or both amounts.
const splitText = ({ tax }: SixthPayment) => tax.overflowGross <= 0 ? "ganz im Sechstel zu 6 %"
  : tax.eligibleGross <= 0 ? "ganz voll versteuert" : `${currency(tax.eligibleGross)} zu 6 % · ${currency(tax.overflowGross)} voll versteuert`;

/** Finished salary numbers for the payroll specialist; the model only phrases them. */
export function payrollFacts(state: AppState, today: string) {
  const view = payrollView(state);
  if (!view) return { payslips: "Noch keine Lohnabrechnung hochgeladen." };
  const { latest, net, breakdown, next, sixth } = view;
  let upcoming: { month: string; net: number }[] = [];
  try {
    upcoming = salaryForecast(state, { today }).months.filter((month) => month.month >= today.slice(0, 7)).slice(0, 3)
      .map((month) => ({ month: monthLabel(month.month), net: month.total }));
  } catch {
    upcoming = [];
  }
  return {
    latestPayslip: {
      month: monthLabel(period(latest.year, latest.month)), paidOutIn: monthLabel(payout(latest)), gross: breakdown.gross,
      ...(net !== undefined ? { net } : {}), ...(breakdown.tax !== undefined ? { wageTax: breakdown.tax } : {}),
      ...(breakdown.sv !== undefined ? { socialSecurity: breakdown.sv } : {}),
    },
    nextSpecialPayment: next ? {
      name: sixthPaymentLabel[next.kind], payslipMonth: monthLabel(period(latest.year, next.month)), gross: next.tax.gross,
      inSixthAtSixPercent: next.tax.eligibleGross, fullyTaxed: next.tax.overflowGross, net: next.tax.net,
    } : null,
    jahressechstel: sixth ?? null,
    expectedNetPay: upcoming,
    taxLogic: "Österreich: progressiver Lohnsteuertarif mit Absetzbeträgen, keine Steuerklassen. Sonderzahlungen im Jahressechstel nach SV 620 € frei, dann 6 %, darüber nach Tarif.",
  };
}

/** Salary overview: latest payslip, the next special payment with its 6 % / tariff split, and the Jahressechstel. */
export function payrollAnswer(state: AppState): AgentResult {
  const page = { label: "Gehalt & Steuern öffnen", href: "/gehalt-steuern" };
  const view = payrollView(state);
  if (!view) return {
    text: "Ich habe noch keine Lohnabrechnung von dir. Lade sie unter Gehalt & Steuern hoch, dann sage ich dir Netto, Abzüge und was von Sonderzahlungen bleibt.",
    card: { kind: "answer", title: "Gehalt & Steuern", lines: [{ label: "Noch keine Abrechnung", detail: "PDF-Upload unter Gehalt & Steuern" }], page },
  };
  const { latest, net, breakdown, next, sixth } = view;
  const month = monthLabel(period(latest.year, latest.month));
  const lead = net !== undefined
    ? `Deine letzte Abrechnung (${month}) bringt ${currency(net)} netto aus ${currency(breakdown.gross)} brutto, ausgezahlt im ${monthLabel(payout(latest))}.`
    : `Deine letzte Abrechnung (${month}) hat ${currency(breakdown.gross)} brutto.`;
  const nextText = next ? ` Als Nächstes kommt ${next.kind === "holiday" || next.kind === "successBonus" ? "der" : "die"} ${sixthPaymentLabel[next.kind]} mit der ${monthName(next.month)}-Abrechnung: ${specialText(next)}.` : "";
  const lines = [
    ...(net !== undefined ? [{ label: "Netto", value: net }] : []),
    { label: "Brutto", value: breakdown.gross },
    ...(breakdown.tax !== undefined ? [{ label: "Lohnsteuer", value: breakdown.tax }] : []),
    ...(breakdown.sv !== undefined ? [{ label: "Sozialversicherung", value: breakdown.sv }] : []),
    ...(next ? [{ label: `Nächste Sonderzahlung · ${sixthPaymentLabel[next.kind]}`, value: next.tax.gross,
      detail: `${splitText(next)} · etwa ${currency(next.tax.net)} netto` }] : []),
    ...(sixth !== undefined ? [{ label: "Jahressechstel", value: sixth }] : []),
  ];
  return { text: `${lead}${nextText}`, card: { kind: "answer", title: `Gehalt · ${month}`, lines, page } };
}
