import { addMonths, round, type Dashboard } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { corePocket, physicalPocketBalances, pocketKey } from "@/lib/goals";
import { pocketNames, type AppState, type AssistantCard, type Transaction } from "@/lib/types";
import type { AgentResult } from "./agent";
import { parseDateRange } from "./answers";
import { matchName } from "./tools";

type Line = AssistantCard["lines"][number];
const isAmex = (row: Transaction) => /^(?:amex|american express)$/i.test(row.bank.trim());
const amexRepayment = (row: Transaction) => row.amount > 0 && /zahlung\s*\/\s*überweisung\s+erhalten/i.test([row.description, row.rawDescription].join(" "));
const reserveKey = (key: string) => /^(?:amex(?: jannis| konto| pocket| rückzahlung| ruckzahlung| rueckzahlung)?|american express)$/.test(key);
const amexWords = /\bamex\b|american express|kreditkarte/;

export const amexQuestion = (lower: string) => amexWords.test(lower) &&
  /abrechnung|überweis|rückzahl|zurückzahl|offen|saldo|schuld|bezahlen|begleichen|ausgleich|fällig|stand|fehlt|reicht|deck|zusammen|gegen|rechne|kostet|wie viel (?:ist|steht) (?:auf|bei)/.test(lower);
export const balanceQuestion = (lower: string) =>
  /kontost(?:a|ä)nde?|\bvermögen|\bguthaben|\bsaldo\b|erspar(?:nisse|tes)|wie viel geld hab(?:e)? ich(?: (?:noch|gerade|aktuell|jetzt|insgesamt|gespart))*\s*\??$|was hab(?:e)? ich (?:alles )?(?:auf|gespart)/.test(lower) ||
  /\bwie viel\b.*\b(?:ist|liegt|liegen|hab(?:e)?|sind)\b.*\b(?:auf (?:dem|meinem|der|meiner)|im|am)\b.*\b(?:konto|pocket|notgroschen|sparkonto|tagesgeld|depot|urlaub|motorrad)\b/.test(lower);
export const budgetQuestion = (lower: string) =>
  /wie viel (?:kann|darf) ich (?:diesen monat |im \w+ |heuer |noch |jetzt )*(?:noch )?(?:ausgeben|verbrauchen|verballern|verprassen)\b/.test(lower) ||
  /was bleibt (?:mir )?(?:diesen monat |im \w+ |noch |am ende )*(?:noch )?(?:übrig|über)\b|was bleibt (?:mir )?(?:noch )?(?:diesen|im|nächsten|kommenden) (?:monat|\w+)\b(?! für)|wie viel bleibt (?:mir )?(?:diesen monat |im \w+ |noch |am monatsende )*(?:übrig|über)|\büberschuss\b(?! erklär)/.test(lower) ||
  /^(?:mein |der )?(?:monatsplan|monatsbudget|budget)(?: (?:für |im )?(?:diesen monat|\w+))?\??$/.test(lower) ||
  /wie (?:sieht|schaut) (?:mein |der )?(?:monat|monatsplan|budget)\b/.test(lower);

export function balances(state: AppState, dashboard: Dashboard) {
  const names = new Map<string, string>();
  const add = (name: string | null | undefined) => {
    if (!name) return;
    const key = pocketKey(name);
    if (!names.has(key)) names.set(key, corePocket(name) ?? name.replace(/\s*\(EUR\)$/i, "").trim());
  };
  pocketNames.forEach(add);
  (state.accountSnapshots ?? []).forEach((item) => add(item.name));
  (state.pocketSnapshots ?? []).forEach((item) => add(item.pocket));
  state.transactions.forEach((row) => { if (row.bank === "Revolut") add(row.pocket); });
  const physical = physicalPocketBalances(state, dashboard.actual);
  return Object.entries(physical).map(([key, balance]) => ({ key, name: names.get(key) ?? key, amount: balance.amount }));
}

