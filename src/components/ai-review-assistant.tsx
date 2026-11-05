"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import type { AiReviewDecision } from "@/lib/ai/apply-review-decisions";
import { applyAndCount, autoAssignOpenReviews } from "@/lib/ai/auto-assign";
import type { AiCategorization } from "@/lib/ai/categorize";
import { decideReviewWithEvidence, industryContext, industryLookupName } from "@/lib/ai/evidence";
import { aiCategoryExamples, aiReviewCandidates, isAiEligibleReview } from "@/lib/ai/review-candidates";
import { recordAiSuggestions, type AiSuggestionEntry } from "@/lib/ai/suggestions";

const STATUS_INTERVAL_MS = 60_000;

async function postJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

// Sends open booking reviews to the local NPU model; only confident answers are applied.
export function AiReviewAssistant() {
  const { state, ready, storageError, update } = useFinance();
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const unmounted = useRef(new AbortController());
  const attempted = useRef(new Set<string>());
  const logoNames = useRef(new Set<string>());
  const latest = useRef(state);
  const totals = useRef({ applied: 0, open: 0 });
  useEffect(() => {
    latest.current = state;
  }, [state]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const response = await fetch("/api/ai/status", { signal: controller.signal, cache: "no-store" });
        const body = response.ok ? await response.json() as { available?: boolean } : {};
        setAvailable(body.available === true);
      } catch {
        if (!controller.signal.aborted) setAvailable(false);
      }
      if (!controller.signal.aborted) timer = setTimeout(check, STATUS_INTERVAL_MS);
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const claimed = attempted.current;
    unmounted.current = controller;
    return () => {
      controller.abort();
      // A later mount (React StrictMode remount) may resume batches this instance had claimed.
      claimed.clear();
      setBusy(false);
    };
  }, []);

  const openKey = (state.reviewQueue ?? []).filter(isAiEligibleReview).map((item) => item.id).join("|");

  // Fixed merchant rules, own history and refunds need no model, so they also run offline.
  useEffect(() => {
    if (!ready || storageError || !openKey) return;
    const base = latest.current;
    const preview = autoAssignOpenReviews(base);
    if (preview.state === base) return;
    update((current) => current === base ? preview.state : autoAssignOpenReviews(current).state);
    const done = preview.applied.length;
    if (done) toast.success(`${done} Buchung${done === 1 ? "" : "en"} per Händlerregel, Historie oder Erstattung zugeordnet`);
  }, [ready, storageError, openKey, update]);

  useEffect(() => {
    if (!available || !ready || storageError || busy || !openKey) return;
    // Bookings with a stored proposal already waited for the user; asking again would only repeat it.
    const skip = new Set([...attempted.current, ...(latest.current.aiSuggestions ?? []).map((item) => item.id)]);
    const batch = aiReviewCandidates(latest.current, skip);
    if (!batch.length) return;
    const signal = unmounted.current.signal;
    for (const candidate of batch) attempted.current.add(candidate.reviewId);
    setBusy(true);
    void (async () => {
      try {
        const { results } = await postJson<{ results: AiCategorization[] }>("/api/ai/categorize", {
          bookings: batch.map((candidate) => candidate.input),
          examples: aiCategoryExamples(latest.current),
        }, signal);
        const byRef = new Map(results.map((result) => [result.ref, result]));
        // Shops nobody knows yet: their industry from Wikidata or their website is independent evidence.
        const lookups = new Map<string, string>();
        for (const candidate of batch) {
          const answer = byRef.get(candidate.input.ref);
          if (decideReviewWithEvidence(latest.current, candidate.reviewId, candidate.input, answer).accepted) continue;
          const name = industryLookupName(candidate.input, answer);
          if (name) lookups.set(candidate.reviewId, name);
        }
        const industries = new Map<string, { category?: string; label?: string }>();
        if (lookups.size) {
          const { results: found } = await postJson<{ results: { name: string; category?: string; label?: string }[] }>(
            "/api/ai/industry", { names: [...new Set(lookups.values())].slice(0, 12) }, signal,
          ).catch(() => ({ results: [] }));
          for (const item of found) industries.set(item.name, item);
        }
        const decisions: AiReviewDecision[] = [];
        const suggestions: AiSuggestionEntry[] = [];
        const logos: { name: string; context: string }[] = [];
        for (const candidate of batch) {
          const result = byRef.get(candidate.input.ref);
          const context = industryContext(industries.get(lookups.get(candidate.reviewId) ?? ""));
          const decision = decideReviewWithEvidence(latest.current, candidate.reviewId, candidate.input, result, context);
          if (!decision.accepted) {
            suggestions.push({ reviewId: candidate.reviewId, reason: decision.reason, suggestion: decision.suggestion });
            continue;
          }
          decisions.push({ reviewId: candidate.reviewId, category: decision.category, merchantAlias: decision.merchantAlias });
          if (decision.merchantAlias) logos.push({ name: decision.merchantAlias, context: candidate.input.text });
        }
        let applied = 0;
        if (decisions.length || suggestions.some((entry) => entry.suggestion)) {
          const base = latest.current;
          const run = (current: typeof base) =>
            recordAiSuggestions(applyAndCount(current, decisions).state, suggestions);
          const preview = applyAndCount(base, decisions);
          applied = preview.applied.length;
          const next = recordAiSuggestions(preview.state, suggestions);
          if (next !== base) update((current) => current === base ? next : run(current));
        }
        totals.current.applied += applied;
        totals.current.open += batch.length - applied;
        if (!aiReviewCandidates(latest.current, attempted.current).length && totals.current.applied) {
          const { applied: done, open } = totals.current;
          toast.success(`Lokale KI hat ${done} Buchung${done === 1 ? "" : "en"} zugeordnet`, {
            description: open ? `${open} bleiben zur manuellen Prüfung.` : "Keine offenen Fälle für die KI.",
          });
          totals.current = { applied: 0, open: 0 };
        }
        for (const logo of logos) {
          const key = logo.name.toLocaleLowerCase("de-AT");
          if (logoNames.current.has(key)) continue;
          logoNames.current.add(key);
          await postJson("/api/ai/logo", logo, signal).catch(() => undefined);
        }
      } catch {
        if (signal.aborted) return;
        // An unreachable model retries this batch later instead of looping.
        setTimeout(() => {
          for (const candidate of batch) attempted.current.delete(candidate.reviewId);
          setRetry((value) => value + 1);
        }, STATUS_INTERVAL_MS);
      } finally {
        if (!signal.aborted) setBusy(false);
      }
    })();
  }, [available, ready, storageError, busy, openKey, retry, update]);

  return null;
}