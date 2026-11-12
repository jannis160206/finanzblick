import type { AppState } from "@/lib/types";
import { matchesTransactionSearch } from "@/lib/transaction-tools";
import type { AgentResult } from "./agent";
import { normalizeMessage } from "./normalize";
import { offTopicReply } from "./scope";

/**
 * Requests that need a fixed, honest reply instead of a tool or the model: navigation, the colour scheme, deleting
 * everything at once and questions about the assistant's own instructions. Deterministic, so they never reach the model.
 */
export type FixedReply = AgentResult & { theme?: "dark" | "light" };

/** "Kannst du das nochmal erklären?", "Was heißt das?": refers to the last answer, so it needs the history, not a tool. */
export const explainAgain = (input: string) => /\b(?:das|es)\b.{0,20}\b(?:nochmal|noch mal|genauer|einfacher|anders)\b.{0,15}\berklär|\berklär\w* (?:mir )?(?:das|es) (?:nochmal|noch mal|genauer|einfacher|anders)\b|^(?:das )?versteh(?:e)? ich nicht\b|^was (?:heißt|heisst|bedeutet) das(?: genau| für mich)?\s*\??$/
  .test(normalizeMessage(input).toLowerCase().trim());

const pages: [RegExp, string, string, string][] = [
  [/dashboard|übersicht|startseite|home/, "/", "Übersicht", "zur Übersicht"], [/umsätze|buchungen|transaktionen/, "/umsaetze", "Umsätze", "zu den Umsätzen"],
  [/budget|monatsplan/, "/budget", "Budget", "zum Budget"], [/sparen|sparziele|pockets|konten/, "/sparen", "Sparen", "zum Sparen"],
  [/verträge|vertragsordner|abos/, "/vertraege", "Verträge", "zu den Verträgen"], [/gehalt|steuern|lohnzettel|abrechnungen/, "/gehalt-steuern", "Gehalt & Steuern", "zu Gehalt & Steuern"],
  [/einstellungen|settings/, "/einstellungen", "Einstellungen", "zu den Einstellungen"],
];
const pageWords = "dashboard|übersicht|startseite|home|umsätze|buchungen|transaktionen|budget|monatsplan|sparen|sparziele|pockets|konten|verträge|vertragsordner|abos|gehalt|steuern|lohnzettel|abrechnungen|einstellungen|settings";
// "Öffne die Verträge", "Geh zum Budget", "Zeig mir das Dashboard"; "Zeig mir meine Abos" stays a question for the chat.
const navigate = new RegExp(String.raw`^(?:bitte\s+)?(?:(?:öffne|oeffne|geh(?:e)? (?:zu|zur|zum|in die|in den|auf die)|wechsel\w* (?:zu|zur|zum|in die|auf die)|bring mich (?:zu|zur|zum|in die)|navigier\w* (?:zu|zur|zum))\s*(?:der |die |das |den |meine[nr]? )?(${pageWords})|zeig\w* (?:mir )?(?:das |die |den )?(dashboard|übersicht|startseite|einstellungen))(?:-?seite)?(?:\s+bitte)?\s*[.!?]*$`);
const theme = /\b(?:dark|light|night)\s*-?\s*mode\b|dunkel\s*-?\s*modus|hell\s*-?\s*modus|nachtmodus|dunkles (?:design|farbschema|thema)|helles (?:design|farbschema|thema)/;
const deleteAll = /\b(?:lösch|loesch|entfern|vernicht)\w*\b.{0,30}\b(?:alle|sämtliche|saemtliche|ganze[nn]?)\b.{0,20}\b(?:buchungen|umsätze|transaktionen|daten)\b|\balle (?:meine )?(?:daten|buchungen) (?:lösch|loesch|weg)|\blösch\w* alles\b/;
const instructions = /system-?prompt|(?:deine|die) (?:internen? )?(?:anweisungen|instruktionen|vorgaben|regeln)\b.{0,30}\b(?:zeig|gib|nenn|verrat|ausgeb|schreib)|ignorier\w* (?:alle |deine |die )?(?:vorherigen |bisherigen |obigen )?(?:anweisungen|regeln|instruktionen|vorgaben)/;
const distress = /^(?:(?:oh|ach|mist|puh|na toll)[,!]?\s+)?(?:mein (?:giro)?konto ist (?:schon )?(?:leer|im minus|überzogen|ueberzogen|blank)|ich bin (?:total |komplett |völlig |voellig |voll |schon wieder |wieder )?(?:pleite|blank|abgebrannt|bankrott)|ich hab(?:e)? (?:kein (?:geld|cent|euro)|nichts) mehr)[.!]*$/;
// Actions that need a bank or Google login, a file or a browser permission happen on their page, never in the chat.
const appOnly: [RegExp, string, string, string][] = [
  [/\b(?:verbind|verknüpf|verknuepf|trenn|entkoppel|synchronisier|abgleich|aktualisier)\w*\b.{0,40}\b(?:bank\w*|konto|konten|revolut|raiffeisen|trade republic|n26|bawag|erste bank)\b|\bbankverbindung\w*\b.{0,30}\b(?:einricht|hinzufüg|hinzufueg|lösch|loesch|entfern|trenn)\w*/,
    "Bankverbindungen richtest du unter Einstellungen → Bankverbindungen ein. Dafür brauchst du die Anmeldung bei deiner Bank – das geht aus Sicherheitsgründen nicht im Chat.", "Einstellungen", "/einstellungen"],
  [/\b(?:google drive|gmail|google-konto|google konto)\b.{0,40}\b(?:verbind|verknüpf|verknuepf|trenn|anmeld|einricht)\w*|\b(?:verbind|verknüpf|verknuepf|trenn)\w*\b.{0,40}\b(?:google drive|gmail)\b/,
    "Google Drive und Gmail verbindest oder trennst du unter Einstellungen; die Anmeldung bei Google geht nur dort.", "Einstellungen", "/einstellungen"],
  [/\bbenachrichtigung\w*\b.{0,30}\b(?:aktivier|einschalt|ausschalt|deaktivier|erlaub|abstell)\w*|\b(?:aktivier|schalt)\w*\b.{0,20}\bbenachrichtigung/,
    "Benachrichtigungen schaltest du unter Einstellungen → Benachrichtigungen ein oder aus; dein Browser fragt dafür um Erlaubnis.", "Einstellungen", "/einstellungen"],
  [/\b(?:backup|sicherung|export)\w*\b.{0,30}\b(?:mach|erstell|herunterlad|lad|einspiel|wiederherstell)\w*|\b(?:exportier|sicher)\w*\b.{0,30}\b(?:daten|buchungen|umsätze|umsaetze|alles)\b|^(?:bitte\s+)?(?:mach|erstell|leg|lad|spiel)\w*\b.{0,20}\b(?:backup|sicherung|export)\w*/,
    "Backups und Exporte erstellst oder spielst du unter Einstellungen → Sicherung ein; die Datei lädt bzw. wählt dein Browser.", "Einstellungen", "/einstellungen"],
  [/\b(?:lad|importier|hochlad|scann)\w*\b.{0,40}\b(?:abrechnung|lohnzettel|lohnabrechnung|kontoauszug|auszug|csv|pdf|screenshot|kassenbon|beleg|rechnung)\w*|\bkassenbon\w*\b.{0,20}\baufteil/,
    "Dateien wie Lohnabrechnungen, Kontoauszüge oder Kassenbons lädst du über „Importieren“ in der Kopfzeile oder bei der Buchung hoch – im Chat kann ich keine Dateien annehmen.", "Umsätze", "/umsaetze"],
  [/\b(?:akzentfarbe|app-?farbe|farbe der app|animationen|bewegungen)\b.{0,30}\b(?:änder|aender|setz|stell|aus|reduzier|wechsel)\w*/,
    "Akzentfarbe und Bewegung stellst du unter Einstellungen → Darstellung ein; dort siehst du die Vorschau sofort.", "Einstellungen", "/einstellungen"],
];
const invent = /^(?:bitte\s+)?(?:erfind\w*|denk dir)\b.{0,40}\b(?:kontostand|zahl\w*|betrag|beträge|buchung\w*|gehalt|daten)\b/;