// Card bill vs. the Revolut pocket that collects the repayment; same calculation as the dashboard.
export function amexSettlement(state: AppState, dashboard: Dashboard, text: string, today: string): AgentResult {
  const amex = dashboard.amex;
  const snapshot = (state.amexBalanceSnapshots ?? []).filter((item) => item.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date) || b.periodStart.localeCompare(a.periodStart))[0];
  const pocket = balances(state, dashboard).find((item) => reserveKey(item.key));
  const pocketName = pocket?.name ?? "Amex Rückzahlung";
  const partner = round(amex.outstanding - amex.ownOutstanding);
  const lines: Line[] = [
    { label: "Offen bei Amex", value: amex.outstanding,
      detail: snapshot ? `Abrechnung seit ${dateLabel(snapshot.periodStart)} · Saldo vom ${dateLabel(snapshot.date)}` : "aus deinen Amex-Buchungen" },
  ];
  if (partner > 0.005) lines.push({ label: "davon Raphaels Anteil", value: partner, detail: "geteilte Buchungen", tone: "info" });
  lines.push({ label: `Auf „${pocketName}“`, value: amex.reserved, tone: "info" });
  const range = parseDateRange(text, today);
  const rows = range ? state.transactions.filter((row) => isAmex(row) && row.date >= range.from && row.date <= range.to && !amexRepayment(row)) : [];
  if (range && rows.length) {
    const spent = round(rows.reduce((sum, row) => sum - row.amount, 0));
    lines.push({ label: `Amex-Buchungen ${range.label}`, value: spent, detail: `${rows.length} Buchungen abzüglich Gutschriften`,
      transactionIds: [...rows].sort((a, b) => a.amount - b.amount).slice(0, 50).map((row) => row.id) });
  }
  const gapAll = round(Math.max(0, amex.outstanding - amex.reserved));
  if (amex.shortfall > 0.005) lines.push({ label: "Noch zu überweisen (dein Anteil)", value: amex.shortfall, tone: "bad" });
  else lines.push({ label: "Gedeckt, übrig", value: round(amex.reserved - amex.ownOutstanding), tone: "good" });
  if (partner > 0.005 && gapAll > amex.shortfall + 0.005) lines.push({ label: "Inklusive Raphaels Anteil", value: gapAll, tone: "warn" });
  const intro = `Bei Amex sind ${currency(amex.outstanding)} offen${snapshot ? ` (Abrechnung seit ${dateLabel(snapshot.periodStart)})` : ""}` +
    (partner > 0.005 ? `, davon ${currency(amex.ownOutstanding)} deine.` : ".") + ` Auf „${pocketName}“ liegen ${currency(amex.reserved)}.`;
  const outcome = amex.shortfall > 0.005
    ? ` Du musst noch ${currency(amex.shortfall)} auf „${pocketName}“ überweisen` +
      (partner > 0.005 && gapAll > amex.shortfall + 0.005 ? `, mit Raphaels Anteil wären es ${currency(gapAll)}.` : ".")
    : ` Das reicht, es bleiben ${currency(round(amex.reserved - amex.ownOutstanding))} übrig.`;
  return { text: intro + outcome,
    card: { kind: "answer", title: "Amex-Abrechnung", total: amex.shortfall, lines, ...(rows.length ? { transactionIds: rows.slice(0, 50).map((row) => row.id) } : {}),
      note: "Gleiche Rechnung wie im Dashboard: offener Amex-Saldo minus Guthaben auf dem Rückzahlungs-Pocket." },
    suggestions: ["Was habe ich seit 11.10. mit Amex bezahlt?", "Zeig mir meine Kontostände", "Was bleibt mir diesen Monat?"] };
}

