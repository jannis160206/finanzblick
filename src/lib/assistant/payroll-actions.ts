import { currency, monthLabel } from "@/lib/format";
import { autoBudgetCorrections, heldPayslips, planPayrollBudget } from "@/lib/payroll-budget";
import type { Payslip } from "@/lib/payslip-schema";
import type { AppState, AssistantCard, AssistantOperation } from "@/lib/types";

/**
 * The payroll page by chat: check the stored payslips, take a held one into the budget ("Ins Budget übernehmen"),
 * remove one, and bring the budget up to date with the payslips, like the buttons on "Gehalt & Steuern".
 */
export type PayrollAction = "check" | "confirm" | "remove" | "sync" | "review_apply" | "review_keep";
export type PayrollPlan = { operations: AssistantOperation[]; title: string; note?: string } | { text: string; choices?: string[]; card?: AssistantCard };

// Payslips only: "Amex-Abrechnung", "Nebenkostenabrechnung" or "Kreditkartenabrechnung" are other statements.
const slip = /(?<![\p{L}-])(?:lohn|gehalts)?abrechnung\w*|(?<![\p{L}-])(?:jänner|jaenner|januar|feber|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)abrechnung\w*|lohnzettel\w*|gehaltszettel\w*|\bpayslips?\b/u;
const otherStatement = /amex|kreditkart|nebenkosten|betriebskosten|heizkosten|stromabrechnung|jahresabrechnung|handy|telefon/;
const months = ["jänner|januar|jaenner", "feber|februar", "märz|maerz", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "dezember"];
const monthOf = (entry: Pick<Payslip, "year" | "month">) => `${entry.year}-${String(entry.month).padStart(2, "0")}`;
const page = { label: "Gehalt & Steuern öffnen", href: "/gehalt-steuern" };

export function payrollActionRequest(lower: string): PayrollAction | undefined {
  if (otherStatement.test(lower) || /\b(?:buchung|umsatz|zahlung)\w*/.test(lower)) return undefined;
  if (/\b(?:prüf|pruef|check|kontrollier|überprüf|ueberpruef)\w*/.test(lower) && slip.test(lower) && !/\bbudgetwert/.test(lower)) return "check";
  if (slip.test(lower) && /\b(?:probleme?|fehler\w*|unstimmig\w*|widersprüch\w*|widerspruech\w*|widerspr\w*|zurückgehalten|zurueckgehalten|in ordnung|auffällig\w*|auffaellig\w*)\b/.test(lower)) return "check";
  // "Ist mein Budget aktuell zum Gehalt?": whether the budget follows the payslips.
  if (/\bbudget\b.{0,40}\b(?:aktuell|auf dem (?:neuesten |aktuellen )?stand|stimmt|passt)\b|\b(?:aktuell|stimmt|passt)\b.{0,30}\bbudget\b/.test(lower) && /\b(?:gehalt\w*|lohn\w*|abrechnung\w*)\b/.test(lower) && /\?\s*$|^(?:ist|stimmt|passt)\b/.test(lower)) return "check";
  if (/\?\s*$/.test(lower) || /^(?:wie|was|wann|warum|welche\w*|sind|ist|gibt|hab)\b/.test(lower)) return undefined;
  if (/\b(?:lösch|loesch|entfern)\w*/.test(lower) && slip.test(lower)) return "remove";
  if (slip.test(lower) && /\b(?:übernimm|uebernimm|übernehm\w*|uebernehm\w*|bestätig\w*|bestaetig\w*|freigeb\w*|gib\b.{0,40}\bfrei|ins budget|akzeptier\w*)/.test(lower)) return "confirm";
  if (/\bbudgetwerte?\b|\bwerte?\b.{0,20}\bzur prüfung\b/.test(lower)) {
    if (/\b(?:behalt\w*|beibehalt\w*|lass\w*|nicht übernehm\w*|nicht uebernehm\w*)/.test(lower)) return "review_keep";
    if (/\b(?:übernimm|uebernimm|übernehm\w*|uebernehm\w*|anwend\w*|schreib\w*|setz\w*)/.test(lower)) return "review_apply";
  }
  if (/\bbudget\b/.test(lower) && /\b(?:gehalt\w*|lohn\w*|abrechnung\w*|lohnzettel\w*)\b/.test(lower) &&
    /\b(?:aktualisier\w*|abgleich\w*|gleich\w*\b.{0,30}\bab\b|updat\w*|auf (?:den )?(?:neuesten |aktuellen )?stand|anpass\w*|synchronisier\w*|nachzieh\w*)/.test(lower)) return "sync";
  return undefined;
}

