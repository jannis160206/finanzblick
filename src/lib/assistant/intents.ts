import { publicFactQuestion } from "./public-facts";
import type { AssistantTool } from "./tools";

/**
 * Free phrasings of the app's main actions. An action word and a subject, in any order and form, name one tool:
 * "erstelle vertrag", "mach mir einen Vertrag", "ich brauche einen neuen Vertrag", "Netflix als Abo speichern".
 * Small typos in the subject are tolerated ("vertarg", "sparzeil", "budegt"). Definition, advice and how-to questions
 * never match, so "Was ist ein Budget?" or "Soll ich einen neuen Handyvertrag machen?" keep their own route.
 */
export type IntentSubject = "contract" | "goal" | "budget" | "transactions" | "payroll";
export type IntentAction = "create" | "show" | "check" | "filter";
export type IntentFrame = { subject: IntentSubject; action?: IntentAction; tool: AssistantTool };

const fold = (value: string) => value.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9+]+/g, " ").trim();

const subjects: Record<IntentSubject, { pattern: RegExp; typos: string[] }> = {
  contract: {
    pattern: /\b(?:vertr(?:a|ae)g\w*|\w+vertrag\w*|abos?|abonnement\w*|mitgliedschaft\w*)\b/,
    typos: ["vertrag", "vertraege", "abonnement", "mitgliedschaft", "handyvertrag"],
  },
  goal: {
    pattern: /\bspar ?ziel\w*|\bsparen (?:fuer|auf)\b|\b(?:auf|fuer) (?:ein(?:en|e)? )?\w+ (?:\w+ )?sparen\b|\bzuruecklegen\b|\bneues ziel\b/,
    typos: ["sparziel", "sparziele"],
  },
  budget: {
    pattern: /\bbudget\w*|\bmonatsplan\w*|\bausgabenlimit\w*|\blimits?\b/,
    typos: ["budget", "budgets", "monatsplan"],
  },
  transactions: {
    pattern: /\bbuchung\w*|\bumsaetze?\b|\bumsatz\b|\bausgaben\b|\bzahlungen\b|\btransaktion\w*|\bkontobewegung\w*|\babbuchung\w*/,
    typos: ["buchungen", "umsaetze", "ausgaben", "zahlungen", "transaktionen"],
  },
  payroll: {
    pattern: /\bgehalt\w*|\blohn(?:zettel|abrechnung|s)?\b|\bgehaltszettel\b|\bnetto(?:gehalt|lohn)?\b|\bbrutto\b|\bverdien(?:e|st|t)?\b|\bauszahlung\b|\b(?:gehalts|lohn)?abrechnung(?:en)?\b|\bbekomm\w* (?:ich )?(?:\w+ )?raus\b/,
    typos: ["gehalt", "lohnzettel", "gehaltsabrechnung", "gehaltszettel"],
  },
};

const actions: Record<IntentAction, RegExp> = {
  create: new RegExp([
    "\\b(?:erstell\\w*|anleg\\w*|hinzufueg\\w*|eintrag\\w*|einricht\\w*|speicher\\w*|erfass\\w*|aufnehm\\w*|add|create)\\b",
    "\\b(?:leg|trag|fueg|richt|nimm)\\w*\\b.{0,50}\\b(?:an|ein|hinzu|auf)\\b",
    "\\bmach\\w*\\b(?: (?:mir|uns|bitte|mal))* (?:ein|einen|eine|neue[nrs]?)\\b",
    "\\bneue[nrsm]?\\b",
    "\\b(?:will|moechte|brauch\\w*|haette gern|wuerde gern)\\b.{0,50}\\b(?:anlegen|haben|eintragen|hinzufuegen|erstellen|speichern|einrichten)\\b",
  ].join("|")),
  show: /\b(?:zeig\w*|anzeig\w*|list\w*|auflist\w*|oeffne\w*|sehen|schau\w*|ueberblick|uebersicht|welche\w*)\b|\bwie (?:hoch|viel|sieht|schaut|steht|steh)\b|\bwas (?:ist|sind|war|hab|habe|verdien\w*|bekomm\w*)\b|^(?:mein\w*|meine letzte\w*)\b/,
  check: /\b(?:pruef\w*|check\w*|kontrollier\w*|status|stand|ueberzogen|drueber|uebrig|noch frei|noch da)\b|\bim (?:rahmen|plan|budget)\b/,
  filter: /\b(?:filter\w*|nur|alle|sortier\w*)\b|\b(?:von|bei|an|fuer|im|vom|seit|ueber|unter|letzte\w*)\b/,
};

// Questions about meaning, advice or how something works are no app actions.
const notAnAction = /\b(?:was (?:ist|sind|bedeutet|bedeuten|heisst|versteht man unter) (?:ein|eine|einen|der|die|das|ein guter|eine gute)\b|wie (?:mache|macht|erstelle|erstellt|lege|legt|funktionier\w*|plane|plant|spare|spart)\b|\bman\b|lohnt|sinnvoll|tipps?\b|soll(?:te)? ich|empfiehlst|empfehl\w*|unterschied|warum|wieso|weshalb|besser|vergleich\w*|kuendig\w*|loesch\w*|entfern\w*|aender\w*|bearbeit\w*)/;
const negated = /\b(?:kein\w*|nicht|niemals)\b/;
const amexStatement = /\b(?:amex|kreditkart\w*|nebenkost\w*|strom\w*|gas\w*|heiz\w*|handy\w*|jahres\w*|betriebskost\w*)\s*-?\s*abrechnung|\babrechnung (?:der|von der|vom) (?:amex|kreditkarte)/;

