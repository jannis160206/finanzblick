"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { MERCHANT_LOGOS_CHANGED } from "@/components/merchant-marks-provider";
import type { AiReviewDecision } from "@/lib/ai/apply-review-decisions";
import { applyAndCount, autoAssignAndCount, autoAssignOpenReviews, webContextFor, type AutoAssignResult } from "@/lib/ai/auto-assign";
import type { AiCategorization } from "@/lib/ai/categorize";
import { decideReviewWithEvidence, industryContext, industryLookupName } from "@/lib/ai/evidence";
import type { Industry } from "@/lib/ai/industry";
import { aiCategoryExamples, aiReviewCandidates, isAiEligibleReview } from "@/lib/ai/review-candidates";
import { recordAiSuggestions, type AiSuggestionEntry } from "@/lib/ai/suggestions";
import { pendingWebLookups, recordWebCategories, webHabits, type WebTarget } from "@/lib/ai/web-categories";
import { runFinanceTask, type AssignPreview } from "@/lib/finance-worker";
import type { AppState } from "@/lib/types";
import { onlyAssistantChanged, withAssistantState } from "@/lib/assistant-state";

const assignPreview = (base: AppState, outcome: AutoAssignResult): AssignPreview =>
  outcome.state === base ? { changed: false, applied: outcome.applied } : { changed: true, state: outcome.state, applied: outcome.applied };

