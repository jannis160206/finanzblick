import { classify } from "@/lib/calc";
import { canonicalCategory } from "@/lib/categories";
import { explainCategory } from "@/lib/category-why";
import { dateLabel } from "@/lib/format";
import { matchesTransactionSearch } from "@/lib/transaction-tools";
import type { AppState, AssistantCard } from "@/lib/types";
import { findMerchant } from "./answers";
import { matchName } from "./tools";

type Result = { text: string; card?: AssistantCard; suggestions?: string[] };

// "Warum ist Billa Lebensmittel?", "Wieso steht Netflix unter Abos?" – never "Billa ist immer Lebensmittel" (rule tool).
export const whyQuestion = (lower: string) =>
  /\b(?:warum|wieso|weshalb|woher weißt du|wie kommst du (?:drauf|darauf))\b/.test(lower) &&
  /kategori|zugeordnet|eingeordnet|einsortiert|gelandet|landet|\b(?:unter|als|bei|in)\s+(?:den\s+|die\s+|der\s+)?[\p{L}&+ -]{3,30}\s*\?*\s*$|\b(?:ist|sind)\b.*\b(?:lebensmittel|essen|shopping|abos?|abonnements|restaurants?|mittagessen|tanken|freizeit|gesundheit|transport|urlaub|versicherungen?)\s*\?*\s*$/u.test(lower) &&
  !/\bist immer\b|\bsind immer\b|ausgegeben|so viel|so hoch|\bmehr\b|\bweniger\b|teuer|gestiegen|kein geld|pleite|minus/.test(lower);

export function whyAnswer(state: AppState, text: string): Result {
  const name = findMerchant(state, text)
    ?? matchName(text, [...new Set(state.transactions.map((row) => row.merchantAlias?.trim() || row.description.trim()))], (value) => value);
  const rows = name ? state.transactions.filter((row) => matchesTransactionSearch(row, name)).sort((a, b) => b.date.localeCompare(a.date)) : [];
  if (!rows.length) {
    return { text: "Welche Buchung meinst du? Nenn mir den Händler, zum Beispiel „Warum ist Billa Lebensmittel?“. In den Umsätzen zeigt dir das ⓘ neben der Kategorie dasselbe." };
  }
  const row = rows[0];
  const why = explainCategory(state, row);
  const same = rows.filter((item) => canonicalCategory(classify(item).category) === why.category);
  return {
    text: `${why.merchant} steht unter „${why.category}“ – ${why.source}. ${why.detail}`,
    card: {
      kind: "why", title: `Warum „${why.category}“? · ${why.merchant}`.slice(0, 200),
      lines: [
        { label: "Kategorie", detail: why.category },
        { label: "Quelle", detail: `${why.source} – ${why.detail}`.slice(0, 300) },
        { label: "Letzte Buchung", detail: dateLabel(row.date), transactionIds: [row.id] },
        { label: `Gleich zugeordnet (${same.length} von ${rows.length})`, transactionIds: same.slice(0, 50).map((item) => item.id) },
      ],
      note: `Falsch? Ändere die Kategorie in den Umsätzen (ⓘ → „Falsch? Kategorie ändern“) oder sag z. B. „${why.merchant.slice(0, 40)} ist immer …“.`.slice(0, 400),
    },
  };
}
