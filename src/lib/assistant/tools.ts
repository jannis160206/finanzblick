import { amexQuestion, balanceQuestion, budgetQuestion } from "./accounts";
import { comparePattern, trendPattern } from "./answers";
import { bookingRequest } from "./bookings";
import { cancelQuestion } from "./cancel";
import { checkQuestion } from "./check";
import { forecastQuestion } from "./forecast";
import { loanQuestion, reminderListQuestion, reminderRequest, reviewQuestion } from "./extras";
import { detectAction, findExtra } from "./intent";
import { knowledgeListQuestion, knowledgeQuestion, knowledgeTopics } from "./knowledge";
import { marketQuestion } from "./market";
import { normalizeMessage } from "./normalize";
import { pulseQuestion } from "./pulse";
import { ordersQuestion } from "./orders";
import { accountRuleRequest, fundsQuestion } from "./funds";
import { whatIfQuestion } from "./whatif";
import { whyQuestion } from "./why";

// Everything the assistant can do. The model may only pick one of these names.
export const assistantTools = [
  "savings_goal", "expense", "affordability", "query", "accounts", "amex", "budget", "briefing", "check", "edit", "booking", "batch", "rule",
  "remember", "forget", "memory", "changes", "undo", "coach", "depot", "market", "knowledge", "tax", "homeoffice", "loan", "reminder", "review",
  "explain", "help", "ask", "cancel", "why", "forecast", "whatif", "pulse", "orders", "funds", "account_rule",
] as const;
export type AssistantTool = typeof assistantTools[number];
export const draftTools = ["savings_goal", "expense", "affordability"] as const satisfies readonly AssistantTool[];
export const isDraftTool = (tool: AssistantTool): tool is typeof draftTools[number] => (draftTools as readonly string[]).includes(tool);
export const isAssistantTool = (value: unknown): value is AssistantTool => typeof value === "string" && (assistantTools as readonly string[]).includes(value);