const STATUS_INTERVAL_MS = 60_000;
const WEB_BATCH = 8;
const LOGO_SWEEP_ROUNDS = 40;
const LOGO_SWEEP_PAUSE_MS = 3_000;
const LOGO_SWEEP_LIMIT_PAUSE_MS = 60_000;
const logoSweep = { started: false };

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
  const [webBusy, setWebBusy] = useState(false);
  const webAttempted = useRef(new Set<string>());
  const webTotals = useRef(0);
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
    const webClaimed = webAttempted.current;
    unmounted.current = controller;
    return () => {
      controller.abort();
      // A later mount (React StrictMode remount) may resume batches this instance had claimed.
      claimed.clear();
      webClaimed.clear();
      setBusy(false);
      setWebBusy(false);
    };
  }, []);

  const openKey = (state.reviewQueue ?? []).filter(isAiEligibleReview).map((item) => item.id).join("|");

  // Fixed merchant rules, own history and refunds need no model, so they also run offline.
  useEffect(() => {
    if (!ready || storageError || !openKey) return;
    const base = latest.current;
    let cancelled = false;
    const apply = (preview: AssignPreview) => {
      if (cancelled || !preview.changed) return;
      // A chat written while the worker ran changes no figure, so its result still applies instead of a second pass here.
      update((current) => current === base ? preview.state
        : onlyAssistantChanged(base, current) ? withAssistantState(preview.state, current) : autoAssignOpenReviews(current).state);
      const done = preview.applied.length;
      if (done) toast.success(`${done} Buchung${done === 1 ? "" : "en"} per Händlerregel, Historie oder Erstattung zugeordnet`);
    };
    // The evidence check scans the whole ledger; a worker keeps the page responsive while it runs.
    const offThread = runFinanceTask<AssignPreview>({ kind: "autoAssign", state: base });
    if (offThread) void offThread.then(apply, () => apply(assignPreview(base, autoAssignOpenReviews(base))));
    else apply(assignPreview(base, autoAssignOpenReviews(base)));
    return () => { cancelled = true; };
  }, [ready, storageError, openKey, update]);

  // Unknown shops are looked up on the internet (OpenStreetMap shop type, Wikidata, website) and remembered;
  // this needs no model, only network. Each shop is asked once per page visit.
  useEffect(() => {
    if (!ready || storageError || webBusy || !openKey) return;
    const batch = pendingWebLookups(latest.current, WEB_BATCH, webAttempted.current);
    if (!batch.length) return;
    const signal = unmounted.current.signal;
    for (const target of batch) webAttempted.current.add(target.key);
    setWebBusy(true);
    void (async () => {
      try {
        const { results } = await postJson<{ results: { key: string; industry?: Industry }[] }>("/api/ai/web-categories", {
          targets: batch.map((target) => ({ key: target.key, name: target.name, ...target.place })),
        }, signal);
        const byKey = new Map(batch.map((target) => [target.key, target]));
        const found = results.flatMap((result) => {
          const target = byKey.get(result.key);
          return target ? [{ target, industry: result.industry } as { target: WebTarget; industry?: Industry }] : [];
        });
        if (!found.length) return;
        const base = latest.current;
        const now = Date.now();
        const preview = await (runFinanceTask<AssignPreview>({ kind: "webAssign", state: base, found, now })?.catch(() => null) ?? null)
          ?? assignPreview(base, autoAssignAndCount(recordWebCategories(base, found, now)));
        if (signal.aborted) return;
        const next = preview.changed ? preview.state : base;
        update((current) => current === base ? next
          : onlyAssistantChanged(base, current) ? withAssistantState(next, current) : autoAssignAndCount(recordWebCategories(current, found)).state);
        webTotals.current += preview.applied.length;
        if (!pendingWebLookups(next, 1, webAttempted.current).length && webTotals.current) {
          const done = webTotals.current;
          toast.success(`${done} Buchung${done === 1 ? "" : "en"} per Internet-Recherche zugeordnet`);
          webTotals.current = 0;
        }
      } catch {
        if (signal.aborted) return;
        // Offline or busy: allow another try later.
        setTimeout(() => {
          for (const target of batch) webAttempted.current.delete(target.key);
          setRetry((value) => value + 1);
        }, STATUS_INTERVAL_MS);
      } finally {
        if (!signal.aborted) setWebBusy(false);
      }
    })();
  }, [ready, storageError, webBusy, openKey, retry, update]);

  // Payees without a logo get one from the internet (Wikidata/Commons, the official website, the brand's
  // own domain), a few at a time in the background. Not found ones are retried by the server after 30 days.
  const hasBookings = state.transactions.length > 0;
  useEffect(() => {
    if (!ready || storageError || !hasBookings || logoSweep.started) return;
    logoSweep.started = true;
    // Not tied to this component: the sweep goes on in the background while the user navigates.
    const signal = new AbortController().signal;
    void (async () => {
      let saved = 0;
      try {
        for (let round = 0; round < LOGO_SWEEP_ROUNDS; round++) {
          const result = await postJson<{ saved: unknown[]; checked: number; remaining: number; rateLimited: boolean }>(
            "/api/ai/logos", { limit: 5 }, signal,
          );
          saved += result.saved.length;
          if (result.saved.length) window.dispatchEvent(new Event(MERCHANT_LOGOS_CHANGED));
          if (!result.remaining || (!result.checked && !result.rateLimited)) break;
          // Wikidata asks for a pause after a burst of lookups; the sweep continues once it is over.
          await new Promise((resolve) => setTimeout(resolve, result.rateLimited ? LOGO_SWEEP_LIMIT_PAUSE_MS : LOGO_SWEEP_PAUSE_MS));
        }
      } catch {
        // Offline, logged out or another sweep running; the next page load continues.
      }
      if (saved)
        toast.success(`${saved} neue${saved === 1 ? "s" : ""} Händler-Logo${saved === 1 ? "" : "s"} geladen`);
    })();
  }, [ready, storageError, hasBookings]);

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
        const habits = webHabits(latest.current);
        const stored = new Map(batch.map((candidate) => [candidate.reviewId, webContextFor(latest.current, candidate.reviewId, habits)]));
        for (const candidate of batch) {
          const answer = byRef.get(candidate.input.ref);
          const known = stored.get(candidate.reviewId)!;
          if (known.industry || decideReviewWithEvidence(latest.current, candidate.reviewId, candidate.input, answer).accepted) continue;
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
          const looked = industryContext(industries.get(lookups.get(candidate.reviewId) ?? ""));
          const context = looked.industry ? looked : stored.get(candidate.reviewId)!;
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
          toast.success(`Lokale KI hat ${done} Buchung${done === 1 ? "" : "en"} zugeordnet${open ? ` · ${open} bitte selbst prüfen` : ""}`);
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