// "Was ist 15 % von 2400?", "Rechne 1200 / 12": plain arithmetic is computed, never guessed by the model.
const percentOf = /^(?:was (?:ist|sind|ergibt|ergeben)|wie viel (?:ist|sind)|rechne(?: mir)?(?: aus)?:?)?\s*(\d+(?:[.,]\d+)?)\s*(?:%|prozent) (?:von|aus) (\d+(?:[.,]\d+)?)\s*(?:€|euro)?\s*\??$/;
const expression = /^(?:was (?:ist|sind|ergibt|ergeben|macht)|wie viel (?:ist|sind|macht)|rechne(?: mir)?(?: aus)?:?|berechne:?)\s*([\d\s.,+\-*/×÷:()]+?)\s*(?:=|\?)*$/;
const number = (raw: string) => Number(raw.replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));

function evaluate(source: string): number | undefined {
  const normalized = source.replace(/×/g, "*").replace(/[÷:]/g, "/");
  const found = normalized.match(/\d+(?:[.,]\d+)*|[+\-*/()]/g);
  if (!found || found.join("") !== normalized.replace(/\s+/g, "")) return undefined;
  const tokens: string[] = found;
  let index = 0;
  const peek = () => tokens[index];
  const factor = (): number => {
    const token = tokens[index++];
    if (token === "-") return -factor();
    if (token === "(") { const value = sum(); if (tokens[index++] !== ")") throw new Error("paren"); return value; }
    if (token === undefined || !/^\d/.test(token)) throw new Error("number");
    return number(token);
  };
  const product = (): number => {
    let value = factor();
    while (peek() === "*" || peek() === "/") { const op = tokens[index++]; const right = factor(); value = op === "*" ? value * right : value / right; }
    return value;
  };
  function sum(): number {
    let value = product();
    while (peek() === "+" || peek() === "-") { const op = tokens[index++]; const right = product(); value = op === "+" ? value + right : value - right; }
    return value;
  }
  try {
    const value = sum();
    return index === tokens.length && Number.isFinite(value) && tokens.some((token) => /[+\-*/]/.test(token)) ? value : undefined;
  } catch {
    return undefined;
  }
}
const format = (value: number) => new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value);

