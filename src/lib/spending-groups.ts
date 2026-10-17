import { round } from "@/lib/calc";

export type SpendingSlice = { name: string; value: number; share: number };
export type SpendingGroups = { top: SpendingSlice[]; rest: SpendingSlice[]; restValue: number; restShare: number; total: number };

// Zeigt die größten Kategorien einzeln und fasst den Rest zusammen. Ein einzelner Rest bleibt eigenständig,
// damit "Sonstige" nie nur eine Kategorie umbenennt. Erstattungen (Werte <= 0) bleiben außen vor.
export function groupSpending(rows: readonly { name: string; value: number }[], limit = 5): SpendingGroups {
  const positive = rows.filter((row) => row.value > 0).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "de"));
  const total = round(positive.reduce((sum, row) => sum + row.value, 0));
  const withShare = positive.map((row): SpendingSlice => ({ ...row, share: total > 0 ? row.value / total : 0 }));
  const keep = withShare.length > limit + 1 ? limit : withShare.length;
  const rest = withShare.slice(keep);
  const restValue = round(rest.reduce((sum, row) => sum + row.value, 0));
  return { top: withShare.slice(0, keep), rest, restValue, restShare: total > 0 ? restValue / total : 0, total };
}

export const shareLabel = (share: number) => (share > 0 && share < 0.01 ? "< 1 %" : `${Math.round(share * 100)} %`);
