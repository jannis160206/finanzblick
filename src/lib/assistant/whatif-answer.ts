import { addMonths, round, type Dashboard } from "@/lib/calc";
import { currency, monthLabel } from "@/lib/format";
import { detectSubscriptions } from "@/lib/insights";
import type { AppState, AssistantCard, AssistantWhatIf } from "@/lib/types";
import { parseAmount } from "./intent";
import { matchName } from "./tools";
import { computeWhatIf } from "./whatif";

function extraAmount(lower: string) {
  const match = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:€|euro\b|eur\b)?\s*(?:im monat |pro monat |monatlich |mehr |zusätzlich |extra )*(?:mehr|zusätzlich|zusaetzlich|extra)\b/.exec(lower) ??
    /\b(?:spar\w*|leg\w*|zurück\w*)\s+(?:ich |jeden monat |monatlich |im monat )*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:€|euro\b|eur\b)/.exec(lower) ??
    /(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?\s*(?:€|euro\b|eur\b)\s*(?:im monat|pro monat|monatlich)/.exec(lower);
  const value = match ? parseAmount(`${match[1]}${match[2] ? `,${match[2]}` : ""}`) : undefined;
  return value !== undefined && value > 0 && value <= 100_000 ? value : 0;
}

export function whatIfAnswer(state: AppState, dashboard: Dashboard, text: string, today: string): { text: string; card: AssistantCard; suggestions: string[] } {
  const lower = text.toLowerCase();
  const current = today.slice(0, 7);
  const fixed = state.financeRows.filter((row) => row.kind === "fixed" && (row.values[current] ?? 0) > 0)
    .map((row) => ({ name: row.label, monthly: row.values[current] ?? 0 }));
  const detected = detectSubscriptions(state, today).filter((item) => item.monthlyCost >= 1).map((item) => ({ name: item.merchant, monthly: item.monthlyCost }));
  const all = [...detected, ...fixed.filter((row) => !detected.some((item) => Math.abs(item.monthly - row.monthly) < 0.01 ||
    matchName(item.name, [row], (entry) => entry.name)))];
  const everything = /alle (?:meine )?abos|sämtliche abos/.test(lower);
  const cancel = all.filter((item, index) => (everything && index < detected.length) || matchName(lower, [item], (entry) => entry.name) !== undefined);
  const offered = [...cancel, ...detected.filter((item) => !cancel.includes(item))].slice(0, 8);
  const extra = extraAmount(lower);
  const open = dashboard.goals.filter((goal) => !goal.completedAt && goal.date >= today && (dashboard.actualGoals[goal.id] ?? 0) < goal.target)
    .sort((a, b) => a.date.localeCompare(b.date));
  const goal = matchName(lower, dashboard.goals, (item) => item.name) ?? open[0];
  const start = addMonths(current, 1);
  const currentRow = dashboard.timeline.find((row) => row.month === current);
  const due = goal?.date.slice(0, 7) ?? start;
  const rates = goal ? dashboard.timeline.filter((row) => row.month >= start && row.month <= due).slice(0, 36).map((row) => round(Math.max(0, row.goalRates[goal.id] ?? 0))) : [];
  const positive = rates.filter((value) => value > 0);
  const saved = goal ? Math.max(0, currentRow?.goalEnd[goal.id] ?? dashboard.actualGoals[goal.id] ?? 0) : 0;
  const fixedRate = goal?.funding?.monthly;
  const whatif: AssistantWhatIf = {
    ...(goal ? { goal: { id: goal.id, name: goal.name.slice(0, 80), target: goal.target, saved: round(Math.min(saved, 10_000_000)), date: goal.date,
      ...(fixedRate !== undefined ? { monthly: round(fixedRate) } : {}) } } : {}),
    start, rates, tail: round(fixedRate ?? (positive.length ? Math.min(...positive) : 0)), extra: round(extra),
    subscriptions: offered.map((item) => ({ name: item.name.slice(0, 80), monthly: round(item.monthly), cancel: cancel.includes(item) })),
  };
  const outcome = computeWhatIf(whatif);
  const missing = [...text.matchAll(/\b(?:ich|wir)\s+(?:mein(?:e|en)?\s+|das\s+|den\s+|die\s+)?(\p{Lu}[\p{L}\d+&.-]{1,30})\s+(?:kündig|kuendig|streich|abbestell)|(?:kündig|kuendig|streich|abbestell)\w*\s+(?:ich\s+)?(?:mein(?:e|en)?\s+|das\s+|den\s+|die\s+)?(\p{Lu}[\p{L}\d+&.-]{1,30})/gu)]
    .map((match) => match[1] ?? match[2]).filter((name) => name && !/^(?:Abo|Abos|Vertrag|Wenn|Und|Mehr)$/i.test(name) &&
      !cancel.some((item) => matchName(name, [item], (entry) => entry.name)));
  const changes = [...cancel.map((item) => `${item.name} kündigst`), ...(extra ? [`${currency(extra)} mehr sparst`] : [])];
  const intro = (missing.length ? `${[...new Set(missing)].join(" und ")} finde ich nicht unter deinen Abos und Fixkosten. ` : "") +
    (changes.length ? `Wenn du ${changes.join(" und ")}, hast du ${currency(outcome.freed)} mehr im Monat (${currency(outcome.yearly)} im Jahr).`
      : "Stell unten ein, was du kündigen oder mehr sparen willst; ich rechne sofort mit.");
  const goalText = !goal ? "" : !outcome.after ? ` „${goal.name}“ erreichst du auch damit nicht absehbar.`
    : outcome.after === outcome.before || !changes.length ? ` „${goal.name}“ erreichst du laut Plan im ${monthLabel(outcome.after)}.`
      : ` „${goal.name}“ erreichst du dann im ${monthLabel(outcome.after)}` +
        (outcome.before ? ` statt im ${monthLabel(outcome.before)}${outcome.earlier ? ` (${outcome.earlier} ${outcome.earlier === 1 ? "Monat" : "Monate"} früher)` : ""}.` : ", bisher wäre es nicht absehbar.");
  return {
    text: intro + goalText,
    card: { kind: "whatif", title: `Was wäre wenn${goal ? ` · ${goal.name}` : ""}`.slice(0, 200), total: outcome.freed, whatif,
      lines: [
        ...cancel.slice(0, 8).map((item) => ({ label: `${item.name} kündigen`, value: round(item.monthly), tone: "good" as const })),
        ...(extra ? [{ label: "Mehr sparen", value: round(extra), tone: "good" as const }] : []),
        { label: "Pro Jahr", value: outcome.yearly, tone: "info" as const },
      ],
      note: "Nur eine Rechnung, an deinen Daten ändert sich nichts. Basis sind die geplanten Sparraten aus deinem Monatsplan." },
    suggestions: ["Wo kann ich sparen?", "Kontoprognose", ...(goal ? [`Wie steht ${goal.name}?`] : [])],
  };
}
