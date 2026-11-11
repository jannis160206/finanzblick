import type { Dashboard } from "@/lib/calc";
import { currency, dateLabel, percent } from "@/lib/format";
import { DEFAULT_ASAP_RESERVE, DEFAULT_SAVINGS_RATE, SAVINGS_FLOOR, savingsGoals } from "@/lib/goals";
import type { AppState, AssistantCard } from "@/lib/types";

type Line = AssistantCard["lines"][number];
type Topic = {
  id: string;
  title: string;
  test: RegExp;
  page?: string;
  about: string[];
  live?: (state: AppState, dashboard: Dashboard) => Line[];
  // What the user can say in the chat to change this area.
  say: string[];
};

const goalLines = (state: AppState): Line[] => savingsGoals(state).filter((goal) => !goal.completedAt).slice(0, 12).map((goal) => {
  const extras = Object.entries(goal.funding?.extras ?? {}).filter(([, value]) => value > 0);
  return { label: `${goal.name}: ${currency(goal.target)} bis ${dateLabel(goal.date)}`, tone: "info",
    detail: `${goal.funding ? `${currency(goal.funding.monthly)} / Monat` : "automatisch aus dem Überschuss"}` +
      `${extras.length ? ` · ${extras.length} Extra-${extras.length === 1 ? "Betrag" : "Beträge"}` : ""}` +
      `${goal.funding?.paused?.length ? ` · ${goal.funding.paused.length} ausgesetzt` : ""}` };
});

