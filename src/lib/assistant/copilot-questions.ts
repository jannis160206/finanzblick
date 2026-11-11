// Question patterns of the copilot tools; kept free of other assistant imports so the router can use them.

const contractWords = /\b(?:abos?|abonnements?|verträge|vertraege|vertrag|subscriptions?|vertragsordner|versicherungen)\b/;

// "Welche Abos habe ich?", "Wann läuft Netflix aus?", "Kündigungsfrist der Kfz-Versicherung", "Was kostet mich Spotify im Jahr?".
// Cancelling, spending in the past and price increases stay with their own tools.
export const contractsQuestion = (lower: string) =>
  !/\bkündige\b|\bkuendige\b|kann ich .{0,30}kündigen|ausgegeben|bezahlt|gezahlt|teurer geworden|preiserhöh|preiserhoeh|wenn ich|wäre|waere/.test(lower) && (
    contractWords.test(lower) && (
      /^(?:welche|wie ?viele|zeig|liste|übersicht|uebersicht|meine|alle|was (?:sind|für|fuer) (?:meine|alle|für|fuer))\b/.test(lower) ||
      /\b(?:hab(?:e)?|laufen|läuft|laeuft|bald|enden|endet|nächste[nr]?|naechste[nr]?|verlänger\w*|verlaenger\w*)\b/.test(lower) && !/\bmehr als\b|\bweniger als\b/.test(lower)) ||
    /\bwann (?:läuft|laeuft|endet|verlängert|verlaengert|kommt|wird|ist)\b.{1,40}\b(?:aus|ab|zu ende|abgebucht|fällig|faellig|verlängert|verlaengert|kündbar|kuendbar)\b/.test(lower) &&
      !/gehalt|lohn|\bkonto\b|sparziel/.test(lower) ||
    /kündigungsfrist|kuendigungsfrist|mindestlaufzeit|vertragslaufzeit|bis wann (?:kann|muss) ich .{1,40}kündigen|wann muss ich .{1,40}kündigen/.test(lower) ||
    /^was kostet (?:mich|uns) (?!meine\b|mein\b|die\b|alle\b|das\b|es\b)\S.{0,40}\b(?:im jahr|pro jahr|jährlich|jaehrlich)\b/.test(lower) ||
    // "Was kostet mich mein Handyvertrag im Jahr?", "Wie viel kostet mich das Netflix im Jahr?"
    /^(?:was|wie ?viel) kostet (?:mich|uns) (?:mein\w* |das |der |die )?(?:handy\w*|\w*vertrag|abo\w*|\w*versicherung|internet\w*|fitness\w*|streaming\w*|netflix|spotify|disney\S*|magenta|a1|drei)\b.{0,30}\b(?:im jahr|pro jahr|jährlich|jaehrlich|im monat|pro monat|monatlich)\b/.test(lower) ||
    /^(?:wie viel|was) kostet (?:mich|uns) (?:das |der |die )?(?!mein|meine|alle|essen|tanken|lebensmittel)\S+ im jahr\b/.test(lower) ||
    /^(?:was|wie ?viel) kosten (?:mich|uns) (?:alle |meine |die )*(?:abos|verträge|vertraege|versicherungen)\b/.test(lower) ||
    /^(?:welche|welches|welcher) (?:abo|vertrag|versicherung)\w* (?:ist|sind) (?:am )?(?:teuerste|teuersten|günstigste|günstigsten|billigste|billigsten)/.test(lower) ||
    /^(?:welche|zeig\w*(?: mir)?) (?:abos|verträge|vertraege|versicherungen) (?:sind|wurden) teurer/.test(lower));

// "Was ist mit den angezeigten Buchungen?", "Fass die ausgewählten Buchungen zusammen", "Was siehst du hier?".
export const contextQuestion = (lower: string) =>
  !/\b(?:markier|lösch|loesch|ordne|kategorisier|benenn|ignorier|nimm|verschieb|setz)\w*/.test(lower) && (
    /\b(?:diese[nrs]?|die|den|alle)\s+(?:hier\s+|gerade\s+|aktuell\s+|oben\s+)?(?:angezeigten|ausgewählten|ausgewaehlten|markierten|gefilterten|sichtbaren|gezeigten)\b/.test(lower) ||
    /\b(?:auf|in) (?:dieser|der) (?:seite|ansicht|liste)\b|\bhier (?:angezeigt|zu sehen|gezeigt)|\b(?:meine|die) auswahl\b|was (?:siehst|sehe) (?:du|ich) (?:hier|gerade)|\b(?:bei|von|in|für|fuer|mit) diesen (?:buchungen|umsätzen|umsaetzen|einträgen|eintraegen)\b|^(?:und )?(?:was ist mit )?diese[nr]? (?:buchungen|umsätze|umsaetze|einträgen?|eintraegen?)\b/.test(lower));

// "Was fällt dir auf?", "Gibt es Auffälligkeiten?", "Worauf sollte ich achten?".
export const insightsQuestion = (lower: string) =>
  /was (?:fällt|faellt) dir (?:\S+ ){0,2}auf|was ist dir (?:\S+ ){0,2}aufgefallen|auffälligkeiten|auffaelligkeiten|worauf (?:sollte|soll|muss) ich (?:\S+ ){0,3}achten|was sollte ich (?:\S+ ){0,3}wissen|deine hinweise|(?:zeig|gib) mir (?:\S+ ){0,2}hinweise|gibt es (?:etwas|was) (?:wichtiges|neues|zu beachten)|hast du (?:\S+ ){0,2}(?:hinweise|tipps für mich|warnungen)/.test(lower);