/** One edit (swap, insert, delete, or swap of neighbours); enough for the typos people make in short words. */
function closeEnough(word: string, target: string) {
  if (Math.abs(word.length - target.length) > 1 || word.length < 5) return false;
  if (word === target) return true;
  let i = 0;
  while (i < Math.min(word.length, target.length) && word[i] === target[i]) i++;
  const a = word.slice(i);
  const b = target.slice(i);
  return a.slice(1) === b.slice(1) || a.slice(1) === b || a === b.slice(1) || a.length > 1 && a[0] === b[1] && a[1] === b[0] && a.slice(2) === b.slice(2);
}

function hasSubject(text: string, words: string[], subject: IntentSubject) {
  if (subjects[subject].pattern.test(text)) return true;
  return words.some((word) => subjects[subject].typos.some((target) => closeEnough(word, target)));
}

/** The subjects a message talks about, in a fixed order of how specific they are. */
export function intentSubjects(input: string): IntentSubject[] {
  const text = fold(input);
  const words = text.split(" ");
  const found = (["contract", "goal", "payroll", "budget", "transactions"] as const).filter((subject) => hasSubject(text, words, subject));
  return found.filter((subject) => subject !== "payroll" || !amexStatement.test(text));
}

/** The tool a free phrasing asks for, or nothing when the message is not clearly one of the app's actions. */
export function intentFrame(input: string): IntentFrame | undefined {
  const text = fold(input);
  if (!text || notAnAction.test(text)) return undefined;
  const found = intentSubjects(input);
  if (!found.length) return undefined;
  const create = actions.create.test(text) && !negated.test(text);
  const show = actions.show.test(text);
  const check = actions.check.test(text);
  const filter = actions.filter.test(text);
  const question = /\?\s*$/.test(input) && /^(?:ist|sind|gibt es|brauch\w*|hab(?:e)? ich (?:einen|ein|eine) neue)/.test(text);
  if (found.includes("contract") && create && !question) return { subject: "contract", action: "create", tool: "contract_new" };
  if (found.includes("goal") && (create || /\bsparen\b/.test(text)) && !question) return { subject: "goal", action: "create", tool: "savings_goal" };
  const own = /\b(?:mein\w*|ich|mir|mich|unser\w*)\b/.test(text) || text.split(" ").length <= 3;
  if (found.includes("payroll") && !create && own) return { subject: "payroll", action: show ? "show" : check ? "check" : undefined, tool: "payroll" };
  if (found.includes("budget") && !create && (show || check || text.split(" ").length <= 3)) return { subject: "budget", action: check ? "check" : "show", tool: "budget" };
  if (found.includes("transactions") && !create && (show || filter)) return { subject: "transactions", action: filter ? "filter" : "show", tool: "query" };
  return undefined;
}

const choices: Record<IntentSubject, { topic: string; options: string[] }> = {
  contract: { topic: "deine Verträge", options: ["Neuen Vertrag anlegen", "Zeig mir meine Verträge", "Welche Verträge kann ich kündigen?"] },
  goal: { topic: "ein Sparziel", options: ["Neues Sparziel anlegen", "Wie weit bin ich bei meinen Sparzielen?"] },
  budget: { topic: "dein Budget", options: ["Wie viel ist noch frei?", "Zeig mir mein Budget"] },
  transactions: { topic: "deine Buchungen", options: ["Was habe ich diesen Monat ausgegeben?", "Was war meine größte Ausgabe?"] },
  payroll: { topic: "dein Gehalt", options: ["Zeig mir mein Gehalt", "Erklär mir meine Lohnabrechnung"] },
};

/**
 * A short question back with the closest options, instead of guessing or giving up: "Geht es um deine Verträge?" with
 * "Neuen Vertrag anlegen" and "Zeig mir meine Verträge". Nothing recognisable gives nothing; the caller asks openly.
 */
export function clarifyChoices(input: string): { text: string; options: string[] } | undefined {
  const found = intentSubjects(input).slice(0, 2);
  if (!found.length) return undefined;
  const topics = found.map((subject) => choices[subject].topic);
  return {
    text: `Ich will nicht raten: Geht es dir um ${topics.join(" oder ")}? Tipp an, was passt – oder sag es mir mit anderen Worten, dann merke ich mir die Formulierung.`,
    options: found.flatMap((subject) => choices[subject].options.slice(0, found.length > 1 ? 2 : 3)).slice(0, 4),
  };
}

const draftTools: readonly AssistantTool[] = ["savings_goal", "expense", "affordability"];

/**
 * Combines the specific rules with the free phrasing: the rules decide whenever they know the request; the frame fills the
 * gaps and corrects known misreads (a payslip read as a planned expense, "Budget-Status" read as the weekly overview,
 * a public limit read as a booking question).
 */
export function reconcileIntent(rule: AssistantTool | undefined, input: string): AssistantTool | undefined {
  // A public limit or benefit is no booking question, even when it reads like one ("Pendlerpauschale 2026 – wie viel ist das?").
  if (rule === "query" && publicFactQuestion(input)) return undefined;
  const frame = intentFrame(input);
  if (!frame) return rule;
  if (!rule) return frame.tool;
  if (frame.subject === "payroll" && draftTools.includes(rule) && !/\d/.test(input)) return frame.tool;
  if (frame.subject === "budget" && rule === "briefing") return frame.tool;
  return rule;
}