export const toolDescriptions: Record<AssistantTool, string> = {
  savings_goal: "neues Sparziel anlegen oder durchrechnen",
  expense: "neue künftige Ausgabe oder Ratenkauf planen",
  affordability: "einen künftigen Kauf im Monatsplan durchrechnen (nur wenn ausdrücklich ein Plan gewünscht ist; „Kann ich mir … leisten?“ ist funds)",
  query: "Frage zu vergangenen Buchungen, Ausgaben, Einnahmen oder Abos beantworten, auch je Konto/Karte (z. B. „mit Amex“) und Zeitraum (z. B. „seit 11.10.“)",
  accounts: "Kontostände, Pockets, Ersparnisse, Vermögen anzeigen („Wie viel ist auf dem Sparkonto?“)",
  amex: "Amex-Kreditkartenabrechnung: wie viel offen ist und wie viel noch auf das Amex-Rückzahlungs-Pocket überwiesen werden muss",
  budget: "Monatsplan: was diesen oder einen kommenden Monat übrig bleibt, wie viel man noch ausgeben kann",
  briefing: "Wochenüberblick: was ist fällig, was hat sich geändert",
  check: "Finanz-Check: Bewertung der eigenen Finanzen (Sparquote, Fixkosten, Reserve), z. B. „Bin ich sparsam?“, „Wie stehe ich finanziell da?“",
  edit: "bestehendes Sparziel, geplante Ausgabe oder Notgroschen-/Urlaubs-/Sparkonto-Ziel ändern, verschieben, aussetzen, umbenennen, löschen, als erreicht markieren, vom Sparkonto zahlen oder mit Raphael teilen",
  booking: "bestehende Buchungen bearbeiten: Anzeigename ändern („Benenne BILLA DANKT in Billa um“), aus dem Monatsplan nehmen, als Fixkosten oder geprüft markieren",
  batch: "mehrere Änderungen in einer Nachricht, z. B. „Erhöhe Japan auf 4.000 € und schieb das Pickerl auf April“",
  rule: "Händler oder Buchungen einer Kategorie zuordnen, z. B. „Lieferando ist immer Essen“",
  remember: "sich etwas merken, z. B. Puffer oder Gehaltstag",
  forget: "einen gemerkten Eintrag vergessen",
  memory: "zeigen, was sich der Assistent gemerkt hat",
  changes: "Liste der Änderungen des Assistenten zeigen",
  undo: "letzte Änderung rückgängig machen",
  coach: "Spartipps, um monatlich mehr zu sparen",
  depot: "ETF-/Depot-Sparplan mit Zinseszins durchrechnen",
  market: "aktuelle Marktdaten aus dem Internet: Inflation, Sparzinsen/Tagesgeld/EZB-Leitzins, Wechselkurse (z. B. Euro in Yen), Kaufkraft in X Jahren",
  knowledge: "allgemeinen Finanzbegriff erklären und dafür im Internet nachschlagen (z. B. „Was ist ein ETF?“, „Was bedeutet KESt?“, „Unterschied zwischen Tagesgeld und Festgeld“) oder zeigen, was der Assistent dazugelernt hat",
  tax: "absetzbare Buchungen für die Arbeitnehmerveranlagung (Österreich) sammeln",
  homeoffice: "ausrechnen, was man für Home-Office-Sachen (Laptop, Bildschirm, Bürostuhl, Schreibtisch) beim Steuerausgleich zurückbekommt",
  loan: "Kredit-, Leasing- oder Ratenrechner: Monatsrate, Zinsen gesamt und Vergleich mit Ansparen (z. B. „Kredit 10.000 € auf 5 Jahre zu 6 %“)",
  reminder: "Erinnerung an einem Datum anlegen oder Erinnerungen anzeigen (z. B. „Erinner mich am 1. Dezember, die Kfz-Versicherung zu kündigen“)",
  review: "Jahresrückblick: Einnahmen, Ausgaben, Sparquote, Top-Kategorien und Vergleich zum Vorjahr (z. B. „Wie war mein Jahr 2026?“)",
  explain: "erklären, wie das Finanzdashboard funktioniert (Seiten, Sparziele, Pockets, Import, Monatsplan, Einstellungen) und was man per Chat einstellen kann",
  help: "erklären, was der Assistent kann",
  ask: "jede andere Frage zu den eigenen Finanzen, die kein anderes Werkzeug abdeckt",
  cancel: "Kündigungshilfe: Vertrag oder Abo aus den Abbuchungen erkennen, Kosten und übliche Kündigungsfrist zeigen, Preisvergleich verlinken und Kündigungsschreiben vorbereiten (z. B. „Kündige Netflix“, „Welche Verträge kann ich kündigen?“)",
  why: "erklären, warum eine Buchung in ihrer Kategorie steht (Regel, gelernt, Web, KI, manuell), z. B. „Warum ist Billa Lebensmittel?“",
  forecast: "Kontoprognose für die nächsten 12 Monate pro Konto: wann wird das Girokonto knapp (Gehalt, Fixkosten, Abos, Amex-Abbuchung, geplante Ausgaben, Sparraten), z. B. „Wird mein Konto knapp?“, „Reicht mein Geld bis Jänner?“",
  whatif: "Was-wäre-wenn-Rechner: Abo kündigen und/oder monatlich mehr sparen und sehen, wann ein Sparziel früher erreicht ist (z. B. „Wenn ich Netflix kündige und 200 € mehr spare, wann erreiche ich Japan?“)",
  orders: "Offene Online-Bestellungen aus Gmail (Bestellbestätigungen, Klarna, PayPal, Kauf auf Rechnung) mit Betrag und Fälligkeit, die noch nicht abgebucht wurden (z. B. „Welche Bestellungen sind noch offen?“, „Was muss ich bei Klarna noch zahlen?“)",
  funds: "Konten-Check: ob sich eine Ausgabe oder ein Kauf mit den Konten ausgeht, die man dafür verwenden darf, mit OK / nicht OK und von welchem Konto zahlen – legt nichts an (z. B. „Kann ich mir eine Kaffeemaschine um 850 € leisten?“, „Geht sich ein Ölwechsel um 120 € aus?“, „Reifen 600 € ok?“, „Welche Konten darf ich wofür verwenden?“)",
  account_rule: "Kontoregel festlegen, wofür ein Konto verwendet werden darf (z. B. „Sparkonto ist für alle Ausgaben“, „Trade Republic nur für Autowerkstatt und Ölwechsel“, „Notgroschen nicht angreifen“)",
  pulse: "Monats-Puls mit echtem Kontostand: wie viel man heute/pro Tag bis zum Gehalt noch sicher ausgeben kann, ob das Gehalt schon da ist, welche Budgets oder Kategorien schneller als üblich laufen und welche Fixkosten noch abgebucht werden (z. B. „Wie viel kann ich heute noch ausgeben?“, „Ist mein Gehalt schon da?“, „Bin ich im Budget?“)",
};

