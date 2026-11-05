import { z } from "zod";
import { createEmptyAccountState } from "@/lib/account-state";
import { classify } from "@/lib/calc";
import { categories, canonicalCategory, type Category } from "@/lib/categories";
import { queueLedgerReview } from "@/lib/import/review";
import { refreshPlanning } from "@/lib/planning";
import type { AccountDatabase } from "@/lib/server/database";
import { appStateSchema, transactionSchema, type AppState } from "@/lib/types";
import { applyAiReviewDecisions, type AiReviewDecision } from "./apply-review-decisions";
import { applyAndCount, autoAssignAndCount, webContextFor } from "./auto-assign";
import { aiStatus } from "./client";
import { categorizeBookings, type AiCategorization } from "./categorize";
import { decideReviewWithEvidence, industryContext, industryLookupName } from "./evidence";
import { lookupIndustry, lookupIndustryResult, type Industry } from "./industry";
import { pendingWebLookups, recordWebCategories, webTargetForReview, type WebTarget } from "./web-categories";
import { findMerchantLogo } from "./logo-finder";
import { sweepMissingLogos } from "./logo-sweep";
import { AutomationStore } from "@/lib/automation/store";
import { aiCategories, aiCategoryExamples, aiReviewCandidates, isAiEligibleReview } from "./review-candidates";
import { recordAiSuggestions, type AiSuggestionEntry } from "./suggestions";
import { financeInsights } from "@/lib/insights";

export type FinanceAccess = { database: AccountDatabase; userId: string };

const categoryEnum = z.enum(aiCategories as [Category, ...Category[]]);
const money = (value: number) => Math.round(value * 100) / 100;

function read(access: FinanceAccess): AppState {
  return access.database.getFinance(access.userId).state ?? createEmptyAccountState();
}

function write(access: FinanceAccess, transform: (state: AppState) => AppState) {
  return access.database.transformFinance(access.userId, (state) => transform(state ?? createEmptyAccountState()), () => {});
}

function bookingView(row: AppState["transactions"][number]) {
  return {
    id: row.id, date: row.date, amount: row.amount, bank: row.bank, description: row.description.slice(0, 120),
    merchant: row.merchantAlias, category: classify(row).category,
    ...(row.aiAssigned ? { aiAssigned: true } : {}),
  };
}

// Looks up unknown shops of open card payments on the internet (OpenStreetMap shop type, Wikidata,
// the shop's website), remembers the answer and assigns what is now certain.
export async function learnCategoriesFromWeb(
  access: FinanceAccess, options: { limit: number; signal?: AbortSignal; fetcher?: typeof fetch; throttleMs?: number },
) {
  const targets = pendingWebLookups(read(access), options.limit);
  const found: { target: WebTarget; industry?: Industry }[] = [];
  let failed = 0;
  for (const target of targets) {
    if (options.signal?.aborted) break;
    const result = await lookupIndustryResult(target.name, {
      place: target.place, signal: options.signal, fetcher: options.fetcher, throttleMs: options.throttleMs,
    });
    if (result.failed) failed++;
    else found.push({ target, industry: result.industry });
  }
  let applied = 0;
  if (found.length) write(access, (state) => {
    const outcome = autoAssignAndCount(recordWebCategories(state, found));
    applied = outcome.applied.length;
    return outcome.state;
  });
  return {
    looked: found.length, failed, applied,
    learned: found.flatMap(({ target, industry }) => industry
      ? [{ name: target.name, place: target.place, category: industry.category, source: industry.source, kind: industry.kind }] : []),
  };
}