const topics: Topic[] = [
  {
    id: "goals", title: "Sparziele", page: "Pockets", test: /sparziel|\bziele?\b|sparrate|extra|zusätzlich|aussetz|startkapital|anspar/,
    about: [
      `Jeden Monat geht zuerst der Sparanteil aufs Sparkonto (Standard ${percent(DEFAULT_SAVINGS_RATE)} des Überschusses, mindestens ${currency(SAVINGS_FLOOR)}). Danach bekommen die Sparziele ihren Anteil, das mit dem frühesten Datum zuerst.`,
      `Bei „So schnell wie möglich“ bleibt eine Reserve auf dem Konto (Standard ${percent(DEFAULT_ASAP_RESERVE)} des freien Betrags). Guthaben auf Sparkonto oder Trade Republic fließt nur einmalig und nur über dem Behalten-Betrag ins Ziel.`,
      "Ein Ziel mit fester Monatsrate bekommt höchstens diese Rate. Ein Ziel ohne feste Rate wird automatisch aus dem Überschuss befüllt.",
      "Extra-Beträge kommen zusätzlich zur Rate dazu, z. B. die ersten 2 Monate je 60 € vom Sparkonto. Kommt das Geld von einem Pocket, wird es dort als Entnahme eingeplant.",
      "Einzelne Monate lassen sich aussetzen. Ist ein Ziel erreicht, markierst du es als erreicht.",
    ],
    live: (state) => goalLines(state),
    say: ["Ich will bis Juli 2027 3.000 € für Japan sparen, die ersten 2 Monate je 60 € vom Sparkonto", "Nimm für Japan die nächsten 3 Monate je 50 € extra aus dem Notgroschen",
      "Setz die Japan-Rate im Mai aus", "Erhöhe Japan auf 4.000 €", "Japan-Rate auf 250 €", "Schieb Japan auf Oktober"],
  },
  {
    id: "pockets", title: "Pockets und Konten", page: "Pockets", test: /pocket|notgroschen|urlaubs?|sparkonto|motorrad|töpfe|toepfe|konten\b|konto\b|vermögen|vermoegen/,
    about: [
      "Pockets sind die Töpfe für dein Geld: Notgroschen (Trade Republic mit Zinsen), Urlaub, Sparkonto und Motorrad. Sparziele mit eigenem Namen bekommen einen eigenen Pocket bei Revolut.",
      "Für Notgroschen, Urlaub und Sparkonto gibt es je einen Zielbetrag. Der Überschuss, der nach Sparkonto und Sparzielen übrig bleibt, geht in den Urlaub.",
    ],
    live: (state, dashboard) => [
      { label: "Notgroschen-Ziel", value: state.settings.emergencyTarget },
      { label: "Urlaubs-Ziel", value: state.settings.vacationTarget },
      { label: "Sparkonto-Ziel", value: state.settings.savingsTarget },
      { label: "Vermögen gesamt", value: dashboard.totalAssets },
    ],
    say: ["Setz das Notgroschen-Ziel auf 10.000 €", "Urlaubsziel auf 2.500 €", "Sparkonto-Ziel auf 5.000 €"],
  },
  {
    id: "planned", title: "Geplante Ausgaben", page: "Übersicht und Monate", test: /geplant|ratenkauf|\braten\b|kommende ausgabe|vorhaben|anschaffung/,
    about: [
      "Geplante Ausgaben sind einmalige Zahlungen oder Ratenkäufe in der Zukunft. Sie werden im Monatsplan vom Überschuss abgezogen.",
      "Kommt die echte Buchung, wird sie automatisch zugeordnet. Geteilte Ausgaben mit Raphael zählen nur zur Hälfte.",
    ],
    live: (state) => (state.plannedOneOffs ?? []).slice(-8).map((item) => ({ label: item.name, value: -(item.total ?? item.amount * item.installments),
      detail: `${dateLabel(item.date)}${item.installments > 1 ? ` · ${item.installments} Raten` : ""}` })),
    say: ["Im März kommt das Pickerl, ca. 400 €", "Laptop 1.200 € in 6 Raten ab Mai", "Schieb das Pickerl auf April", "Kann ich mir im Mai einen Fernseher um 900 € leisten?"],
  },
  {
    id: "transactions", title: "Umsätze, Import und Kategorien", page: "Umsätze",
    test: /umsätze|umsaetze|import|csv|hochlad|kategori|regel|prüfliste|pruefliste|ki.?prüf|ki.?zuordn|händler|haendler|paypal|amex|revolut|trade republic/,
    about: [
      "Unter Umsätze lädst du Auszüge hoch: Raiffeisen, Amex, Revolut, PayPal und Trade Republic. Doppelte Buchungen werden erkannt.",
      "Über die Bankverbindung kommen Raiffeisen, Revolut und Trade Republic alle 6 Stunden automatisch. Der Trade-Republic-Kontostand ist dein Notgroschen. PayPal ergänzt bei „…/PAYPAL“-Abbuchungen den echten Shop, ohne Buchungen doppelt anzulegen.",
      "Jede Buchung bekommt eine Kategorie: zuerst feste Händlerregeln, dann deine bisherigen Zuordnungen, dann die lokale KI. Unsichere Fälle landen in der Prüfliste.",
      "Bestätigst du eine Zuordnung, merkt sich das Dashboard den Händler für künftige Importe.",
    ],
    live: (state) => [{ label: "Buchungen gesamt", detail: String(state.transactions.length) },
      { label: "Händlerregeln", detail: String((state.merchantRules ?? []).length) }],
    say: ["Lieferando ist immer Lieferdienste", "Ordne Spar Lebensmittel zu", "Wie viel hab ich im Oktober fürs Essen ausgegeben?"],
  },
  {
    id: "months", title: "Monatsplan und Überschuss", page: "Monate", test: /monate\b|monatsplan|überschuss|ueberschuss|fixkosten|einnahmen|was bleibt|monatsübersicht/,
    about: [
      "Der Monatsplan rechnet: Einnahmen minus Fixkosten, minus Budget für variable Ausgaben, minus geplante Ausgaben. Was übrig bleibt, ist der Überschuss.",
      "Den Überschuss verteilt der Plan auf Sparkonto, Sparziele und Urlaub. Unter Monate siehst du pro Monat, wie viel in welchen Pocket geht.",
    ],
    live: (_state, dashboard) => {
      const row = dashboard.timeline.find((item) => item.month === dashboard.currentMonth);
      return row ? [{ label: "Einnahmen diesen Monat", value: row.income }, { label: "Fixkosten", value: -row.fixed }, { label: "Überschuss", value: row.surplus }] : [];
    },
    say: ["Gib mir den Wochenüberblick", "Wie viel kann ich diesen Monat noch ausgeben?", "Ich will 200 € mehr im Monat sparen"],
  },
  {
    id: "budget", title: "Budgetdetails", page: "Budgetdetails", test: /budget/,
    about: ["Budgetdetails zeigt das Budget für variable Ausgaben (z. B. Lebensmittel, Freizeit) nach Gruppen und wie viel davon schon verbraucht ist."],
    say: ["Wie viel hab ich diesen Monat für Lebensmittel ausgegeben?", "Wo kann ich sparen?"],
  },
  {
    id: "salary", title: "Gehalt und Steuern", page: "Gehalt & Steuern", test: /gehalt|lohn|steuer|sechstel|veranlagung|home.?office|absetz/,
    about: [
      "Gehalt & Steuern rechnet Brutto in Netto um, inklusive Sonderzahlungen und Jahressechstel.",
      "Im Chat sammle ich absetzbare Buchungen für die Arbeitnehmerveranlagung und rechne Home-Office-Ausgaben nach.",
    ],
    say: ["Was kann ich bei der Arbeitnehmerveranlagung absetzen?", "Was bekomme ich für meine Home-Office-Sachen zurück?", "Merk dir: Gehalt kommt am 25."],
  },
  {
    id: "settings", title: "Einstellungen", page: "Einstellungen", test: /einstell|stichtag|zinss?atz|zinsen|startstand|startstände/,
    about: ["In den Einstellungen legst du Stichtag, Startstände der Pockets und Zielbeträge fest. Den Trade-Republic-Zinssatz liest Finanzblick aus den Zinsgutschriften der Bank. Die Zielbeträge kann ich auch per Chat ändern."],
    live: (state) => [{ label: "Stichtag", detail: dateLabel(state.settings.asOf) }],
    say: ["Setz das Notgroschen-Ziel auf 10.000 €"],
  },
  {
    id: "assistant", title: "Finanz-Assistent", page: "Finanz-Assistent", test: /assistent|chat|rückgängig|rueckgaengig|gedächtnis|gedaechtnis|\bki\b/,
    about: [
      "Die KI läuft lokal auf der NPU und wählt nur aus, was zu tun ist. Alle Beträge rechnet der Code.",
      "Änderungen zeige ich vorher als Karte mit Vorher und Nachher. Gespeichert wird erst nach deinem Klick, und jede Änderung lässt sich rückgängig machen.",
    ],
    say: ["Was hast du geändert?", "Mach das rückgängig", "Was hast du dir gemerkt?"],
  },
];