// A past month named in the text ("Oktober", "Oktober 2025"); without a year the latest one up to today.
function monthIn(lower: string, asOf: string): string | undefined {
  const index = months.findIndex((names) => new RegExp(`(?<![\\p{L}])(?:${names})(?![\\p{L}])`, "u").test(lower));
  if (index < 0) return undefined;
  const year = /\b(20\d{2})\b/.exec(lower)?.[1];
  const month = index + 1;
  const current = Number(asOf.slice(5, 7));
  const resolved = year ? Number(year) : month <= current ? Number(asOf.slice(0, 4)) : Number(asOf.slice(0, 4)) - 1;
  return `${resolved}-${String(month).padStart(2, "0")}`;
}

/** "Prüf meine Abrechnungen": what is held back from the budget and why, plus values waiting for review. */
export function payrollCheck(state: AppState): { text: string; card?: AssistantCard; choices?: string[]; suggestions?: string[] } {
  const payslips = state.payslips ?? [];
  if (!payslips.length) return { text: "Ich habe noch keine Lohnabrechnungen. Lade sie unter Gehalt & Steuern hoch, dann prüfe ich sie.",
    card: { kind: "answer", title: "Gehalt & Steuern", lines: [], page } };
  const held = heldPayslips(state);
  const { apply, review } = planPayrollBudget(state);
  const lines = held.slice(0, 12).map(({ entry, validation }) => ({ label: `${monthLabel(monthOf(entry))} · ${entry.employer}`.slice(0, 200),
    detail: validation.checks.filter((check) => check.level === "error").map((check) => check.message).join(" · ").slice(0, 300) || "Zahlen widersprechen sich", tone: "warn" as const }));
  const reviewText = (apply.length ? ` ${apply.length === 1 ? "Ein Budgetwert ist" : `${apply.length} Budgetwerte sind`} noch nicht auf dem Stand der Abrechnungen – das kann ich nachziehen.` : " Das Budget ist auf dem Stand der Abrechnungen.") +
    (review.length ? ` ${review.length === 1 ? "Ein Budgetwert wartet" : `${review.length} Budgetwerte warten`} noch auf deine Prüfung.` : "");
  const text = held.length
    ? `${held.length === 1 ? "Eine Abrechnung halte" : `${held.length} Abrechnungen halte`} ich aus dem Budget heraus, weil sich die Zahlen widersprechen. Wenn sie trotzdem stimmen, übernehme ich sie auf Zuruf ins Budget.${reviewText}`
    : `Alle ${payslips.length} Abrechnungen sind geprüft und im Budget – keine Widersprüche.${reviewText}`;
  const choices = [...held.slice(0, 2).map(({ entry }) => `Übernimm die Abrechnung ${monthLabel(monthOf(entry))} ins Budget`),
    ...(apply.length ? ["Aktualisier das Budget mit meinen Abrechnungen"] : []),
    ...(review.length ? ["Übernimm die Budgetwerte zur Prüfung", "Behalte die Budgetwerte"] : [])];
  return { text, card: { kind: "answer", title: held.length ? "Zurückgehaltene Abrechnungen" : "Lohnabrechnungen", lines, page },
    ...(choices.length ? { choices } : { suggestions: ["Wie viel netto bekomme ich?", "Was bleibt vom Weihnachtsgeld?"] }) };
}

