import { categoryGroups } from "@/lib/categories";

/** Identical, accessible category structure in editing, review and filtering. */
export function CategoryOptions({ excludeReview = false }: { excludeReview?: boolean }) {
  return categoryGroups.map((group) => (
    <optgroup key={group.label} label={group.label}>
      {group.categories.filter((category) => !excludeReview || category !== "Prüfen").map((category) => (
        <option key={category} value={category}>{category}</option>
      ))}
    </optgroup>
  ));
}
