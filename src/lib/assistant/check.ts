import { addMonths, round, type Dashboard } from "@/lib/calc";
import { isIncomeCategory } from "@/lib/fixed";
import { currency, monthLabel } from "@/lib/format";
import { detectSubscriptions, ledger } from "@/lib/insights";
import type { AppState, AssistantCard } from "@/lib/types";
import type { AgentResult } from "./agent";

type Line = AssistantCard["lines"][number];
type Tone = "good" | "warn" | "bad";

export const checkQuestion = (lower: string) =>
  /finanz-?check|gesundheits-?check|wie (?:steh|steh'?|geht'?s|gehts|läuft'?s|laeufts)\w* (?:es )?(?:um )?(?:mir|ich|meine finanzen|meinen finanzen|finanziell)|wie gut (?:wirtschafte|haushalte|spare) ich|bin ich (?:eher |zu |ziemlich |sehr )?(?:sparsam|verschwenderisch|ein sparfuchs|gut aufgestellt|auf (?:einem )?gutem? weg)|geb(?:e)? ich (?:eher |zu |ziemlich )?viel (?:geld )?aus|mach(?:e)? ich (?:das|es) gut|sparquote|wie viel prozent spar|wie (?:sind|stehen|sehen) meine finanzen|bewert\w* meine finanzen|zeugnis/.test(lower);

const percent = (value: number) => `${Math.round(value * 100)} %`;

// A deterministic financial health check over the last three full months.
export function financialCheck(state: AppState, dashboard: Dashboard, today: string): AgentResult {
  const current = today.slice(0, 7);
  const months = [3, 2, 1].map((offset) => addMonths(current, -offset));
  const income = new Map(months.map((month) => [month, 0]));
  const spending = new Map(months.map((month) => [month, 0]));
  for (const { row, category } of ledger(state)) {
    const month = row.date.slice(0, 7);
    if (!income.has(month)) continue;
    if (row.amount > 0 && isIncomeCategory(category)) income.set(month, income.get(month)! + row.amount);
    // Refunds and cost shares from others lower the spending instead of counting as income.
    else spending.set(month, spending.get(month)! - row.amount);
  }
  for (const month of months) spending.set(month, Math.max(0, spending.get(month)!));
  const booked = round([...income.values()].reduce((a, b) => a + b, 0) / months.length);
  // Imports can miss a salary month, so the monthly plan income wins when it is set.
  const planned = round(dashboard.current?.income ?? 0);
  const avgIncome = planned > 0 ? planned : booked;
  const avgSpending = round([...spending.values()].reduce((a, b) => a + b, 0) / months.length);
  if (avgIncome <= 0 && avgSpending <= 0)
    return { text: "Für einen Finanz-Check fehlen mir Buchungen aus den letzten drei Monaten. Importiere zuerst deine Umsätze." };
  const lines: Line[] = [];
  const scores: Tone[] = [];
  const rate = avgIncome > 0 ? (avgIncome - avgSpending) / avgIncome : -1;
  const rateTone: Tone = rate >= 0.2 ? "good" : rate >= 0.05 ? "warn" : "bad";
  scores.push(rateTone);
  lines.push({ label: "Sparquote", value: round(avgIncome - avgSpending), tone: rateTone,
    detail: avgIncome > 0 ? `${percent(Math.max(-9.99, rate))} vom Einkommen bleiben übrig · Ziel: mindestens 20 %` : "keine Einnahmen erkannt" });
  lines.push({ label: planned > 0 ? "Einnahmen pro Monat" : "Einnahmen im Schnitt", value: avgIncome, tone: "good",
    detail: planned > 0 ? "laut Monatsplan" : `${monthLabel(months[0])} bis ${monthLabel(months[2])}` });
  lines.push({ label: "Ausgaben im Schnitt", value: avgSpending, detail: "ohne Umbuchungen, abzüglich Rückerstattungen" });
  const fixed = dashboard.current?.fixed ?? 0;
  let fixedShare: number | undefined;
  if (avgIncome > 0 && fixed > 0) {
    fixedShare = fixed / avgIncome;
    const tone: Tone = fixedShare <= 0.5 ? "good" : fixedShare <= 0.65 ? "warn" : "bad";
    scores.push(tone);
    lines.push({ label: "Fixkosten-Anteil", value: round(fixed), tone, detail: `${percent(fixedShare)} vom Einkommen · gut sind bis 50 %` });
  }
  const reserveMonths = avgSpending > 0 ? dashboard.totalAssets / avgSpending : 0;
  const reserveTone: Tone = reserveMonths >= 3 ? "good" : reserveMonths >= 1 ? "warn" : "bad";
  scores.push(reserveTone);
  lines.push({ label: "Reserve", value: round(dashboard.totalAssets), tone: reserveTone,
    detail: `reicht für ${reserveMonths.toLocaleString("de-AT", { maximumFractionDigits: 1 })} Monate Ausgaben · Ziel: 3 Monate` });
  const last = spending.get(months[2])!;
  const before = (spending.get(months[0])! + spending.get(months[1])!) / 2;
  if (before > 0) {
    const change = (last - before) / before;
    const tone: Tone = change <= 0.15 ? "good" : "warn";
    scores.push(tone);
    lines.push({ label: `Ausgaben ${monthLabel(months[2])}`, value: round(last), tone,
      detail: change >= 0 ? `${percent(change)} über den zwei Monaten davor` : `${percent(-change)} unter den zwei Monaten davor` });
  }
  const subscriptions = detectSubscriptions(state, today);
  const subscriptionTotal = round(subscriptions.reduce((sum, item) => sum + item.monthlyCost, 0));
  if (subscriptionTotal > 0) lines.push({ label: `Abos (${subscriptions.length})`, value: subscriptionTotal, tone: "info",
    detail: avgIncome > 0 ? `${percent(subscriptionTotal / avgIncome)} vom Einkommen pro Monat` : "pro Monat" });
  const shortfall = round(dashboard.amex?.shortfall ?? 0);
  if (shortfall > 0.5) {
    scores.push("warn");
    lines.push({ label: "Amex-Rückzahlung offen", value: shortfall, tone: "warn", detail: "noch auf das Rückzahlungs-Pocket überweisen" });
  }
  const good = scores.filter((tone) => tone === "good").length;
  const bad = scores.filter((tone) => tone === "bad").length;
  const verdict = bad === 0 && good >= scores.length - 1 ? "Du stehst solide da"
    : bad === 0 && good * 2 >= scores.length ? "Insgesamt ok, mit ein paar Baustellen" : "Da ist noch Luft nach oben";
  const strengths: string[] = [];
  const issues: string[] = [];
  (rateTone === "good" ? strengths : issues).push(avgIncome > 0 ? `deine Sparquote liegt bei ${percent(Math.max(-9.99, rate))}` : "es sind keine Einnahmen erkannt");
  (reserveTone === "good" ? strengths : issues).push(`deine Reserve reicht für ${reserveMonths.toLocaleString("de-AT", { maximumFractionDigits: 1 })} Monate`);
  if (fixedShare !== undefined && fixedShare > 0.5) issues.push(`die Fixkosten fressen ${percent(fixedShare)} vom Einkommen`);
  else if (fixedShare !== undefined) strengths.push(`deine Fixkosten sind mit ${percent(fixedShare)} vom Einkommen niedrig`);
  if (shortfall > 0.5) issues.push(`auf die Amex fehlen noch ${currency(shortfall)}`);
  const text = `${verdict}: ${good} von ${scores.length} Punkten sind im grünen Bereich.` +
    (strengths.length ? ` Gut: ${strengths.join(", ")}.` : "") + (issues.length ? ` Achtung: ${issues.join(", ")}.` : "");
  return { text, card: { kind: "check", title: `Finanz-Check · ${monthLabel(months[0])} bis ${monthLabel(months[2])}`, total: round(avgIncome - avgSpending), lines,
    note: "Durchschnitt der letzten drei vollen Monate. Die Grenzen (20 % Sparquote, 50 % Fixkosten, 3 Monate Reserve) sind gängige Faustregeln." },
  suggestions: ["Wo könnte ich kürzen?", "Wie haben sich meine Ausgaben entwickelt?", "Wie viel geht für Abos weg?"] };
}