// "Was ist ein Notgroschen?" first says what the word means; the card then shows how it works here.
const terms: [RegExp, string][] = [
  [/notgroschen/, "Der Notgroschen ist deine Reserve für Unerwartetes wie eine Reparatur oder eine kaputte Waschmaschine – üblich sind drei bis sechs Monatsausgaben auf einem täglich verfügbaren Konto."],
  [/überschuss|ueberschuss/, "Der Überschuss ist das Geld, das im Monat nach Fixkosten, Budgets, Sparkonto und Sparzielen übrig bleibt; bei dir geht er in den Urlaub."],
  [/pockets?/, "Pockets sind getrennte Töpfe für dein Geld, etwa Notgroschen, Urlaub, Sparkonto oder ein eigenes Sparziel."],
  [/sparziele?/, "Ein Sparziel ist ein Betrag, den du bis zu einem Datum ansparen willst; ich rechne dir die nötige Monatsrate aus."],
  [/monatsplan/, "Der Monatsplan stellt Einnahmen, Fixkosten, Budgets und Sparraten eines Monats gegenüber und zeigt, was übrig bleibt."],
];
const termQuestion = /^(?:und\s+)?was (?:ist|sind|bedeutet|bedeuten|heißt|heisst) (?:eigentlich )?(?:ein |eine |der |die |das |den )?/;

// Answers questions about the dashboard itself; texts are fixed, live values come from the current data.
export function explainDashboard(state: AppState, dashboard: Dashboard, text: string): { text: string; card: AssistantCard } {
  const lower = text.toLowerCase();
  const matched = topics.filter((topic) => topic.test.test(lower));
  const general = /was kann ich (?:hier |im dashboard |damit )?(?:alles )?(?:einstellen|ändern|aendern|konfigurieren|machen|anpassen)|welche (?:möglichkeiten|moeglichkeiten|einstellungen|funktionen|bereiche)|was gibt es (?:alles|für|fuer)|dashboard/.test(lower);
  const specific = matched.filter((topic) => topic.id !== "settings" && topic.id !== "assistant");
  const overview = !matched.length || general && !specific.length;
  if (overview) {
    return { text: "Das Dashboard hat diese Bereiche. Zu jedem kann ich dir mehr erklären, und vieles kann ich direkt hier im Chat für dich einstellen:",
      card: { kind: "answer", title: "Was du im Finanzdashboard machen kannst", lines: topics.map((topic) => ({
        label: `${topic.title}${topic.page ? ` · Seite ${topic.page}` : ""}`, detail: `z. B. „${topic.say[0]}“`.slice(0, 300) })),
      note: "Frag nach einem Bereich, z. B. „Wie funktionieren die Sparziele?“. Änderungen speichere ich erst, wenn du bestätigst." } };
  }
  const topic = matched[0];
  const live = topic.live?.(state, dashboard) ?? [];
  const lines: Line[] = [
    ...topic.about.map((about) => ({ label: about.slice(0, 200) })),
    ...live.slice(0, 20),
    ...topic.say.map((say) => ({ label: `„${say}“`.slice(0, 200), detail: "kannst du mir so schreiben", tone: "good" as const })),
  ].slice(0, 40);
  const meaning = termQuestion.test(lower) ? terms.find(([pattern]) => pattern.test(lower))?.[1] : undefined;
  return { text: meaning ? `${meaning} Wie es bei dir aussieht, siehst du unten.`
    : `${topic.title}${topic.page ? ` (Seite „${topic.page}“)` : ""}: So funktioniert es, so steht es gerade, und das kann ich für dich einstellen.`,
    card: { kind: "answer", title: topic.title, lines,
      ...(matched.length > 1 ? { note: `Passt auch zu: ${matched.slice(1).map((item) => item.title).join(", ")}.` } : {}) } };
}
