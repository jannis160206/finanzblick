import { round } from "@/lib/calc";
import { currency, dateLabel } from "@/lib/format";
import { matchPlannedOneOffs } from "@/lib/planned-one-offs";
import type { AppState, AssistantCard } from "@/lib/types";
import { PLANNED_PREFIX } from "@/lib/mail/reconcile";

type Line = AssistantCard["lines"][number];

// Orders recognised from Gmail are mirrored as planned payments with the "mail-" prefix.
export const ordersQuestion = (lower: string) =>
  /\bbestellung(?:en)?\b|\bbestellt\b|online.?(?:käufe|kaeufe|einkäufe|einkaeufe|shopping)|\bpakete?\b.*(?:zahl|bezahl|offen)|\bklarna\b|\bratenkauf|später bezahl|spaeter bezahl|\bkauf auf rechnung\b|offene rechnungen?\b|\b(?:e-?mail|gmail|mails?)\b.*(?:zahl|bestell|rechnung)/.test(lower) &&
  !/\b(?:rückgängig|lösch|kategorie)\b/.test(lower);

export function ordersAnswer(state: AppState, today: string): { text: string; card: AssistantCard; suggestions: string[] } {
  const orders = (state.plannedOneOffs ?? []).filter((item) => item.id.startsWith(PLANNED_PREFIX));
  const occurrences = matchPlannedOneOffs(orders, state.transactions).filter((item) => !item.bookingId);
  const overdue = occurrences.filter((item) => item.date < today);
  const soon = occurrences.filter((item) => item.date >= today);
  const open = round(occurrences.reduce((sum, item) => sum + item.ownAmount, 0));
  const until14 = round(soon.filter((item) => item.date <= new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10))
    .reduce((sum, item) => sum + item.ownAmount, 0));
  const lines: Line[] = occurrences.slice(0, 40).map((item) => ({
    label: item.name, value: -item.ownAmount, tone: item.date < today ? "warn" : "info",
    detail: item.date < today ? `war fällig am ${dateLabel(item.date)} – noch keine Abbuchung gefunden` : `fällig ${dateLabel(item.date)}`,
  }));
  if (!orders.length) return {
    text: "Ich habe gerade keine offenen Bestellungen vorgemerkt. Verbinde unter Einstellungen → E-Mail-Bestellungen dein Gmail-Konto, dann erkenne ich Bestellbestätigungen (auch Klarna, PayPal und Kauf auf Rechnung) und plane die Zahlung automatisch ein.",
    card: { kind: "answer", title: "Offene Bestellungen", total: 0, lines: [], note: "Bestellungen kommen aus Gmail (nur lesend) und verschwinden automatisch, sobald die Abbuchung da ist oder storniert wurde." },
    suggestions: ["Was kommt diesen Monat noch vom Konto?", "Wird mein Konto knapp?"],
  };
  const parts = [
    occurrences.length
      ? `Du hast ${occurrences.length === 1 ? "eine offene Zahlung" : `${occurrences.length} offene Zahlungen`} aus Bestellungen über insgesamt ${currency(open)}.`
      : "Alle vorgemerkten Bestellungen sind bereits abgebucht.",
    until14 > 0 ? `In den nächsten 14 Tagen werden davon ${currency(until14)} fällig.` : "",
    overdue.length ? `Bei ${overdue.length === 1 ? overdue[0].name : `${overdue.length} Bestellungen`} ist die Abbuchung überfällig – kurz prüfen, ob die Zahlung durchging.` : "",
  ].filter(Boolean);
  return {
    text: parts.join(" "),
    card: { kind: "answer", title: "Offene Bestellungen", total: -open, lines,
      note: "Aus Gmail erkannt (nur lesend). Wird mit dem Bankumsatz abgeglichen und ist in Prognose und Tagesbudget schon eingerechnet." },
    suggestions: ["Wie viel kann ich heute noch ausgeben?", "Wird mein Konto knapp?"],
  };
}
