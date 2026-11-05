import { merchantAliasAssignment } from "@/lib/merchant-identity";
import { isAmexScreenshot } from "@/lib/import/identity";
import { merchantAliasSourceKey } from "@/lib/import/merchant-rules";
import type { StatementDraft } from "@/lib/import/statements";
import type { AppState, ReviewItem } from "@/lib/types";
import { brandKey } from "./evidence";
import { isAiEligibleReview } from "./review-candidates";
import type { AiSuggestion } from "./suggestions";

type BookingReview = Extract<ReviewItem, { kind: "booking" }>;
export type ReviewGroup = { key: string; name: string; items: BookingReview[]; total: number; suggestion?: AiSuggestion };

// The dialog starts from the AI proposal; the user still confirms it.
export function suggestedDraft(draft: StatementDraft, suggestion: AiSuggestion | undefined): StatementDraft {
  if (!suggestion || draft.category !== "Prüfen") return draft;
  const alias = suggestion.merchantAlias;
  const named = alias && !draft.merchantAlias?.trim() && merchantAliasSourceKey(draft) !== undefined
    ? { ...merchantAliasAssignment(draft, alias), merchantNameConfirmed: undefined } : {};
  return { ...draft, ...named, category: suggestion.category };
}

const displayName = (item: BookingReview) => item.draft.merchantAlias?.trim() || item.draft.description.trim().slice(0, 60);

// Open bookings of the same merchant and direction can be settled with one decision.
export function groupReviews(
  items: readonly ReviewItem[], suggestions: AppState["aiSuggestions"], blocked: (item: ReviewItem) => boolean = () => false,
): { groups: ReviewGroup[]; singles: ReviewItem[] } {
  const buckets = new Map<string, BookingReview[]>();
  for (const item of items) {
    if (!isAiEligibleReview(item) || isAmexScreenshot(item.draft) || blocked(item)) continue;
    const brand = brandKey(item.draft);
    if (!brand) continue;
    const key = `${brand}|${Math.sign(item.draft.amount!)}`;
    buckets.set(key, [...(buckets.get(key) ?? []), item]);
  }
  const byId = new Map((suggestions ?? []).map((item) => [item.id, item]));
  const grouped = new Set<string>();
  const groups: ReviewGroup[] = [];
  for (const [key, members] of buckets) {
    if (members.length < 2) continue;
    for (const member of members) grouped.add(member.id);
    const proposals = members.map((member) => byId.get(member.id));
    const first = proposals.find(Boolean);
    const agreed = first && proposals.every((proposal) => !proposal || proposal.category === first.category) ? first : undefined;
    groups.push({
      key, name: displayName(members[0]), items: members,
      total: Math.round(members.reduce((sum, member) => sum + member.draft.amount!, 0) * 100) / 100,
      ...(agreed ? { suggestion: agreed } : {}),
    });
  }
  groups.sort((left, right) => right.items.length - left.items.length);
  return { groups, singles: items.filter((item) => !grouped.has(item.id)) };
}