const fold = (value: string) => value.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, " ").trim();

// Finds the best (longest) existing name mentioned in the text; also accepts a distinctive first word.
export function matchName<T>(text: string, items: T[], name: (item: T) => string): T | undefined {
  const plain = ` ${fold(text)} `;
  let best: { item: T; score: number } | undefined;
  for (const item of items) {
    const full = fold(name(item));
    if (!full) continue;
    const words = full.split(" ").filter((word) => word.length >= 3);
    const score = plain.includes(` ${full} `) ? full.length + 100
      : words.some((word) => plain.includes(` ${word} `) || (word.length >= 5 && plain.includes(` ${word}`))) ? Math.max(...words.map((word) => word.length)) : 0;
    if (score && (!best || score > best.score)) best = { item, score };
  }
  return best?.item;
}
export const mentionsName = (text: string, names: string[]) => names.length > 0 && matchName(text, names, (name) => name) !== undefined;

const editVerbs = /\b(?:erhöh|erhoeh|senk|reduzier|änder|aender|setz\w*|schieb|verschieb|verleg|benenn|umbenenn|nenn\w*\s+\S+\s+(?:in|um)\b|lösch|loesch|entfern|streich|aussetz|pausier|überspring|ueberspring|ausfallen|erreicht|geschafft|abgeschlossen|abschließ|erledigt|fortsetz|wieder aufnehm|auf\s+\d)/;

const explainPattern = new RegExp([
  "wie funktionier(?:t|en)\\b", "wie geht (?:das|die|der)\\b", "erklär", "erklaer", "wo finde ich", "wo sehe ich", "wofür ist", "wofuer ist", "wozu (?:ist|sind|dient|gibt)",
  "wie läuft (?:das|es)\\b", "wie laeuft (?:das|es)\\b", "was geht alles", "was hat es mit .{2,30} auf sich", "was bringt (?:mir )?(?:ein |eine |der |die |das )?(?:pocket|sparziel|notgroschen|monatsplan)",
  "was (?:ist|sind|bedeutet|bedeuten|macht|machen) (?:ein |eine |der |die |das |den )?(?:pockets?|sparziele?|notgroschen|überschuss|ueberschuss|monatsplan|budgetdetails|prüfliste|pruefliste|händlerregeln?|extra-?beträge|stichtag)\\b",
  "was kann ich (?:hier |im dashboard |damit )?(?:alles )?(?:einstellen|ändern|aendern|konfigurieren|machen|anpassen)", "welche (?:möglichkeiten|moeglichkeiten|einstellungen|funktionen|bereiche)",
  "was gibt es (?:alles|für|fuer)",
].join("|"));

const months = "jänner|januar|februar|feber|märz|april|mai|juni|juli|august|september|oktober|november|dezember";
const periodWords = new RegExp(`\\b(?:${months})\\b|letzte[nrs]? (?:monat|woche|jahr)|vorigen? (?:monat|jahr)|diese[nrs]? (?:monat|woche|jahr)|\\bheuer\\b|\\bvorjahr\\b|\\b20\\d{2}\\b`);
const spentWords = /ausgegeben|ausgaben|bezahlt|gezahlt|verdient|eingenommen|einnahmen|gekostet|kostet mich|kosten mich|abos?\b|abonnement|größte|teuerste|buchung|überwiesen|wohin|wofür|geht.*weg|verbraucht|durchschnitt|draufgegangen|drauf gegangen|gelassen|verballert|verprasst|rausgehauen|ausgeben|gebe ich|geb ich|liegen gelassen|gezahlt|verbraten/;
const pastSpending = /^(?:wie ?viel|was)\b.*\b(?:ausgegeben|bezahlt|eingenommen|verdient|draufgegangen|gelassen|verballert)\b/;
const spendingQuestion = (lower: string) =>
  /\bwo(?:hin)? (?:geht|fließt|fliesst|landet|verschwindet|bleibt) (?:mein|das|unser) geld/.test(lower) ||
  /^(?:ausgaben|einnahmen|kosten|umsätze|umsaetze)\b/.test(lower) && periodWords.test(lower) ||
  /\bwie ?viel\b/.test(lower) && periodWords.test(lower) && !/bleib|übrig|reicht|leist|spar|brauch|monatlich|rate|\bbis\b/.test(lower) ||
  /^(?:wie ?viel|was|wo|wann|wofür|wohin|welche[rsn]?|wie oft|hab(?:e)? ich|zeig|liste)\b/.test(lower) && spentWords.test(lower);

