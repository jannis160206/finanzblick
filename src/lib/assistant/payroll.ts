import { currency, monthLabel } from "@/lib/format";
import { analyzePayrollAutomatically, successBonusPercent } from "@/lib/payroll-analysis";
import { payrollBreakdown } from "@/lib/payroll-overview";
import { payrollPattern } from "@/lib/payroll-pattern";
import { sixthPaymentLabel, type SixthPayment, type SixthPaymentKind } from "@/lib/payroll-sixth";
import { payslipIncome } from "@/lib/payslip-income";
import { isReferencePayslip, payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";
import { salaryForecast } from "@/lib/salary-forecast";
import type { AppState } from "@/lib/types";
import { FAMILY_BONUS, marginalTaxRate, monthlyWageTax, wageTaxValues, WERBUNGSKOSTEN_PAUSCHALE } from "@/lib/wage-tax-at";
import type { AgentResult } from "./agent";

// "Wie viel netto bekomme ich im Dezember?", "Was bleibt vom Weihnachtsgeld?", "Wie viel vom Successbonus wird voll versteuert?"
const payslipWords = /grenzsteuersatz|steuersatz|steuerstufe|steuerklasse|verkehrsabsetzbetrag|familienbonus|absetzbetrag|lohnzettel|lohnabrechnung|gehaltsabrechnung|gehaltszettel|sonderzahlung|urlaubszuschuss|urlaubsgeld|weihnachtsgeld|weihnachtsremuneration|jahressechstel|\bsechstel|successbonus|\b1[34]\.\s*(?:gehalt|monatsgehalt)/;
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
// "Wie viel Gehalt ist im Oktober reingekommen?" asks about a booking that already happened.
const received = (lower: string) => /\b(?:rein|herein|ein)gekommen\b|\beingegangen\b|\bgutgeschrieben\b|\bhab(?:e)? ich\b.*\b(?:bekommen|erhalten|kassiert)\b/.test(lower);
export const payrollQuestion = (lower: string) =>
  !/\b(?:merk|vergiss|nettovermögen|schon (?:da|gekommen|eingegangen|drauf))\b/.test(lower) && !generic(lower) && !received(lower) &&
  (payslipWords.test(lower) || salaryWords.test(lower) && askingWords.test(lower) || bonusTax(lower) ||
    wageTax(lower) && (askingWords.test(lower) || /\b(?:warum|wieso|weshalb|zahl\w*)\b/.test(lower)));

// Plain explanations of the payroll terms; the user's own value follows right after.
const glossary: { pattern: RegExp; text: string | ((year: number) => string); own?: "sixth" | "latest" | "rate" }[] = [
  { pattern: /verkehrsabsetzbetrag/, text: (year) => `Der Verkehrsabsetzbetrag steht allen Arbeitnehmern zu und wird direkt von der Lohnsteuer abgezogen: ` +
    `${currency(wageTaxValues(year).trafficCredit)} im Jahr ${year}. Der Arbeitgeber berücksichtigt ihn schon bei jeder Abrechnung.` },
  { pattern: /familienbonus/, text: `Der Familienbonus Plus senkt die Lohnsteuer direkt: bis zu ${currency(FAMILY_BONUS.child)} im Jahr pro Kind unter 18 ` +
    `und ${currency(FAMILY_BONUS.adult)} ab 18, solange Familienbeihilfe bezogen wird. Beantragen kannst du ihn beim Arbeitgeber oder in der Arbeitnehmerveranlagung.` },
  { pattern: /(?<![\p{L}])absetzbetr/u, text: "Ein Absetzbetrag wird direkt von der Steuer abgezogen – anders als Werbungskosten oder Sonderausgaben, " +
    "die nur das zu versteuernde Einkommen senken. Beispiele in Österreich: Verkehrsabsetzbetrag, Familienbonus Plus, Alleinverdiener- und Pensionistenabsetzbetrag." },
  { pattern: /steuerklasse/, text: "Steuerklassen gibt es in Österreich nicht. Die Lohnsteuer folgt einem progressiven Tarif für alle, " +
    "die Familiensituation zählt über Absetzbeträge wie den Familienbonus Plus." },
  { pattern: /grenzsteuersatz|steuersatz|steuerstufe/, text: "Der Grenzsteuersatz ist der Satz, mit dem jeder zusätzliche Euro besteuert wird – in Österreich 0 bis 55 %. " +
    "Er liegt immer über dem Durchschnittssatz, den du auf dein ganzes Gehalt zahlst.", own: "rate" },
  { pattern: /arbeitnehmerveranlagung|steuerausgleich|(?:geld|etwas|was) (?:vom|beim) finanzamt zurück|vom finanzamt (?:geld )?zurück/, text: "Geld zurück gibt es über die Arbeitnehmerveranlagung, " +
    "wenn im Jahr zu viel Lohnsteuer abgezogen wurde – etwa bei Werbungskosten über 132 €, Sonderausgaben, Pendlerpauschale, Familienbonus Plus " +
    "oder wenn sich das Gehalt unterm Jahr geändert hat. Einreichen geht bis zu fünf Jahre rückwirkend über FinanzOnline." },
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
// Terms that are explained even in a personal question ("Bekomme ich Geld vom Finanzamt zurück?").
const alwaysExplained = /verkehrsabsetzbetrag|familienbonus|steuerklasse|finanzamt zurück|vom finanzamt/;
const definition = (lower: string) => (definitionWords.test(lower) || ruleQuestion(lower)) && !/\b(?:mein\w*|ich|mir|mich)\b/.test(lower) ||
  alwaysExplained.test(lower) && !/\b(?:mein\w*)\b/.test(lower) ? glossary.find((entry) => entry.pattern.test(lower)) : undefined;
/** "Was ist das Jahressechstel?", "Unterschied zwischen Brutto und Netto?": payroll terms explained, not looked up. */
export const payrollTermQuestion = (lower: string) => !!definition(lower);

// The special payment a question names; a bonus question also finds the Successbonus.
const askedKinds = (lower: string): SixthPaymentKind[] | undefined =>
  /weihnacht/.test(lower) ? ["christmas"] : /urlaubs(?:zuschuss|geld)/.test(lower) ? ["holiday"]
    : /success/.test(lower) ? ["successBonus"] : /\b(?:bonus|prämie|praemie)\w*/.test(lower) ? ["successBonus", "bonus"] : undefined;

const period = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;
const monthName = (month: number) => new Intl.DateTimeFormat("de-AT", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, month - 1, 15)));
const payout = (entry: Pick<Payslip, "year" | "month">) => entry.month === 12 ? period(entry.year + 1, 1) : period(entry.year, entry.month + 1);

