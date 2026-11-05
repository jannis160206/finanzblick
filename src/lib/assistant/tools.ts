import { detectAction } from "./intent";

// Everything the assistant can do. The model may only pick one of these names.
export const assistantTools = [
  "savings_goal", "expense", "affordability", "query", "briefing", "edit", "rule",
  "remember", "forget", "memory", "changes", "undo", "coach", "depot", "tax", "homeoffice", "help",
] as const;
export type AssistantTool = typeof assistantTools[number];
export const draftTools = ["savings_goal", "expense", "affordability"] as const satisfies readonly AssistantTool[];
export const isDraftTool = (tool: AssistantTool): tool is typeof draftTools[number] => (draftTools as readonly string[]).includes(tool);
export const isAssistantTool = (value: unknown): value is AssistantTool => typeof value === "string" && (assistantTools as readonly string[]).includes(value);

export const toolDescriptions: Record<AssistantTool, string> = {
  savings_goal: "neues Sparziel anlegen oder durchrechnen",
  expense: "neue künftige Ausgabe oder Ratenkauf planen",
  affordability: "prüfen, ob man sich etwas leisten kann",
  query: "Frage zu vergangenen Buchungen, Ausgaben, Einnahmen oder Abos beantworten",
  briefing: "Wochenüberblick: was ist fällig, was hat sich geändert",
  edit: "bestehendes Sparziel, geplante Ausgabe oder Notgroschen-/Urlaubs-/Sparkonto-Ziel ändern, verschieben, aussetzen, umbenennen, löschen oder als erreicht markieren",
  rule: "Händler oder Buchungen einer Kategorie zuordnen, z. B. „Lieferando ist immer Essen“",
  remember: "sich etwas merken, z. B. Puffer oder Gehaltstag",
  forget: "einen gemerkten Eintrag vergessen",
  memory: "zeigen, was sich der Assistent gemerkt hat",
  changes: "Liste der Änderungen des Assistenten zeigen",
  undo: "letzte Änderung rückgängig machen",
  coach: "Spartipps, um monatlich mehr zu sparen",
  depot: "ETF-/Depot-Sparplan mit Zinseszins durchrechnen",
  tax: "absetzbare Buchungen für die Arbeitnehmerveranlagung (Österreich) sammeln",
  homeoffice: "ausrechnen, was man für Home-Office-Sachen (Laptop, Bildschirm, Bürostuhl, Schreibtisch) beim Steuerausgleich zurückbekommt",
  help: "erklären, was der Assistent kann",
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

// Rule-based tool detection; used when the model is unavailable and to keep clear commands deterministic.
export function detectTool(text: string, names: string[] = []): AssistantTool | undefined {
  const lower = text.toLowerCase().trim();
  if (/rückgängig|rueckgaengig|\bundo\b|mach (?:das|es) wieder|zurücknehmen|zuruecknehmen/.test(lower)) return "undo";
  if (/(?:welche|letzte[nr]?|deine|alle)\s+änderungen|änderungsprotokoll|was hast du (?:geändert|gemacht)|protokoll/.test(lower)) return "changes";
  if (/was (?:weißt|weisst) du (?:über|ueber) mich|was hast du dir gemerkt|was merkst du dir|dein gedächtnis|\bgedächtnis\b|\bgedaechtnis\b/.test(lower) &&
    !/vergiss|lösch|merk dir|merke dir/.test(lower)) return "memory";
  if (/\bvergiss\b|vergessen/.test(lower) && !/vergiss nicht/.test(lower)) return "forget";
  if (/merk dir|merke dir|vergiss nicht|denk dran|denk daran|notier|\bpuffer\b.*\bimmer\b|\bimmer\b.*\bpuffer\b|gehalt kommt|gehalt ist (?:immer )?am|gehalt geht/.test(lower)) return "remember";
  if (/home.?office|telearbeit|arbeitsmittel|büroausstattung|bueroausstattung|arbeitsplatz (?:zu ?hause|daheim)|bürostuhl|buerostuhl|schreibtisch/.test(lower) &&
    /steuer|absetz|zurück|zurueck|erstatt|veranlagung|werbungskosten|finanzamt|bekomm|rechne|abzieh|selbstbehalt|pauschale/.test(lower)) return "homeoffice";
  if (/arbeitnehmerveranlagung|steuerausgleich|absetzbar|absetzen|steuerlich|lohnsteuer|werbungskosten|sonderausgaben|finanzonline/.test(lower)) return "tax";
  if (/\betfs?\b|\bdepot\b|investier|aktien|zinseszins|\bsparplan\b|\bmsci\b|\brendite\b|\bfonds\b|vanguard|ishares/.test(lower)) return "depot";
  if (/wochenüberblick|wochenueberblick|überblick|ueberblick|was steht (?:an|diese woche)|was ist (?:diese woche )?fällig|briefing|was gibt'?s neues|zusammenfassung der woche|status/.test(lower) &&
    !/\b(?:im|in|seit)\s+(?:jänner|januar|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/.test(lower)) return "briefing";
  if (/mehr (?:geld )?(?:im monat )?(?:sparen|zur seite|übrig)|wo kann ich (?:\w+ )?sparen|einsparen|sparpotenzial|spartipps?|weniger ausgeben|kosten senken|spar-?coach/.test(lower)) return "coach";
  if (/\bist\s+immer\b|\bsind\s+immer\b|immer als\b|\bordne\b.*\bzu\b|kategorisier|als .{2,30} (?:verbuchen|buchen|einordnen|zuordnen)|in die kategorie|der kategorie/.test(lower)) return "rule";
  if (/^(?:wie ?viel|wieviel|was|wo|wann|wofür|wofuer|wohin|welche[rsn]?|wie oft|hab(?:e)? ich|zeig|liste)\b/.test(lower) && !detectAction(lower) &&
    /ausgegeben|ausgaben|bezahlt|gezahlt|verdient|eingenommen|einnahmen|gekostet|kostet mich|abos?\b|abonnement|größte|teuerste|buchung|überwiesen|wohin|wofür|geht.*weg|verbraucht|durchschnitt/.test(lower)) return "query";
  if (/^(?:wie ?viel|wieviel|was)\b.*\b(?:ausgegeben|bezahlt|eingenommen|verdient)\b/.test(lower)) return "query";
  if (editVerbs.test(lower) && !/\bneue[snr]?\b|anlegen|erstell/.test(lower)) {
    // "Setz mir ein Sparziel …" is a new item unless it names something that already exists.
    const action = detectAction(text);
    const known = mentionsName(text, names) || /notgroschen|urlaubs?(?:ziel|topf|konto)|sparkonto|\b(?:spar)?rate\b|sparziel/.test(lower);
    return action && !known ? action : "edit";
  }
  if (/\bhilfe\b|was kannst du|wie funktionierst du|was geht hier|^\?$/.test(lower)) return "help";
  return detectAction(text);
}
