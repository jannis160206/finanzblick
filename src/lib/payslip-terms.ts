import type { PayslipLogLookup } from "@/lib/payslip-log";
import type { KnowledgeHit } from "@/lib/web/knowledge";

/**
 * Explanations for terms that the payslip parser and the plausibility checks name themselves. Free text of a
 * payslip (e.g. the label of an unknown wage type) never gets here: the parser keeps it out of its hints on purpose.
 * `unclear` terms are not fully explained by the payslip itself; only they may be looked up online, and only when the
 * user allowed it.
 */
type GlossaryEntry = { term: string; pattern: RegExp; text: string; unclear?: true };

const GLOSSARY: readonly GlossaryEntry[] = [
  {
    term: "VEB-Prämie", pattern: /VEB-Prämie/i, unclear: true,
    text: "Prämie, die die Abrechnung als SV-Sonderzahlung mit laufendem Lohnsteuertarif ausweist. Ob sie das Jahressechstel erhöht, steht nicht im Beleg; Finanzblick rechnet deshalb mit einer Spanne. Was die Abkürzung bedeutet, erklärt die Abrechnung nicht.",
  },
  {
    term: "Jahressechstel", pattern: /sechstel/i,
    text: "Ein Sechstel der laufenden Bezüge eines Jahres. Bis zu dieser Grenze werden Sonderzahlungen begünstigt besteuert: nach der SV mit 6 %, die ersten 620 € im Jahr steuerfrei (§ 67 EStG).",
  },
  {
    term: "Sonderzahlung", pattern: /sonderzahlung/i,
    text: "Urlaubszuschuss und Weihnachtsremuneration (13. und 14. Bezug), meist im Juni und November; innerhalb des Jahressechstels begünstigt besteuert.",
  },
  {
    term: "Lohnart", pattern: /lohnart/i,
    text: "Arbeitgeberinterne Nummer eines Bezugsbestandteils. Ohne Bezeichnung lässt sie sich steuerlich nicht zuordnen; solche Abrechnungen übernimmt Finanzblick nicht automatisch.",
  },
  {
    term: "Lohnsteuer-Bemessungsgrundlage", pattern: /bemessungsgrundlage|lst-basis/i,
    text: "Betrag, von dem die laufende Lohnsteuer berechnet wird: laufendes Brutto abzüglich SV und steuerfreier Bezüge.",
  },
  {
    term: "Teilmonat", pattern: /teilmonat/i,
    text: "Abrechnung über weniger als einen vollen Monat, etwa bei Eintritt oder Austritt. Eine Hochrechnung aufs Jahr ist damit nicht möglich.",
  },
  {
    term: "BUAG / BUAK", pattern: /\bBUA[GK]\b/,
    text: "Bauarbeiter-Urlaubs- und Abfertigungsgesetz bzw. -kasse: Urlaubsentgelt und Sonderzahlungen laufen über die Kasse statt über den Arbeitgeber.",
  },
  {
    term: "Lehrverhältnis", pattern: /lehr(?:ling|verhältnis)/i,
    text: "Für Lehrlinge gelten eigene SV-Beiträge; das Standardmodell der Prognose ist dafür nicht ausgelegt.",
  },
  {
    term: "Akonto", pattern: /akonto|bereits überwiesen/i,
    text: "Vorab überwiesener Teil des Gehalts. Der Rest – etwa Rufbereitschaft, Feiertagsarbeit und Überstunden – kommt als eigene Auszahlung.",
  },
  {
    term: "Rufbereitschaft", pattern: /rufbereitschaft/i,
    text: "Pauschale für die Erreichbarkeit außerhalb der Arbeitszeit. Dienste an Feiertagen werden oft zusätzlich als Rufbereitschaft verbucht; Finanzblick zählt den Teil über der üblichen Pauschale als Feiertagsarbeit.",
  },
  {
    term: "Kumulierte Werte", pattern: /kumuliert/i,
    text: "Jahressummen bis zum Abrechnungsmonat, etwa das laufende Brutto seit Jänner. Damit lassen sich die Monatswerte gegenprüfen.",
  },
];

const MAX_TERMS = 6;

/**
 * Explains the terms found in the given hints from the local glossary. Unclear terms are marked for an online lookup
 * when `online` is allowed (returned in `pending`), otherwise as not looked up.
 */
export function glossaryLookups(texts: readonly string[], options: { online?: boolean } = {}) {
  const found = GLOSSARY.filter((entry) => texts.some((text) => entry.pattern.test(text))).slice(0, MAX_TERMS);
  const lookups: PayslipLogLookup[] = found.map((entry) => ({ term: entry.term, source: "glossar", text: entry.text }));
  const unclear = found.filter((entry) => entry.unclear).map((entry) => entry.term);
  if (!options.online) lookups.push(...unclear.map((term) => ({ term, source: "nicht-nachgeschlagen" as const })));
  return { lookups, pending: options.online ? unclear : [] };
}

/** The online fallback for unclear terms: one lookup each, never blocking the import; failures are recorded. */
export async function lookupPendingTerms(
  pending: readonly string[],
  lookup: (term: string) => Promise<KnowledgeHit | null | undefined>,
): Promise<PayslipLogLookup[]> {
  return Promise.all(pending.map(async (term): Promise<PayslipLogLookup> => {
    try {
      const hit = await lookup(term);
      return hit ? { term, source: "wikipedia", title: hit.title, text: hit.text, url: hit.url } : { term, source: "ohne-treffer" };
    } catch {
      return { term, source: "fehler" };
    }
  }));
}

/** Glossary first, then – only if allowed – the online lookup for what stays unclear. */
export async function explainPayslipTerms(
  texts: readonly string[],
  options: { online?: boolean; lookup?: (term: string) => Promise<KnowledgeHit | null | undefined> } = {},
): Promise<PayslipLogLookup[]> {
  const { lookups, pending } = glossaryLookups(texts, { online: options.online && !!options.lookup });
  return pending.length && options.lookup ? [...lookups, ...await lookupPendingTerms(pending, options.lookup)] : lookups;
}
