// The plan starts with the first imported year and always reaches the end of
// the following year, so December never runs out of months to plan into.
export const planningStartYear = 2026;

export function planningEndYear(asOf: string): number {
  return Math.max(planningStartYear + 1, Number(asOf.slice(0, 4)) + 1);
}

export function planningYears(asOf: string): number[] {
  const end = planningEndYear(asOf);
  return Array.from({ length: end - planningStartYear + 1 }, (_, index) => planningStartYear + index);
}

export function planningMonths(asOf: string): string[] {
  return planningYears(asOf).flatMap((year) =>
    Array.from({ length: 12 }, (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`));
}

export const planningEndMonth = (asOf: string) => `${planningEndYear(asOf)}-12`;