export function fixedReply(input: string): FixedReply | undefined {
  const lower = normalizeMessage(input).toLowerCase().trim();
  if (!lower || lower.length > 120) return undefined;
  const percent = percentOf.exec(lower);
  if (percent) return { text: `${format(number(percent[1]))} % von ${format(number(percent[2]))} sind ${format(number(percent[1]) * number(percent[2]) / 100)}.` };
  const math = expression.exec(lower);
  const result = math ? evaluate(math[1].trim()) : undefined;
  if (math && result !== undefined) return { text: `${math[1].trim().replace(/\s*([+\-*/×÷:])\s*/g, " $1 ")} = ${format(result)}` };
  // Films, weather, recipes, general facts, jokes: not this assistant's job.
  const away = offTopicReply(input);
  if (away) return away;
  const elsewhere = /\?\s*$/.test(lower) && !/^(?:kannst|könntest|koenntest|würdest|wuerdest) du\b/.test(lower) ? undefined : appOnly.find(([pattern]) => pattern.test(lower));
  if (elsewhere) return { text: elsewhere[1], card: { kind: "answer", title: elsewhere[2], lines: [], page: { label: `${elsewhere[2]} öffnen`, href: elsewhere[3] } } };
  if (instructions.test(lower)) return { text: "Meine internen Anweisungen behalte ich für mich. Frag mich aber gern alles zu deinen Finanzen.",
    suggestions: ["Was kannst du alles?", "Was bleibt mir diesen Monat?"] };
  if (distress.test(lower)) return { text: "Oh, das ist unangenehm. Lass uns gemeinsam schauen, was bis zum nächsten Gehalt noch ansteht – dann weißt du, woran du bist.",
    suggestions: ["Reicht mein Geld bis zum Gehalt?", "Welche Fixkosten kommen noch?", "Wo kann ich sparen?"] };
  if (invent.test(lower)) return { text: "Erfinden mag ich nichts – ich rechne nur mit deinen echten Daten. Soll ich dir stattdessen deinen echten Stand zeigen?",
    suggestions: ["Wie sieht mein Kontostand aus?", "Was bleibt mir diesen Monat?"] };
  if (deleteAll.test(lower)) return {
    text: "Alles auf einmal lösche ich per Chat nicht. Einzelne Buchungen lösche ich gern – nenn mir Datum und Betrag, zum Beispiel „Lösch die Buchung vom 3.8. über 249 €“. Ein Backup findest du in den Einstellungen.",
    card: { kind: "answer", title: "Umsätze", lines: [], page: { label: "Umsätze öffnen", href: "/umsaetze" } },
  };
  if (theme.test(lower) && /wechsel|aktivier|schalt|mach|stell|änder|aender|bitte|^(?:dark|light|dunkel|hell|nacht)/.test(lower)) {
    const dark = !/\blight\b|hell/.test(lower);
    return { text: dark ? "Erledigt – jetzt im dunklen Farbschema. Zurück geht's oben rechts mit dem Sonnen-Symbol." : "Erledigt – jetzt im hellen Farbschema. Zurück geht's oben rechts mit dem Mond-Symbol.",
      theme: dark ? "dark" : "light" };
  }
  const match = navigate.exec(lower);
  const page = match?.[1] ?? match?.[2];
  const target = page ? pages.find(([pattern]) => pattern.test(page)) : undefined;
  if (target) return { text: `Hier geht's ${target[3]}.`, card: { kind: "answer", title: target[2], lines: [], page: { label: `${target[2]} öffnen`, href: target[1] } } };
  return undefined;
}

