import { round } from "@/lib/calc";
import { monthLabel } from "@/lib/format";
import type { AssistantChart } from "@/lib/types";

type Point = { label: string; value: number };
export const MAX_CHART_POINTS = 24;

// Keeps first and last point and spreads the rest evenly, so long ranges still fit the schema.
export function samplePoints<T>(items: T[], max = MAX_CHART_POINTS): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, index) => items[Math.round(index * (items.length - 1) / (max - 1))]);
}

export const shortMonth = (month: string) => monthLabel(month, true).replace(/\.? (\d{2})(\d{2})$/, " $2");

// Builds a bounded chart; undefined when there is nothing worth drawing.
export function buildChart(type: AssistantChart["type"], series: { name: string; points: Point[] }[], threshold?: AssistantChart["threshold"]): AssistantChart | undefined {
  const clean = series.slice(0, 3).map((item) => ({
    name: item.name.slice(0, 60),
    points: samplePoints(item.points.filter((point) => Number.isFinite(point.value)))
      .map((point) => ({ label: point.label.slice(0, 20), value: round(point.value) })),
  })).filter((item) => item.points.length > 0);
  if (!clean.length || Math.max(...clean.map((item) => item.points.length)) < 2) return undefined;
  return { type, series: clean, ...(threshold && Number.isFinite(threshold.value) ? { threshold: { label: threshold.label.slice(0, 60), value: round(threshold.value) } } : {}) };
}