// "Lieferando ist immer Essen"; looser forms: "Lieferando gehört zu Lieferdienste", "mach Lieferando zu Lieferdienste", "Lieferando soll unter Lieferdienste laufen".
const strictRule = /\bist\s+immer\b|\bsind\s+immer\b|immer als\b|\bordne\b.*\bzu\b|kategorisier|als .{2,30} (?:verbuchen|buchen|einordnen|zuordnen)|in die kategorie|der kategorie/;
const looseRule = /\bgehör(?:t|en)\s+(?:immer\s+)?(?:zu|in|unter)\b|\bzählt\s+(?:immer\s+)?(?:als|zu)\b|\bsoll(?:en)?\s+(?:immer\s+)?(?:unter|in|als|zu)\s+.{2,30}\s+(?:laufen|fallen|stehen|landen|gehen|sein|gebucht|verbucht)\b|^(?:mach|pack|steck|tu)\w*\s+\S.{0,30}\s+(?:zu|in|unter)\s+(?:die\s+|den\s+)?(?:kategorie\s+)?\S/;

// Rule-based tool detection; used when the model is unavailable and to keep clear commands deterministic.
export function detectTool(input: string, names: string[] = []): AssistantTool | undefined {
  const text = normalizeMessage(input);
  if (splitCommands(text, names)) return "batch";
  return detectSingle(text, names);
}

const batchTools: readonly AssistantTool[] = ["edit", "booking", "rule", "remember", "forget", "reminder"];
// "Erhöhe Japan auf 4.000 € und schieb es auf Juli": every part must be a change on its own;
// a part without a name inherits the name of the part before ("es" → Japan).
export function splitCommands(input: string, names: string[] = []): string[] | undefined {
  const text = normalizeMessage(input);
  const raw = text.split(/\s*;\s*|(?<!\d\.\d{1,2})\.\s+(?=\p{Lu})|,?\s+und\s+(?:dann\s+|außerdem\s+|ausserdem\s+|zusätzlich\s+|danach\s+)?(?=\p{L})|,\s+(?:dann|außerdem|ausserdem|danach)\s+/u)
    .map((part) => part.trim().replace(/[.!]+$/, "")).filter((part) => part.length >= 3);
  if (raw.length < 2 || raw.length > 6) return undefined;
  const parts: string[] = [];
  let last: string | undefined;
  for (const part of raw) {
    const name = matchName(part, names, (entry) => entry);
    let command = part;
    if (!name && last && !bookingRequest(part, false) && editVerbs.test(part.toLowerCase())) command = `${part} ${last}`;
    const tool = detectSingle(command, names);
    if (!tool || !batchTools.includes(tool)) return undefined;
    parts.push(command);
    last = name ?? last;
  }
  return parts;
}

// "Kann ich mir … leisten?" checks the usable accounts; it never opens a plan or a savings goal.
function detectSingle(text: string, names: string[]): AssistantTool | undefined {
  const tool = detectRaw(text, names);
  return tool === "affordability" ? "funds" : tool;
}