export function payrollPlan(state: AppState, text: string, asOf: string, action: Exclude<PayrollAction, "check">): PayrollPlan {
  const lower = text.toLowerCase();
  const payslips = [...(state.payslips ?? [])].sort((a, b) => a.year - b.year || a.month - b.month);
  const month = monthIn(lower, asOf);
  const choose = (entries: Payslip[], verb: (label: string) => string) => entries.slice(-4).reverse().map((entry) => verb(monthLabel(monthOf(entry))));
  if (action === "confirm") {
    const held = heldPayslips(state).map((item) => item.entry);
    if (!held.length) return { text: "Es wartet keine Abrechnung auf Freigabe – alle sind schon im Budget." };
    const picked = month ? held.filter((entry) => monthOf(entry) === month) : held;
    if (month && !picked.length) return { text: payslips.some((entry) => monthOf(entry) === month)
      ? `Die Abrechnung ${monthLabel(month)} ist schon im Budget.` : `Eine Abrechnung für ${monthLabel(month)} finde ich nicht.` };
    if (picked.length > 1) return { text: "Welche Abrechnung soll ich ins Budget übernehmen?", choices: choose(picked, (label) => `Übernimm die Abrechnung ${label} ins Budget`) };
    const entry = picked[0];
    return { operations: [{ op: "payslip_confirm", year: entry.year, month: entry.month, employer: entry.employer }],
      title: `Abrechnung ${monthLabel(monthOf(entry))} ins Budget übernehmen`,
      note: "Ihre Zahlen widersprechen sich – übernimm sie nur, wenn sie trotzdem stimmen." };
  }
  if (action === "remove") {
    if (!payslips.length) return { text: "Es sind keine Lohnabrechnungen gespeichert." };
    const latest = /\b(?:letzte|neueste|jüngste|aktuelle)\b/.test(lower) ? payslips.at(-1) : undefined;
    const picked = latest ? [latest] : month ? payslips.filter((entry) => monthOf(entry) === month) : [];
    if (!month && !latest) return { text: "Welche Abrechnung soll ich entfernen? Nenn mir den Monat, z. B. „Lösch die Abrechnung Oktober 2026“.",
      choices: choose(payslips, (label) => `Lösch die Abrechnung ${label}`) };
    if (!picked.length) return { text: `Eine Abrechnung für ${monthLabel(month!)} finde ich nicht.`, choices: choose(payslips, (label) => `Lösch die Abrechnung ${label}`) };
    const employer = picked.filter((entry) => lower.includes(entry.employer.toLowerCase().split(/\s+/)[0]));
    if (picked.length > 1 && employer.length !== 1) return { text: `Für ${monthLabel(monthOf(picked[0]))} gibt es ${picked.length} Abrechnungen. Welche soll ich entfernen?`,
      choices: picked.slice(0, 4).map((entry) => `Lösch die Abrechnung ${monthLabel(monthOf(entry))} von ${entry.employer.split(/\s+/).slice(0, 3).join(" ")}`.slice(0, 120)) };
    const entry = employer.length === 1 ? employer[0] : picked[0];
    return { operations: [{ op: "payslip_remove", year: entry.year, month: entry.month, employer: entry.employer }],
      title: `Abrechnung ${monthLabel(monthOf(entry))} entfernen`, note: "Nur die gespeicherten Rechenwerte – Original-PDF und Kontoumsätze bleiben unverändert." };
  }
  if (action === "sync") {
    const plan = planPayrollBudget(state);
    if (plan.apply.length) return { operations: [{ op: "payroll_sync" }], title: "Budget an die Abrechnungen anpassen" };
    if (plan.review.length) return { text: `Das Budget ist auf dem Stand deiner Abrechnungen. ${plan.review.length === 1 ? "Ein Wert weicht" : `${plan.review.length} Werte weichen`} aber ab, weil du sie selbst geändert hast oder sie doppelt wären – soll ich sie trotzdem übernehmen?`,
      choices: ["Übernimm die Budgetwerte zur Prüfung", "Behalte die Budgetwerte"] };
    return { text: "Das Budget ist schon auf dem Stand deiner Abrechnungen." };
  }
  const { review } = autoBudgetCorrections(state);
  if (!review.length) return { text: "Es warten keine Budgetwerte auf deine Prüfung." };
  const total = review.reduce((sum, item) => sum + item.to - item.from, 0);
  return { operations: [{ op: "payroll_sync", review: action === "review_apply" ? "apply" : "keep" }],
    title: action === "review_apply" ? `${review.length === 1 ? "1 Budgetwert" : `${review.length} Budgetwerte`} übernehmen (${total >= 0 ? "+" : "−"}${currency(Math.abs(total))})`
      : `${review.length === 1 ? "1 Budgetwert" : `${review.length} Budgetwerte`} so lassen` };
}