export async function categorizeOpenReviews(
  access: FinanceAccess, options: { apply: boolean; limit: number; signal?: AbortSignal },
) {
  if (options.apply) await learnCategoriesFromWeb(access, { limit: options.limit, signal: options.signal }).catch(() => undefined);
  const attempted = new Set<string>();
  const results: (AiCategorization & { reviewId: string; text: string })[] = [];
  let applied = 0;
  while (attempted.size < options.limit) {
    const state = read(access);
    const batch = aiReviewCandidates(state, attempted, Math.min(8, options.limit - attempted.size));
    if (!batch.length) break;
    for (const candidate of batch) attempted.add(candidate.reviewId);
    // Rules, own history and refunds decide without asking the model.
    const direct = new Map(batch.map((candidate) =>
      [candidate.reviewId, decideReviewWithEvidence(state, candidate.reviewId, candidate.input, undefined)]));
    const ask = batch.filter((candidate) => !direct.get(candidate.reviewId)?.accepted);
    const answers = ask.length
      ? await categorizeBookings(ask.map((candidate) => candidate.input), aiCategoryExamples(state), { signal: options.signal })
      : [];
    const decisions: AiReviewDecision[] = [];
    const suggestions: AiSuggestionEntry[] = [];
    for (const candidate of batch) {
      const answer = answers.find((item) => item.ref === candidate.input.ref);
      const known = direct.get(candidate.reviewId)!;
      const stored = webContextFor(state, candidate.reviewId);
      let decision = known.accepted ? known : decideReviewWithEvidence(state, candidate.reviewId, candidate.input, answer, stored);
      const target = !decision.accepted && !stored.industry ? webTargetForReview(state, candidate.reviewId) : undefined;
      const name = !decision.accepted && !stored.industry ? industryLookupName(candidate.input, answer) ?? target?.name : undefined;
      if (name && !options.signal?.aborted) {
        const industry = await lookupIndustry(name, { signal: options.signal, place: target?.place }).catch(() => undefined);
        if (industry) decision = decideReviewWithEvidence(state, candidate.reviewId, candidate.input, answer, industryContext(industry));
      }
      results.push({
        ...(answer ?? { ref: candidate.input.ref, category: "Prüfen", confidence: 0 }),
        ...(decision.accepted
          ? { accepted: true, category: decision.category, merchant: decision.merchantAlias,
            reason: `bestätigt durch ${decision.source}${decision.detail ? ` (${decision.detail})` : ""}` }
          : { accepted: false, reason: decision.reason, ...(decision.suggestion ? { suggestion: decision.suggestion } : {}) }),
        reviewId: candidate.reviewId, text: candidate.input.text,
      });
      if (decision.accepted)
        decisions.push({ reviewId: candidate.reviewId, category: decision.category, merchantAlias: decision.merchantAlias });
      else suggestions.push({ reviewId: candidate.reviewId, reason: decision.reason, suggestion: decision.suggestion });
    }
    if (options.apply && (decisions.length || suggestions.length)) {
      write(access, (current) => {
        const outcome = applyAndCount(current, decisions);
        applied += outcome.applied.length;
        return recordAiSuggestions(outcome.state, suggestions);
      });
    }
  }
  return { applied, proposals: results, stillOpen: results.filter((item) => !item.accepted).length };
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

export type FinanceTool = {
  name: string;
  description: string;
  input: z.ZodRawShape;
  readOnly: boolean;
  run: (args: Record<string, unknown>, access: FinanceAccess) => Promise<ToolResult>;
};

export const financeTools: FinanceTool[] = [
  {
    name: "ai_status",
    description: "Prüft, ob das lokale Sprachmodell auf der NPU bereit ist.",
    input: {}, readOnly: true,
    run: async () => ok(await aiStatus()),
  },
  {
    name: "list_categories",
    description: "Listet alle erlaubten Ausgaben-/Einnahmekategorien des Finanzdashboards.",
    input: {}, readOnly: true,
    run: async () => ok(categories),
  },
  {
    name: "finance_summary",
    description: "Kurzer Überblick: Anzahl Buchungen, offene Prüfungen und Ausgaben je Kategorie für einen Monat (YYYY-MM).",
    input: { month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("Monat YYYY-MM, Standard: aktueller Monat") },
    readOnly: true,
    run: async (args, access) => {
      const state = read(access);
      const month = typeof args.month === "string" ? args.month : new Date().toISOString().slice(0, 7);
      const totals = new Map<string, number>();
      let income = 0;
      for (const row of state.transactions) {
        if (!row.date.startsWith(month)) continue;
        const result = classify(row);
        if (result.isTransfer) continue;
        if (row.amount > 0) income += row.amount;
        else totals.set(result.category, (totals.get(result.category) ?? 0) + row.amount);
      }
      return ok({
        month, transactions: state.transactions.length,
        openReviews: (state.reviewQueue ?? []).length,
        income: money(income),
        totalSpending: money([...totals.values()].reduce((sum, value) => sum + value, 0)),
        spending: Object.fromEntries([...totals].sort((a, b) => a[1] - b[1]).map(([key, value]) => [key, money(value)])),
      });
    },
  },
  {
    name: "finance_insights",
    description: "Erkennt Abos und Preiserhöhungen, meldet mögliche doppelte Abbuchungen, fasst den Monat zusammen und prognostiziert die Monatsausgaben.",
    input: {}, readOnly: true,
    run: async (_args, access) => ok(financeInsights(read(access))),
  },
  {
    name: "list_open_reviews",
    description: "Listet offene Buchungsprüfungen mit Grund. aiEligible=false heißt: braucht Bankdaten/Beleg vom Nutzer.",
    input: { limit: z.number().int().min(1).max(100).default(25) },
    readOnly: true,
    run: async (args, access) => {
      const limit = typeof args.limit === "number" ? args.limit : 25;
      return ok((read(access).reviewQueue ?? []).slice(0, limit).map((item) => item.kind === "booking" ? {
        reviewId: item.id, kind: "booking", reason: item.message, aiEligible: isAiEligibleReview(item),
        date: item.draft.date, amount: item.draft.amount, bank: item.draft.bank,
        description: item.draft.description.slice(0, 120), merchant: item.draft.merchantAlias,
      } : { reviewId: item.id, kind: "fixed", category: item.change.category, month: item.change.month, bookings: item.change.bookings.length }));
    },
  },
  {
    name: "search_transactions",
    description: "Sucht gebuchte Umsätze nach Text, Kategorie und Zeitraum.",
    input: {
      query: z.string().max(100).optional(),
      category: categoryEnum.optional(),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      limit: z.number().int().min(1).max(200).default(30),
    },
    readOnly: true,
    run: async (args, access) => {
      const query = typeof args.query === "string" ? args.query.toLocaleLowerCase("de-AT") : "";
      const limit = typeof args.limit === "number" ? args.limit : 30;
      const rows = read(access).transactions.filter((row) =>
        (!query || `${row.merchantAlias ?? ""} ${row.description}`.toLocaleLowerCase("de-AT").includes(query)) &&
        (!args.category || classify(row).category === args.category) &&
        (typeof args.from !== "string" || row.date >= args.from) &&
        (typeof args.to !== "string" || row.date <= args.to));
      return ok({ total: rows.length, rows: rows.slice(-limit).reverse().map(bookingView) });
    },
  },
  {
    name: "categorize_open_reviews",
    description: "Lässt die lokale KI offene Prüfungen kategorisieren. apply=true übernimmt nur Antworten mit hoher Sicherheit; Unsicheres bleibt offen.",
    input: {
      apply: z.boolean().default(false).describe("false = nur Vorschläge anzeigen"),
      limit: z.number().int().min(1).max(200).default(40),
    },
    readOnly: false,
    run: async (args, access) => ok(await categorizeOpenReviews(access, {
      apply: args.apply === true, limit: typeof args.limit === "number" ? args.limit : 40,
    })),
  },
  {
    name: "learn_categories_from_web",
    description: "Schlägt unbekannte Händler offener Kartenzahlungen im Internet nach (OpenStreetMap-Geschäftstyp, Wikidata, Händler-Webseite), merkt sich das Ergebnis und ordnet eindeutige Fälle zu.",
    input: { limit: z.number().int().min(1).max(60).default(20) },
    readOnly: false,
    run: async (args, access) => ok(await learnCategoriesFromWeb(access, {
      limit: typeof args.limit === "number" ? args.limit : 20,
    })),
  },
  {
    name: "assign_category",
    description: "Setzt die Kategorie einer offenen Prüfung (reviewId) oder einer gebuchten Transaktion (transactionId), optional mit Händlername.",
    input: {
      reviewId: z.string().max(200).optional(),
      transactionId: z.string().max(200).optional(),
      category: categoryEnum,
      merchantAlias: z.string().trim().min(2).max(100).optional(),
    },
    readOnly: false,
    run: async (args, access) => {
      const category = canonicalCategory(args.category as Category);
      if (typeof args.reviewId === "string") {
        let applied = false;
        write(access, (state) => {
          const outcome = applyAiReviewDecisions(state, [{
            reviewId: args.reviewId as string, category,
            merchantAlias: typeof args.merchantAlias === "string" ? args.merchantAlias : undefined,
          }]);
          applied = outcome.applied.length > 0;
          return outcome.state;
        });
        return applied ? ok({ applied: true }) : fail("Prüfung nicht gefunden oder benötigt Bankdaten vom Nutzer.");
      }
      if (typeof args.transactionId !== "string") return fail("reviewId oder transactionId angeben.");
      let found = false;
      write(access, (state) => {
        const transactions = state.transactions.map((row) => {
          if (row.id !== args.transactionId) return row;
          found = true;
          return transactionSchema.parse({ ...row, category, categoryOverride: true, manualCategory: true, reviewed: true, aiAssigned: true });
        });
        return found ? appStateSchema.parse(refreshPlanning(queueLedgerReview({ ...state, transactions }))) : state;
      });
      return found ? ok({ applied: true }) : fail("Transaktion nicht gefunden.");
    },
  },
  {
    name: "find_merchant_logo",
    description: "Sucht das offizielle Logo eines Händlers (Wikidata/Wikimedia Commons, offizielle Webseite, Marken-Domain) und legt es privat im Logo-Ordner ab.",
    input: { name: z.string().trim().min(2).max(90), context: z.string().max(300).optional() },
    readOnly: false,
    run: async (args) => ok(await findMerchantLogo(String(args.name), typeof args.context === "string" ? args.context : undefined)),
  },
  {
    name: "find_all_merchant_logos",
    description: "Sucht für alle Zahlungsempfänger ohne Logo (meiste Buchungen zuerst) das Logo im Internet und legt es privat im Logo-Ordner ab. Nicht gefundene werden erst nach 30 Tagen erneut gesucht; mehrfach aufrufen, solange remaining > 0.",
    input: { limit: z.number().int().min(1).max(25).optional() },
    readOnly: false,
    run: async (args, access) => ok(await sweepMissingLogos(new AutomationStore(access.database), access.userId, read(access), {
      limit: typeof args.limit === "number" ? args.limit : 10,
    })),
  },
];
