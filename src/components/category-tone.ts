import { canonicalCategory, categoryGroups } from "@/lib/categories";
import type { Category } from "@/lib/types";

const groupTones: Record<(typeof categoryGroups)[number]["label"], string> = {
  "Alltag": "bg-chart-2",
  "Freizeit & Leben": "bg-chart-3",
  "Wohnen & Mobilität": "bg-chart-4",
  "Verträge & Gebühren": "bg-chart-7",
  "Einnahmen": "bg-success",
  "Sonstiges & Umbuchungen": "bg-muted-foreground/60",
};

export function categoryTone(category: Category): string {
  const canonical = canonicalCategory(category);
  const group = categoryGroups.find((entry) => (entry.categories as readonly string[]).includes(canonical));
  return group ? groupTones[group.label] : groupTones["Sonstiges & Umbuchungen"];
}
