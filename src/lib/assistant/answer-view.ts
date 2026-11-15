import type { AssistantCard } from "@/lib/types";

// What the answer layout shows from the workers' results: key figures, one tile per result and its trend. Every number comes
// from the tools' cards (computed by code); only the tone (positive, negative, warning, neutral) is derived here.

export type Tone = "positive" | "negative" | "warning" | "neutral";
export type Kpi = { label: string; value: number; tone: Tone; hint?: string };
export type Trend = { name: string; labels: string[]; values: number[]; change: number; percent?: number; tone: Tone };
export type TileLine = { label: string; value?: number; detail?: string; tone: Tone };

const lineTone: Record<NonNullable<AssistantCard["lines"][number]["tone"]>, Tone> = { good: "positive", bad: "negative", warn: "warning", info: "neutral" };
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
// Totals of these cards are no money figure worth a badge (rule previews, memory lists, change logs).
const noTotal = new Set<AssistantCard["kind"]>(["rule", "memory", "changes", "whatif"]);

/** A tool's own tone wins; otherwise a minus amount is negative and everything else neutral. */
export function toneOf(value: number | undefined, tone?: AssistantCard["lines"][number]["tone"]): Tone {
  if (tone && tone !== "info") return lineTone[tone];
  return value !== undefined && value < 0 ? "negative" : "neutral";
}

/** "Monatsplan · November 2026" becomes the label "Monatsplan" with the hint "November 2026". */
export function splitTitle(title: string): { label: string; hint?: string } {
  const [label, ...rest] = title.split(" · ");
  return { label: label.trim().slice(0, 40), ...(rest.length ? { hint: rest.join(" · ").slice(0, 40) } : {}) };
}

/** Up to four key figures: each result's total first, then the lines its tool marked good, bad or worth a warning. */
export function answerKpis(cards: readonly AssistantCard[], max = 4): Kpi[] {
  const kpis: Kpi[] = [];
  const add = (kpi: Kpi) => { if (kpis.length < max && !kpis.some((item) => item.label === kpi.label)) kpis.push(kpi); };
  for (const card of cards) if (card.total !== undefined && !noTotal.has(card.kind)) add({ ...splitTitle(card.title), value: card.total, tone: toneOf(card.total) });
  // A line repeating its card's total ("Überschuss laut Plan" = the plan's total) adds nothing.
  for (const card of cards) for (const line of card.lines)
    if (line.value !== undefined && line.tone && line.tone !== "info" && line.value !== card.total)
      add({ label: line.label.slice(0, 40), value: line.value, tone: toneOf(line.value, line.tone) });
  return kpis;
}

// Whether a rising series is good (balances, savings, depot) or bad (spending, costs); unknown series stay neutral.
function risingIsGood(card: AssistantCard, name: string): boolean | undefined {
  if (/ausgab|kosten|spend|verbrauch|schulden|restschuld/i.test(name)) return false;
  if (/saldo|kontostand|stand|vermögen|gespart|erspart|depot|guthaben|überschuss/i.test(name) || ["forecast", "depot", "whatif"].includes(card.kind)) return true;
  return undefined;
}

/** The trend of a result's chart: its first series with at least two points, the change from first to last and its tone. */
export function trendOf(card: AssistantCard): Trend | undefined {
  const series = card.chart?.series.find((item) => item.points.length >= 2);
  if (!series) return undefined;
  const values = series.points.map((point) => point.value);
  const change = round(values.at(-1)! - values[0]);
  const good = risingIsGood(card, series.name);
  const tone: Tone = change === 0 || good === undefined ? "neutral" : (change > 0) === good ? "positive" : "negative";
  return { name: series.name || splitTitle(card.title).label, labels: series.points.map((point) => point.label), values, change,
    ...(values[0] !== 0 ? { percent: round(change / Math.abs(values[0]) * 100, 1) } : {}), tone };
}

/** The first lines of a result for its tile, with their tone. */
export function tileLines(card: AssistantCard, count = 3): TileLine[] {
  return card.lines.filter((line) => line.label !== card.title).slice(0, count)
    .map((line) => ({ label: line.label, ...(line.value !== undefined ? { value: line.value } : {}), ...(line.detail ? { detail: line.detail } : {}), tone: toneOf(line.value, line.tone) }));
}

/** Results worth laying out: something to show besides a bare title (lines, a total, a chart). */
export const showsData = (card: AssistantCard) => card.lines.length > 0 || card.total !== undefined || !!card.chart;