function detectRaw(text: string, names: string[]): AssistantTool | undefined {
  const lower = text.toLowerCase().trim();
  const known = mentionsName(text, names);
  const hasAmount = /\d/.test(lower);
  if (/rückgängig|\bundo\b|mach (?:das|es) wieder|zurücknehmen|nimm (?:das|es|die änderung|die letzte änderung) (?:wieder )?zurück|mach (?:das|es) ungeschehen|stopp?,? das war falsch/.test(lower)) return "undo";
  if (/(?:welche|letzte[nr]?|deine|alle)\s+änderungen|änderungsprotokoll|was hast du (?:\S+ ){0,2}(?:geändert|gemacht|umgestellt)|protokoll/.test(lower)) return "changes";
  if (reminderListQuestion(lower) && !/\bvergiss\b|lösch/.test(lower) || reminderRequest(lower)) return "reminder";
  if (reviewQuestion(lower)) return "review";
  if (accountRuleRequest(lower)) return "account_rule";
  if (/was (?:weißt|weisst) du (?:über|ueber) mich|was hast du dir (?:\S+ ){0,3}gemerkt|was merkst du dir|dein gedächtnis|\bgedächtnis\b/.test(lower) &&
    !/vergiss|lösch|merk dir|merke dir/.test(lower)) return "memory";
  if (knowledgeListQuestion(lower)) return "knowledge";
  if (/\bvergiss\b|vergessen/.test(lower) && !/vergiss nicht/.test(lower)) return "forget";
  if (/merk dir|merke dir|vergiss nicht|denk dran|denk daran|notier|\bpuffer\b.*\bimmer\b|\bimmer\b.*\bpuffer\b|\bpuffer\b.*\d|\d.*\bpuffer\b|\breserve\b.*\d|\d.*\breserve\b|nie unter \d|(?:gehalt|lohn)\b.*\bam\s+\d{1,2}\b|\bam\s+\d{1,2}\.?\s+(?:kommt|gibt'?s)\s+(?:mein|das)\s+(?:gehalt|lohn)|gehalt geht/.test(lower) &&
    !/\bbis\b.*\b(?:sparen|zurücklegen)\b|leisten|leistbar|reicht|geht sich/.test(lower)) return "remember";
  if (bookingRequest(text, known)) return "booking";
  if (/home.?office|telearbeit|arbeitsmittel|büroausstattung|bueroausstattung|arbeitsplatz (?:zu ?hause|daheim)|bürostuhl|buerostuhl|schreibtisch/.test(lower) &&
    /steuer|absetz|zurück|zurueck|erstatt|veranlagung|werbungskosten|finanzamt|bekomm|rechne|abzieh|selbstbehalt|pauschale/.test(lower)) return "homeoffice";
  if (loanQuestion(lower)) return "loan";
  // Definition questions ("Was ist ein ETF?") are looked up, but never questions about own data or the dashboard.
  // Live values (inflation, key rate, exchange rate) stay with the market tool.
  const termQuestion = knowledgeQuestion(text, names);
  if (termQuestion && !/inflation|teuerung|preissteigerung|kaufkraft|wechselkurs|\bkurs\b|leitzins|einlagesatz|zinsniveau|^(?:was|wie) (?:sind|ist) (?:die )?(?:aktuellen )?zinsen/.test(lower)) return "knowledge";
  if (marketQuestion(lower)) return "market";
  if (termQuestion) return "knowledge";
  // Casual term questions: "etf was is des eigentlich", "kest bedeutung".
  if (!hasAmount && lower.split(" ").length <= 6 && /\b(?:was|wos) (?:is|ist|isn) (?:des|das)\b|\bbedeutung\b|\bdefinition\b/.test(lower) &&
    knowledgeTopics(text, names, true).length) return "knowledge";
  if (whatIfQuestion(lower)) return "whatif";
  if (ordersQuestion(lower)) return "orders";
  if (fundsQuestion(lower)) return "funds";
  if (pulseQuestion(lower)) return "pulse";
  if (forecastQuestion(lower)) return "forecast";
  if (whyQuestion(lower)) return "why";
  if (cancelQuestion(lower)) return "cancel";
  if (/arbeitnehmerveranlagung|steuerausgleich|absetzbar|absetzen|steuerlich|lohnsteuer|werbungskosten|sonderausgaben|finanzonline|von der steuer|steuer-?mappe/.test(lower)) return "tax";
  if (/\betfs?\b|\bdepot\b|investier|aktien|zinseszins|\bsparplan\b|\bmsci\b|\brendite\b|\bfonds\b|vanguard|ishares/.test(lower) ||
    /\b(?:anlegen|veranlagen|anleg)\b/.test(lower) && /\d+\s*jahre?n?\b/.test(lower) && !/sparziel|\bziel\b|\bbis\b/.test(lower)) return "depot";
  if (/wochenüberblick|wochenueberblick|überblick|ueberblick|was steht (?:an|diese woche)|was ist (?:diese woche )?fällig|briefing|was gibt'?s neues|zusammenfassung der woche|status/.test(lower) &&
    !/\b(?:im|in|seit)\s+(?:jänner|januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/.test(lower)) return "briefing";
  if (/mehr (?:geld )?(?:im monat )?(?:sparen|zur seite|übrig)|wo kann ich (?:[\w€.,]+ ){0,4}(?:ein)?sparen|einsparen|einzusparen|sparpotenzial|spartipps?|weniger ausgeben|kosten senken|spar-?coach|wo (?:kann|könnte) ich (?:noch )?(?:was |etwas )?(?:ein)?sparen|\b(?:kürzen|kuerzen|zurückschrauben|einschränken)\b|wo spare ich (?:am besten|am ehesten)|wo (?:kann|könnte|soll|sollte) ich (?:am ehesten |am besten )?(?:ansetzen|reduzieren)/.test(lower) &&
    !/\b(?:rate|sparziel|ziel)\b.*\bkürzen\b/.test(lower)) return "coach";
  if (strictRule.test(lower) || looseRule.test(lower) && !known && !/\d+\s*(?:€|euro)/.test(lower)) return "rule";
  if (comparePattern.test(lower) && (periodWords.test(lower) || /ausgab|ausgegeben|monat/.test(lower)) && !known &&
    !/sparziel|\brate\b|leisten|leistbar|variante|szenario/.test(lower)) return "query";
  if (checkQuestion(lower)) return "check";
  if (trendPattern.test(lower) && /ausgab|ausgegeben|kosten|einnahmen|essen|abos?\b|\bfür\b|fuer/.test(lower) && !known && !/sparziel|depot|etf/.test(lower)) return "query";
  if (amexQuestion(lower)) return "amex";
  if (balanceQuestion(lower) && !/leisten|leistbar|reicht (?:das|es) für/.test(lower)) return "accounts";
  if (budgetQuestion(lower) && !/leisten|leistbar|\d+\s*(?:€|euro)/.test(lower)) return "budget";
  if (!detectAction(text) && spendingQuestion(lower) || pastSpending.test(lower)) return "query";
  if (explainPattern.test(lower)) return "explain";
  const newGoal = /\bneue[snr]?\b|anlegen|erstell|\bsparen\b.*\bbis\b|\bbis\b.*\bsparen\b/.test(lower);
  if (known && !newGoal && (findExtra(text) || /(?:keine|ohne)\s+extra|extras?\s+(?:lösch|loesch|entfern|streich|weg)/.test(lower))) return "edit";
  // "Zahl das Pickerl vom Sparkonto", "Teil den Urlaub mit Raphael", "Nimm das Pickerl aus dem Plan".
  if (known && !newGoal && !/leisten|leistbar|reicht|geht sich/.test(lower) &&
    (/(?:vom|übers|über das|aus dem|mit dem|von meinem)\s+(?:sparkonto|giro)|raphael/.test(lower) && /zahl|buch|teil|übernimm|uebernimm|hälfte|haelfte|halb/.test(lower) ||
      /aus (?:dem plan|der planung)/.test(lower))) return "edit";
  if (editVerbs.test(lower) && !/\bneue[snr]?\b|anlegen|erstell/.test(lower)) {
    // "Setz mir ein Sparziel …" is a new item unless it names something that already exists.
    const action = detectAction(text);
    const existing = known || /notgroschen|urlaubs?(?:ziel|topf|konto)|sparkonto|\b(?:spar)?rate\b|sparziel/.test(lower);
    return action && !existing ? action : "edit";
  }
  // Short commands on an existing item: "mach Japan 4000", "Japan soll 4000 sein", "Pickerl erst im April".
  if (known && !newGoal && !/leisten|leistbar|\bdrin\b|reicht|geht sich/.test(lower) &&
    (hasAmount && /\b(?:mach|soll|ziel|stell|statt|neu|insgesamt|gesamt|hoch|runter|rauf)\b/.test(lower) && lower.split(" ").length <= 8 ||
      /\b(?:erst|doch|lieber|schon)\s+(?:im|am|ab|in|zum)\b|\b(?:später|früher)\b/.test(lower))) return "edit";
  if (/\bhilfe\b|was kannst du|was kann ich (?:mit dir |bei dir |hier )?(?:alles )?(?:bearbeiten|erledigen lassen)|wie funktionierst du|was geht hier|^\?$/.test(lower)) return "help";
  return detectAction(text);
}
