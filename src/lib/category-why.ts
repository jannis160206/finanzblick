import { classify } from "@/lib/calc";
import { canonicalCategory, type Category } from "@/lib/categories";
import { merchantRuleKey, storedMerchantKey } from "@/lib/import/merchant-rules";
import { hasCategoryChoice, hasManualCategory } from "@/lib/manual-category";
import { webEntry, webTarget } from "@/lib/ai/web-categories";
import type { AppState, Transaction } from "@/lib/types";

export type CategorySourceKind = "manual" | "learned" | "ai" | "rule" | "web" | "bank" | "history" | "default";
export type CategoryExplanation = {
  category: Category;
  kind: CategorySourceKind;
  // Short German label of the source ("Von dir gelernt", "Aus dem Web").
  source: string;
  detail: string;
  date: string;
  merchant: string;
};

const sourceLabels: Record<CategorySourceKind, string> = {
  manual: "Manuell gesetzt", learned: "Von dir gelernt", ai: "Lokale KI", rule: "Händlerregel",
  web: "Aus dem Web", bank: "Bank-Kategorie", history: "Aus früheren Buchungen", default: "Standardregel",
};
const merchantOf = (row: Transaction) => row.merchantAlias?.trim() || row.description.trim().slice(0, 80);

// Reconstructs why a booking carries its category from the fields the import pipeline already stores.
// Order mirrors precedence in the pipeline: a person beats learned rules beats automatic evidence.
export function explainCategory(state: AppState, row: Transaction, shown?: Category): CategoryExplanation {
  const result = classify(row);
  const category = canonicalCategory(shown ?? result.category);
  const merchant = merchantOf(row);
  const base = { category, date: row.date, merchant };
  const make = (kind: CategorySourceKind, detail: string): CategoryExplanation => ({ ...base, kind, source: sourceLabels[kind], detail });
  const suggestion = state.aiSuggestions?.find((entry) => entry.id === row.id);

  if (row.aiAssigned) {
    return make("ai", suggestion?.reason ? `Das lokale KI-Modell hat entschieden: ${suggestion.reason}` : "Das lokale KI-Modell hat diese Buchung zugeordnet (nichts verlässt deinen Rechner).");
  }
  if (hasManualCategory(row) || hasCategoryChoice(row)) return make("manual", `Du hast „${category}“ für diese Buchung selbst gewählt.`);
  const key = merchantRuleKey(row);
  const rule = (state.merchantRules ?? []).find((entry) => !entry.identityOnly && entry.category !== "Prüfen" &&
    (entry.key === key || storedMerchantKey(entry.key) === key));
  if (rule && canonicalCategory(rule.category) === category) {
    return make("learned", `Du hast „${merchant}“ früher „${canonicalCategory(rule.category)}“ zugeordnet – daraus ist eine Regel geworden.`);
  }
  const evidence = row.automaticCategoryEvidence;
  if (evidence && canonicalCategory(evidence.category) === category) {
    if (evidence.method === "merchant") return make("rule", `Regel „${merchant} → ${category}“ aus der Händlerliste.`);
    if (evidence.method === "mcc") return make("bank", `Bank-Händlerkategorie (MCC ${evidence.mcc ?? "?"}) passt zu „${category}“.`);
    if (evidence.method === "purpose") return make("rule", `Der Buchungstext ist eindeutig („${merchant}“ → ${category}).`);
    if (evidence.method === "history") return make("history", `Frühere Buchungen bei „${merchant}“ waren „${category}“.`);
    return make("bank", `Die Bank hat die Buchung als „${row.sourceCategory ?? category}“ markiert.`);
  }
  const web = webEntry(state, webTarget(row));
  if (web?.category && canonicalCategory(web.category) === category) {
    const what = web.kind ?? web.label ?? web.name;
    return make("web", `${web.source ?? "Internet"}: ${what}${web.place ? ` (${web.place})` : ""} – öffentliche Händlerdaten, nur der Händlername wurde gesucht.`);
  }
  if (suggestion && canonicalCategory(suggestion.category) === category) {
    const kind: CategorySourceKind = suggestion.source === "KI" ? "ai" : suggestion.source === "Historie" ? "history" : suggestion.source === "Branche" ? "web" : "rule";
    return make(kind, suggestion.reason || sourceLabels[kind]);
  }
  if (category === "Prüfen") return make("default", "Noch keine sichere Zuordnung – bitte selbst prüfen.");
  const reason = result.reason ? `${result.reason.replace(/\.$/, "")}.` : `Eingebaute Regel für „${merchant}“.`;
  if (row.sourceCategory) return make("default", `${reason} Bank-Kategorie: „${row.sourceCategory}“.`);
  return make(result.reason === "Transfer erkannt" ? "rule" : "default", reason);
}

export function categoryWhyText(explanation: CategoryExplanation) {
  return `${explanation.merchant} ist „${explanation.category}“ – ${explanation.source}: ${explanation.detail}`;
}