export function accountBalances(state: AppState, dashboard: Dashboard, text: string): AgentResult {
  const all = balances(state, dashboard);
  const named = matchName(text, all, (item) => item.name);
  if (named) {
    return { text: named.amount === null ? `Für „${named.name}“ kenne ich gerade keinen sicheren Kontostand.`
      : `Auf „${named.name}“ liegen ${currency(named.amount)}.`,
    card: { kind: "answer", title: `Kontostand · ${named.name}`, ...(named.amount !== null ? { total: named.amount } : {}),
      lines: [{ label: named.name, ...(named.amount !== null ? { value: named.amount } : { detail: "unbekannt" }) }] },
    suggestions: ["Zeig mir alle Kontostände", "Was bleibt mir diesen Monat?"] };
  }
  const shown = all.filter((item) => item.amount === null || Math.abs(item.amount) >= 0.005).sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
  const lines: Line[] = shown.slice(0, 20).map((item) => item.amount === null ? { label: item.name, detail: "unbekannt", tone: "warn" as const }
    : { label: item.name, value: item.amount, ...(reserveKey(item.key) ? { detail: "für die Amex-Abrechnung reserviert" } : {}) });
  if (dashboard.amex.outstanding > 0) lines.push({ label: "Amex-Saldo offen", value: -dashboard.amex.outstanding, tone: "warn", detail: "Kreditkarte, noch nicht abgebucht" });
  const empty = all.length - shown.length;
  return { text: `Deine Ersparnisse liegen gesamt bei ${currency(dashboard.totalAssets)}.` +
    (shown.length ? ` Am meisten liegt auf „${shown[0].name}“.` : ""),
  card: { kind: "answer", title: "Kontostände", total: dashboard.totalAssets, lines,
    ...(empty ? { note: `${empty} leere Pockets ausgeblendet. Girokonten ohne Kontostand-Import sind nicht enthalten.` } : {}) },
  suggestions: ["Wie viel muss ich auf Amex Rückzahlung überweisen?", "Was bleibt mir diesen Monat?"] };
}

const monthWords: [string, number][] = [["jänner", 1], ["januar", 1], ["februar", 2], ["märz", 3], ["april", 4], ["mai", 5], ["juni", 6],
  ["juli", 7], ["august", 8], ["september", 9], ["oktober", 10], ["november", 11], ["dezember", 12]];

// The monthly plan looks forward: "im Mai" means the next May.
export function monthBudget(dashboard: Dashboard, text: string): AgentResult {
  const lower = text.toLowerCase();
  let month = dashboard.currentMonth;
  if (/nächste[nm]? monat/.test(lower)) month = addMonths(month, 1);
  for (const [word, value] of monthWords) {
    const match = new RegExp(`\\b${word}\\b(?:\\s+(20\\d{2}))?`).exec(lower);
    if (!match) continue;
    const year = Number(match[1] ?? dashboard.currentMonth.slice(0, 4));
    month = `${year}-${String(value).padStart(2, "0")}`;
    if (!match[1] && month < dashboard.currentMonth) month = `${year + 1}-${String(value).padStart(2, "0")}`;
    break;
  }
  const row = dashboard.timeline.find((item) => item.month === month) ?? (month === dashboard.currentMonth ? dashboard.current : undefined);
  if (!row) return { text: `Für ${monthLabel(month)} habe ich noch keinen Monatsplan.` };
  const current = month === dashboard.currentMonth;
  const everyday = round(row.variablePlan - row.amexOpen);
  const lines: Line[] = [
    { label: "Einnahmen", value: row.income, tone: "good" },
    { label: "Fixkosten", value: -row.fixed },
    { label: "Alltagsbudget", value: -everyday, detail: "Essen, Einkaufen, Tanken & Co." },
    ...(row.amexOpen > 0 ? [{ label: "Amex-Lücke", value: -row.amexOpen, detail: "fehlt noch auf dem Rückzahlungs-Pocket", tone: "warn" as const }] : []),
    ...(row.plannedOneOffs ? [{ label: "Geplante Ausgaben", value: -row.plannedOneOffs }] : []),
    { label: "Überschuss laut Plan", value: row.surplus, tone: row.surplus >= 0 ? "good" as const : "bad" as const },
  ];
  if (current) lines.push({ label: "Bisher ausgegeben (Ist)", value: row.actualSpending, detail: "gebuchte Ausgaben ohne Umbuchungen", tone: "info" });
  const reply = row.surplus >= 0
    ? `${current ? "Diesen Monat" : `Im ${monthLabel(month)}`} bleiben dir laut Plan ${currency(row.surplus)} übrig, nach Fixkosten, Alltagsbudget${row.amexOpen > 0 ? ", Amex" : ""} und geplanten Ausgaben.`
    : `${current ? "Diesen Monat" : `Im ${monthLabel(month)}`} fehlen laut Plan ${currency(-row.surplus)}. Schau dir die geplanten Ausgaben an oder verschiebe etwas.`;
  return { text: reply, card: { kind: "answer", title: `Monatsplan · ${monthLabel(month)}`, total: row.surplus, month, lines },
    suggestions: ["Kann ich mir im Mai 900 € leisten?", "Wo kann ich sparen?", "Zeig mir meine Kontostände"] };
}
