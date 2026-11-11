import { currency, monthLabel } from "@/lib/format";
import { analyzePayrollAutomatically, successBonusPercent } from "@/lib/payroll-analysis";
import { payrollBreakdown } from "@/lib/payroll-overview";
import { payrollPattern } from "@/lib/payroll-pattern";
import { sixthPaymentLabel, type SixthPayment, type SixthPaymentKind } from "@/lib/payroll-sixth";
import { payslipIncome } from "@/lib/payslip-income";
import { isReferencePayslip, payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";
import { salaryForecast } from "@/lib/salary-forecast";
import type { AppState } from "@/lib/types";
import { marginalTaxRate, wageTaxValues, WERBUNGSKOSTEN_PAUSCHALE } from "@/lib/wage-tax-at";
import type { AgentResult } from "./agent";

// "Wie viel netto bekomme ich im Dezember?", "Was bleibt vom Weihnachtsgeld?", "Wie viel vom Successbonus wird voll versteuert?"
const payslipWords = /lohnzettel|lohnabrechnung|gehaltsabrechnung|gehaltszettel|sonderzahlung|urlaubszuschuss|urlaubsgeld|weihnachtsgeld|weihnachtsremuneration|jahressechstel|\bsechstel|successbonus|\b1[34]\.\s*(?:gehalt|monatsgehalt)/;
const salaryWords = /\b(?:gehalt|gehalts\w*|lohn|brutto|netto)\b/;
const askingWords = /\b(?:wie ?viel|wie hoch|was|wann|welche\w*|bekomm\w*|krieg\w*|verdien\w*|bleib\w*|abzüge|abzuege|abgezogen|steuer\w*|versteuer\w*|zeig|erklär\w*)\b/;
// A bonus is a payroll question once its taxes or net are asked for ("Wie viel Steuer zahle ich auf meine Prämie?").
const bonusTax = (lower: string) => /\b(?:prämie|praemie|bonus|successbonus)\w*/.test(lower) &&
  /steuer|versteuer|netto|brutto|abzüg|abzug|bleibt|\bwann\b.*\bkommt|\bwie hoch\b/.test(lower);
// "Warum zahle ich so viel Lohnsteuer?" is about the payslip; deductions for the tax return stay with the tax folder.
const wageTax = (lower: string) => /\blohnsteuer\b|\bsozialversicherung\b/.test(lower) &&
  !/arbeitnehmerveranlagung|steuerausgleich|absetz|werbungskosten|sonderausgaben|finanzonline|steuer-?mappe|zurück/.test(lower);
// "Kann man mit 3000 netto gut leben?" asks about people in general, not about the own payslip.
const generic = (lower: string) => /\bman\b/.test(lower) && !/\b(?:ich|mir|mich|mein\w*|wir|uns|unser\w*)\b/.test(lower);
export const payrollQuestion = (lower: string) =>
  !/\b(?:merk|vergiss|nettovermögen|schon (?:da|gekommen|eingegangen|drauf))\b/.test(lower) && !generic(lower) &&
  (payslipWords.test(lower) || salaryWords.test(lower) && askingWords.test(lower) || bonusTax(lower) ||
    wageTax(lower) && (askingWords.test(lower) || /\b(?:warum|wieso|weshalb|zahl\w*)\b/.test(lower)));

// Plain explanations of the payroll terms; the user's own value follows right after.
const glossary: { pattern: RegExp; text: string; own?: "sixth" | "latest" }[] = [
  { pattern: /jahressechstel|\bsechstel/, text: "Das Jahressechstel ist die Grenze für begünstigte Sonderzahlungen: ein Sechstel der laufenden Bezüge des Jahres, " +
    "also etwa zwei Monatsgehälter. Darin sind nach der Sozialversicherung 620 € steuerfrei, der Rest kostet 6 %; was darüber liegt, wird wie laufendes Gehalt versteuert.", own: "sixth" },
  { pattern: /\bbrutto\b.*\bnetto\b|\bnetto\b.*\bbrutto\b/, text: "Brutto ist dein Gehalt vor allen Abzügen, netto das, was nach Sozialversicherung und Lohnsteuer aufs Konto kommt.", own: "latest" },
  { pattern: /sonderzahlung|urlaubszuschuss|weihnachts|\b1[34]\.\s*(?:gehalt|monatsgehalt)/, text: "Sonderzahlungen sind das 13. und 14. Gehalt (Urlaubszuschuss und Weihnachtsremuneration) " +
    "und Prämien wie der Successbonus. Im Jahressechstel werden sie begünstigt versteuert: 620 € frei, dann 6 %." },
  { pattern: /überstunde|ueberstunde/, text: "Überstunden selbst werden wie dein normales Gehalt versteuert. Begünstigt sind nur die Zuschläge " +
    "(meist 50 %): Für die ersten Überstunden im Monat bleiben sie bis zu einem gesetzlichen Höchstbetrag steuerfrei (§ 68 EStG), " +
    "darüber werden auch sie normal versteuert. Wie viel das bei dir ausmacht, steht auf der Abrechnung." },
  { pattern: /\blohnsteuer\b/, text: "Die Lohnsteuer in Österreich ist progressiv: Jeder Einkommensteil wird mit seinem eigenen Satz besteuert, von 0 bis 55 %, " +
    "Absetzbeträge wie der Verkehrsabsetzbetrag senken sie danach direkt. Steuerklassen gibt es nicht." },
];
const definitionWords = /\b(?:was (?:ist|sind|bedeutet|bedeuten|heißt|heisst)|unterschied|erklär\w*|definition|bedeutung)\b/;
// "Werden Überstunden anders versteuert?" is a rule question as well, even without "Was ist …".
const ruleQuestion = (lower: string) => /überstunde|ueberstunde/.test(lower) && /steuer|versteuer|steuerfrei|netto|brutto/.test(lower);
const definition = (lower: string) => (definitionWords.test(lower) || ruleQuestion(lower)) && !/\b(?:mein\w*|ich|mir|mich)\b/.test(lower)
  ? glossary.find((entry) => entry.pattern.test(lower)) : undefined;
/** "Was ist das Jahressechstel?", "Unterschied zwischen Brutto und Netto?": payroll terms explained, not looked up. */
export const payrollTermQuestion = (lower: string) => !!definition(lower);

// The special payment a question names; a bonus question also finds the Successbonus.
const askedKinds = (lower: string): SixthPaymentKind[] | undefined =>
  /weihnacht/.test(lower) ? ["christmas"] : /urlaubs(?:zuschuss|geld)/.test(lower) ? ["holiday"]
    : /success/.test(lower) ? ["successBonus"] : /\b(?:bonus|prämie|praemie)\w*/.test(lower) ? ["successBonus", "bonus"] : undefined;

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
  return { latest, net: income?.net ?? breakdown.net, breakdown, next, payments: analysis.specialPayments, sixth: analysis.actual?.sixth };
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

const masculine = (kind: SixthPaymentKind) => kind === "holiday" || kind === "successBonus";
const article = (kind: SixthPaymentKind) => masculine(kind) ? "der" : "die";

/**
 * Salary answer focused on the question: a named special payment, the wage tax, a payroll term, or otherwise the
 * latest payslip with the next special payment and the Jahressechstel.
 */
export function payrollAnswer(state: AppState, text = ""): AgentResult {
  const lower = text.toLowerCase();
  const term = definition(lower);
  const page = { label: "Gehalt & Steuern öffnen", href: "/gehalt-steuern" };
  const view = payrollView(state);
  if (!view) return {
    text: `${term ? `${term.text} ` : ""}Ich habe noch keine Lohnabrechnung von dir. Lade sie unter Gehalt & Steuern hoch, dann sage ich dir Netto, Abzüge und was von Sonderzahlungen bleibt.`,
    card: { kind: "answer", title: "Gehalt & Steuern", lines: [{ label: "Noch keine Abrechnung", detail: "PDF-Upload unter Gehalt & Steuern" }], page },
  };
  const { latest, net, breakdown, payments, sixth } = view;
  const kinds = askedKinds(lower);
  const matching = kinds ? payments.filter((payment) => kinds.includes(payment.kind)) : [];
  // The asked payment: the next planned one, otherwise the last one on a payslip.
  const asked = matching.find((payment) => payment.source === "forecast") ?? matching.at(-1);
  const next = asked ?? view.next;
  const month = monthLabel(period(latest.year, latest.month));
  const latestText = net !== undefined
    ? `Deine letzte Abrechnung (${month}) bringt ${currency(net)} netto aus ${currency(breakdown.gross)} brutto, ausgezahlt im ${monthLabel(payout(latest))}.`
    : `Deine letzte Abrechnung (${month}) hat ${currency(breakdown.gross)} brutto.`;
  const paymentText = (payment: SixthPayment) => `${masculine(payment.kind) ? "Der" : "Die"} ${sixthPaymentLabel[payment.kind]} ` +
    `${payment.source === "forecast" ? "kommt voraussichtlich" : "kam"} mit der ${monthName(payment.month)}-Abrechnung ` +
    `(ausgezahlt im ${monthName(payment.month === 12 ? 1 : payment.month + 1)}): ${currency(payment.tax.gross)} brutto, ` +
    `${splitText(payment).replace(" · ", ", ")}. Netto bleiben etwa ${currency(payment.tax.net)}.`;
  const base = latest.monthlyTaxableBase ?? (breakdown.sv !== undefined ? breakdown.gross - breakdown.sv : undefined);
  const rate = base !== undefined ? marginalTaxRate(base * 12 - WERBUNGSKOSTEN_PAUSCHALE, latest.year) : undefined;
  const taxQuestion = wageTax(lower) && breakdown.tax !== undefined && breakdown.gross > 0;
  let lead: string;
  if (asked) lead = paymentText(asked);
  else if (kinds) lead = `${masculine(kinds[0]) ? "Einen" : "Eine"} ${sixthPaymentLabel[kinds[0]]} finde ich weder in deinen Abrechnungen ` +
    `noch in der Prognose. ${latestText}`;
  else if (term) lead = term.own === "sixth" && sixth !== undefined ? `${term.text} Bei dir liegt es derzeit bei ${currency(sixth)}.`
    : term.own === "latest" ? `${term.text} ${latestText}` : term.text;
  else if (taxQuestion) lead = `Von ${currency(breakdown.gross)} brutto gehen bei dir ${currency(breakdown.tax!)} Lohnsteuer ab, ` +
    `rund ${Math.round(breakdown.tax! / breakdown.gross * 100)} %. ` +
    (rate ? `Der Tarif ist progressiv: Die ersten ${currency(wageTaxValues(latest.year).brackets[0])} im Jahr bleiben steuerfrei, ` +
      `jeder zusätzliche Euro wird bei dir aber mit ${Math.round(rate * 100)} % besteuert. ` : "") +
    "Absetzbeträge senken die Steuer, Steuerklassen gibt es in Österreich nicht.";
  else lead = latestText;
  const nextText = !asked && !term && !kinds && !taxQuestion && next
    ? ` Als Nächstes kommt ${article(next.kind)} ${sixthPaymentLabel[next.kind]} mit der ${monthName(next.month)}-Abrechnung: ${specialText(next)}.` : "";
  const lines = [
    ...(net !== undefined ? [{ label: "Netto", value: net }] : []),
    { label: "Brutto", value: breakdown.gross },
    ...(breakdown.tax !== undefined ? [{ label: "Lohnsteuer", value: breakdown.tax }] : []),
    ...(breakdown.sv !== undefined ? [{ label: "Sozialversicherung", value: breakdown.sv }] : []),
    ...(next ? [{ label: `${asked?.source === "payslip" ? "Sonderzahlung" : "Nächste Sonderzahlung"} · ${sixthPaymentLabel[next.kind]}`, value: next.tax.gross,
      detail: `${splitText(next)} · etwa ${currency(next.tax.net)} netto` }] : []),
    ...(sixth !== undefined ? [{ label: "Jahressechstel", value: sixth }] : []),
  ];
  return { text: `${lead}${nextText}`, card: { kind: "answer", title: asked ? sixthPaymentLabel[asked.kind] : `Gehalt · ${month}`, lines, page } };
}