// One or two words without a question ("Geld", "Netflix", "500"): ask what exactly, with fitting suggestions.
const topics: [RegExp, string, string[]][] = [
  [/^(?:geld|finanzen|kohle)$/, "Wozu genau?", ["Was bleibt mir diesen Monat?", "Wo geht mein Geld hin?", "Wie sieht mein Kontostand aus?"]],
  [/^(?:gehalt|lohn|netto|brutto)$/, "Was möchtest du zum Gehalt wissen?", ["Wie viel netto bekomme ich?", "Wann kommt mein Gehalt?", "Was bleibt vom Weihnachtsgeld?"]],
  [/^(?:steuer|steuern|lohnsteuer)$/, "Was möchtest du zu den Steuern wissen?", ["Warum zahle ich so viel Lohnsteuer?", "Was kann ich bei der Arbeitnehmerveranlagung absetzen?"]],
  [/^(?:budget|monatsplan)$/, "Was möchtest du zum Budget wissen?", ["Was bleibt mir diesen Monat?", "Bin ich im Budget?", "Wie viel kann ich heute noch ausgeben?"]],
  [/^(?:abos?|verträge|vertrag)$/, "Was möchtest du zu deinen Verträgen wissen?", ["Welche Abos habe ich?", "Welche Verträge kann ich kündigen?", "Welche Abos sind teurer geworden?"]],
  [/^(?:ausgaben|umsätze|buchungen)$/, "Welche Ausgaben meinst du?", ["Wie viel hab ich diesen Monat ausgegeben?", "Wofür geb ich am meisten aus?", "Wie war mein Oktober?"]],
  [/^(?:sparen|sparziele?)$/, "Was möchtest du zum Sparen wissen?", ["Wie stehen meine Sparziele?", "Wo kann ich sparen?", "Bin ich sparsam?"]],
];

export type Topic = { reply: AgentResult } | { rewrite: string };

/** Clarifies a bare topic word; a bare account or goal name is read as "how much is there". */
export function topicClarify(input: string, state: AppState, names: { accounts: string[]; goals: string[]; contracts: string[] }): Topic | undefined {
  const text = normalizeMessage(input).replace(/[.!]+$/, "").trim();
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);
  if (!text || words.length > 2 || /\?$/.test(text) || /^(?:ja|nein|ok|okay|hallo|hi|danke|hilfe)$/.test(lower)) return undefined;
  const amount = /^(\d{1,7}(?:[.,]\d{1,2})?)\s*(?:€|euro|eur)?$/.exec(lower)?.[1];
  if (amount) return { reply: { text: `Was meinst du mit ${amount} €?`,
    suggestions: [`Kann ich mir ${amount} € leisten?`, `Zeig mir Ausgaben über ${amount} €`, `Was wäre, wenn ich ${amount} € im Monat mehr spare?`] } };
  const topic = topics.find(([pattern]) => pattern.test(lower));
  if (topic) return { reply: { text: topic[1], suggestions: topic[2] } };
  const same = (name: string) => name.toLowerCase() === lower || name.toLowerCase().split(/\s+/).includes(lower) && lower.length >= 4;
  const goal = names.goals.find(same);
  if (goal) return { rewrite: `Wie steht mein Sparziel ${goal}?` };
  const account = names.accounts.find(same);
  if (account) return { rewrite: `Wie viel ist auf dem Konto ${account}?` };
  const contract = names.contracts.find((name) => name.toLowerCase().includes(lower) && lower.length >= 3);
  const label = text.charAt(0).toUpperCase() + text.slice(1);
  if (contract) return { reply: { text: `Was möchtest du zu ${label} wissen?`,
    suggestions: [`Was kostet mich ${label} im Jahr?`, `Ist ${label} teurer geworden?`, `Kündige ${label}`] } };
  if (lower.length >= 3 && state.transactions.some((row) => row.amount < 0 && matchesTransactionSearch(row, text))) return { reply: { text: `Was möchtest du zu ${label} wissen?`,
    suggestions: [`Wie viel hab ich bei ${label} ausgegeben?`, `Wie oft war ich bei ${label}?`, `Warum ist ${label} in dieser Kategorie?`] } };
  return undefined;
}
