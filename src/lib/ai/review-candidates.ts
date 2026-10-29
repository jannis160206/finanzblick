import { z } from "zod";
import { categories, canonicalCategory, type Category } from "@/lib/categories";
import { hasCategoryChoice } from "@/lib/manual-category";
import { isAmexScreenshot } from "@/lib/import/identity";
import { merchantRuleKey } from "@/lib/import/merchant-rules";
import type { AppState, ReviewItem } from "@/lib/types";

type BookingReview = Extract<ReviewItem, { kind: "booking" }>;

export const aiCategories = categories.filter((category) => category !== "Prüfen");
export const MAX_AI_BATCH = 8;
export const MAX_AI_EXAMPLES = 30;

export const aiBookingInputSchema = z.object({
  ref: z.string().regex(/^b\d{1,3}$/),
  text: z.string().trim().min(1).max(400),
  amount: z.number().finite(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bank: z.string().trim().max(100),
  hint: z.string().trim().max(200).optional(),
}).strict();
export type AiBookingInput = z.infer<typeof aiBookingInputSchema>;

export const aiExampleSchema = z.object({
  text: z.string().trim().min(1).max(120),
  category: z.enum(aiCategories as [Category, ...Category[]]),
}).strict();
export type AiExample = z.infer<typeof aiExampleSchema>;

const clip = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);

// Reviews whose bank facts are missing or need a source re-upload stay with the user.
export function isAiEligibleReview(item: ReviewItem): item is BookingReview {
  if (item.kind !== "booking" || item.sourceRepair || item.importIssues?.length) return false;
  const draft = item.draft;
  return draft.amount !== null && draft.amount !== 0 && !!draft.date && !!draft.description.trim() &&
    !isAmexScreenshot(draft) && !item.message.startsWith("POS-Händler fehlt") &&
    !item.message.startsWith("Buchungsdaten unvollständig");
}

export function aiReviewCandidates(state: AppState, skip: ReadonlySet<string>, limit = MAX_AI_BATCH) {
  const picked: { reviewId: string; input: AiBookingInput }[] = [];
  for (const item of state.reviewQueue ?? []) {
    if (picked.length >= limit) break;
    if (skip.has(item.id) || !isAiEligibleReview(item)) continue;
    const draft = item.draft;
    const text = [...new Set([draft.merchantAlias, draft.description, draft.rawDescription]
      .filter((part): part is string => !!part?.trim()).map((part) => clip(part, 180)))].join(" | ");
    picked.push({
      reviewId: item.id,
      input: {
        ref: `b${picked.length + 1}`,
        text: clip(text, 400),
        amount: draft.amount!,
        date: draft.date,
        bank: clip(draft.bank, 100),
        ...(draft.sourceCategory ? { hint: clip(`Bankkategorie: ${draft.sourceCategory}`, 200) } : {}),
      },
    });
  }
  return picked;
}

// Recent personal decisions teach the model this household's conventions.
export function aiCategoryExamples(state: AppState, limit = MAX_AI_EXAMPLES): AiExample[] {
  const examples = new Map<string, AiExample>();
  const add = (text: string | undefined, category: Category) => {
    const canonical = canonicalCategory(category);
    if (!text?.trim() || canonical === "Prüfen" || examples.size >= limit) return;
    const parsed = aiExampleSchema.safeParse({ text: clip(text, 120), category: canonical });
    const key = parsed.success ? parsed.data.text.toLocaleLowerCase("de-AT") : "";
    if (parsed.success && !examples.has(key)) examples.set(key, parsed.data);
  };
  const seen = new Set<string>();
  for (let i = state.transactions.length - 1; i >= 0 && examples.size < limit; i--) {
    const row = state.transactions[i];
    if (!hasCategoryChoice(row) || row.aiAssigned) continue;
    const key = merchantRuleKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    add(row.merchantAlias ? `${row.merchantAlias} (${clip(row.description, 60)})` : row.description, row.category);
  }
  for (const rule of state.merchantRules ?? []) {
    if (examples.size >= limit) break;
    if (!rule.identityOnly && rule.merchantAlias) add(rule.merchantAlias, rule.category);
  }
  return [...examples.values()];
}