// The latest payslip up to today; a payslip dated after today (wrong import, test data) never counts as "latest".
function latestPayslip(state: AppState, today = state.settings.asOf): Payslip | undefined {
  const sorted = (state.payslips ?? []).filter((entry) => !isReferencePayslip(entry))
    .sort((left, right) => left.year - right.year || left.month - right.month);
  return sorted.filter((entry) => period(entry.year, entry.month) <= today.slice(0, 7)).at(-1) ?? sorted.at(-1);
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

const payslipsOf = (state: AppState, latest: Payslip) => (state.payslips ?? []).filter((entry) => !isReferencePayslip(entry) && entry.year === latest.year &&
  payrollEmployerKey(entry.employer) === payrollEmployerKey(latest.employer));
// "Gehaltserhöhung von 200 € brutto", "200 € mehr brutto": the monthly raise.
const raiseOf = (lower: string) => {
  if (!/gehaltserhöhung|gehaltserhoehung|lohnerhöhung|erhöhung|mehr brutto|mehr gehalt|brutto mehr/.test(lower)) return undefined;
  const value = Number(/(\d{2,5}(?:[.,]\d{1,2})?)\s*(?:€|euro|eur)?/.exec(lower)?.[1]?.replace(",", "."));
  return value > 0 ? value : undefined;
};
const monthNames = ["jänner", "februar", "märz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];
// The next month of that name, as the budget month the salary arrives in; asked in the past tense, the last one.
const askedMonth = (lower: string, today: string, past = false) => {
  const index = monthNames.findIndex((name) => new RegExp(`\\b(?:${name}${name === "jänner" ? "|januar" : ""})\\b`).test(lower));
  if (index < 0) return /nächste[nm]? monat/.test(lower) ? (Number(today.slice(5, 7)) === 12 ? `${Number(today.slice(0, 4)) + 1}-01` : period(Number(today.slice(0, 4)), Number(today.slice(5, 7)) + 1)) : undefined;
  const year = Number(today.slice(0, 4));
  const key = period(year, index + 1);
  if (past) return key <= today.slice(0, 7) ? key : period(year - 1, index + 1);
  return key < today.slice(0, 7) ? period(year + 1, index + 1) : key;
};
const pastTense = /\b(?:war|waren|hatte|hattest|bekam|kam|gab|verdient|bekommen hab\w*|ausgezahlt wurde|überwiesen wurde|eingegangen)\b/;
function forecastMonth(state: AppState, today: string, month: string) {
  try {
    return salaryForecast(state, { today }).months.find((entry) => entry.month === month);
  } catch {
    return undefined;
  }
}
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const masculine = (kind: SixthPaymentKind) => kind === "holiday" || kind === "successBonus";
const article = (kind: SixthPaymentKind) => masculine(kind) ? "der" : "die";

/**
 * Salary answer focused on the question: a named special payment, the wage tax, a payroll term, or otherwise the
 * latest payslip with the next special payment and the Jahressechstel.
 */
export function payrollAnswer(state: AppState, text = "", today = state.settings.asOf): AgentResult {
  const lower = text.toLowerCase();
  const found = definition(lower);
  const termYear = latestPayslip(state)?.year ?? Number(today.slice(0, 4));
  const term = found && { ...found, text: typeof found.text === "function" ? found.text(termYear) : found.text };
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
  const taxQuestion = wageTax(lower) && !/sozialversicherung/.test(lower) && breakdown.tax !== undefined && breakdown.gross > 0;
  const svQuestion = /sozialversicherung|\bsv\b|sv-?beitr/.test(lower) && breakdown.sv !== undefined && breakdown.gross > 0;
  const own = payslipsOf(state, latest);
  const yearTax = round(own.reduce((sum, entry) => sum + (entry.regularTax ?? 0) + (entry.specialTax ?? 0), 0));
  const yearly = taxQuestion && /\b(?:im|pro|aufs|das ganze|ganzen) jahr\b|jährlich|jaehrlich|\bheuer\b|\bbisher\b|insgesamt/.test(lower) && own.some((entry) => entry.regularTax !== undefined);
  const raise = raiseOf(lower);
  const past = pastTense.test(lower);
  const named = askedMonth(lower, today, past);
  const forecast = named && !past && /netto|bekomm|krieg|kommt|überwiesen|aufs konto|auszahl/.test(lower) ? forecastMonth(state, today, named) : undefined;
  // "Was war mein Netto im Oktober?": the payslip paid out in that month.
  const paid = past && named && named <= today.slice(0, 7) ? (state.payslips ?? []).filter((entry) => !isReferencePayslip(entry) &&
    payrollEmployerKey(entry.employer) === payrollEmployerKey(latest.employer) && payout(entry) === named).at(-1) : undefined;
  const paidNet = paid ? payslipIncome(paid, payrollPattern((state.payslips ?? []).filter((entry) => payrollEmployerKey(entry.employer) === payrollEmployerKey(latest.employer))))?.net
    ?? payrollBreakdown(paid).net : undefined;
  const farYear = Number(/\b(20[2-9]\d)\b/.exec(lower)?.[1] ?? 0);
  let lead: string;
  if (farYear > Number(today.slice(0, 4)) + 1) lead = `So weit voraus rechne ich nicht – bis ${farYear} ändern sich Gehalt, Tarif und Absetzbeträge. Stand heute: ${latestText}`;
  else if (asked) lead = paymentText(asked);
  else if (past && named && named <= today.slice(0, 7)) lead = paid && paidNet !== undefined
    ? `Im ${monthLabel(named)} kamen ${currency(paidNet)} netto aus der ${monthName(paid.month)}-Abrechnung (${currency(payrollBreakdown(paid).gross)} brutto).`
    : `Für ${monthLabel(named)} habe ich keine Lohnabrechnung. Was tatsächlich eingegangen ist, sagt dir „Wie viel Gehalt ist im ${monthLabel(named)} reingekommen?“. ${latestText}`;
  else if (forecast) lead = `Im ${monthLabel(forecast.month)} kommen voraussichtlich ${currency(forecast.total)} netto aufs Konto` +
    (forecast.special.amount > 0 ? `, davon ${currency(forecast.special.amount)} aus der Sonderzahlung.` : ".") +
    ` Grundlage ist deine letzte Abrechnung (${month}) und das gelernte Gehaltsmuster.`;
  else if (named && /netto|bekomm|krieg|kommt|überwiesen|aufs konto|auszahl/.test(lower)) {
    // Without a forecast month: the regular net of the latest payslip plus the special payment paid out that month.
    const payslipMonth = Number(named.slice(5, 7)) === 1 ? 12 : Number(named.slice(5, 7)) - 1;
    const special = payments.find((payment) => payment.source === "forecast" && payment.month === payslipMonth);
    lead = net !== undefined
      ? `Im ${monthLabel(named)} kommen voraussichtlich etwa ${currency(round(net + (special?.tax.net ?? 0)))} netto aufs Konto: ${currency(net)} laufendes Gehalt wie zuletzt` +
        (special ? ` plus etwa ${currency(special.tax.net)} aus ${article(special.kind) === "der" ? "dem" : "der"} ${sixthPaymentLabel[special.kind]}.` : ".")
      : `Für ${monthLabel(named)} habe ich noch keine Prognose. ${latestText}`;
  }
  else if (raise && base !== undefined && breakdown.sv !== undefined && breakdown.gross > 0) {
    const svShare = breakdown.sv / breakdown.gross;
    const extraSv = round(raise * svShare);
    const extraTax = round(monthlyWageTax(base + raise - extraSv, latest.year) - monthlyWageTax(base, latest.year));
    const extraNet = round(raise - extraSv - extraTax);
    lead = `Von ${currency(raise)} mehr brutto bleiben dir etwa ${currency(extraNet)} netto im Monat: ${currency(extraSv)} gehen an die Sozialversicherung, ` +
      `${currency(extraTax)} an die Lohnsteuer${rate ? ` (Grenzsteuersatz ${Math.round(rate * 100)} %)` : ""}. Urlaubszuschuss und Weihnachtsremuneration steigen mit.`;
  }
  else if (svQuestion) lead = `Von ${currency(breakdown.gross)} brutto gehen bei dir ${currency(breakdown.sv!)} Sozialversicherung ab, ` +
    `rund ${Math.round(breakdown.sv! / breakdown.gross * 100)} %. Sie deckt Kranken-, Pensions-, Unfall- und Arbeitslosenversicherung.`;
  else if (yearly) lead = `Laut ${own.length === 1 ? "deiner Abrechnung" : `deinen ${own.length} Abrechnungen`} ${latest.year} hast du bisher ${currency(yearTax)} Lohnsteuer gezahlt, ` +
    `zuletzt ${currency(breakdown.tax ?? 0)} im Monat auf das laufende Gehalt.`;
  else if (/grenzsteuersatz|steuersatz|steuerstufe/.test(lower) && rate !== undefined && (!term || /\bmein\w*\b/.test(lower))) lead = `Dein Grenzsteuersatz liegt bei ` +
    `${Math.round(rate * 100)} %: Jeder zusätzliche Euro Gehalt kostet dich so viel Lohnsteuer.` +
    (breakdown.tax !== undefined && breakdown.gross > 0 ? ` Im Schnitt zahlst du aber nur rund ${Math.round(breakdown.tax / breakdown.gross * 100)} % deines Bruttos.` : "");
  else if (/\bmein(?:e)?\s+(?:jahres)?sechstel\b|\bsechstel\b.*\bbei mir\b/.test(lower) && sixth !== undefined) lead = `Dein Jahressechstel liegt derzeit bei ${currency(sixth)}. ` +
    "Bis zu dieser Grenze werden Sonderzahlungen begünstigt versteuert: 620 € frei, darüber 6 %.";
  else if (/\bbrutto\b/.test(lower) && !/\bnetto\b/.test(lower) && !term) lead = `Brutto verdienst du ${currency(breakdown.gross)} im Monat (Abrechnung ${month})` +
    (net !== undefined ? `, netto bleiben ${currency(net)}.` : ".");
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
  const nextText = lead === latestText && !asked && !term && !kinds && !taxQuestion && next
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
