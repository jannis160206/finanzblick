"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import { useAutomation } from "./automation-context";
import type { AutomationJob } from "@/lib/automation/schema";
import { cn } from "@/lib/utils";
import { isActiveJob } from "@/components/upload-activity";
import { importResultLabel, type ImportResult } from "@/lib/import/results";
import { Button } from "@/components/ui/button";

const statuses = {
  UPLOADING: {
    label: "Wird hochgeladen",
    Icon: Loader2,
    animation: "animate-spin",
  },
  QUEUED: {
    label: "In der Warteschlange",
    Icon: Clock3,
    animation: "animate-pulse",
  },
  PROCESSING: {
    label: "Wird verarbeitet",
    Icon: Loader2,
    animation: "animate-spin",
  },
  RETRYING: {
    label: "Erneuter Versuch geplant",
    Icon: RotateCw,
    animation: "animate-pulse",
  },
  COMPLETED: { label: "Abgeschlossen", Icon: CheckCircle2, animation: "" },
  FAILED: {
    label: "Verarbeitung fehlgeschlagen",
    Icon: AlertTriangle,
    animation: "",
  },
};
const EXIT_MS = 350;
type JobCard = { job: AutomationJob; exiting: boolean; generation: number };
const exitKey = (card: JobCard) => `${card.job.id}:${card.generation}`;

function useJobCards(jobs: AutomationJob[], showCompleted: boolean) {
  const [presence, setPresence] = useState(() => ({
    source: jobs,
    cards: jobs
      .filter((job) => showCompleted || job.status !== "COMPLETED")
      .map((job): JobCard => ({ job, exiting: false, generation: 0 })),
  }));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Retain disappearing cards for their exit transition, without replaying old completions.
  if (presence.source !== jobs) {
    const previous = new Map(presence.cards.map((card) => [card.job.id, card]));
    const incoming = new Set(jobs.map((job) => job.id));
    const leave = (card: JobCard): JobCard => ({
      ...card,
      exiting: true,
      generation: card.generation + (card.exiting ? 0 : 1),
    });
    const cards = jobs.flatMap((job): JobCard[] => {
      const old = previous.get(job.id);
      if (!showCompleted && job.status === "COMPLETED")
        return old ? [leave({ ...old, job })] : [];
      return [{ job, exiting: false, generation: old?.generation ?? 0 }];
    });
    for (const card of presence.cards)
      if (!incoming.has(card.job.id)) cards.push(leave(card));
    setPresence({ source: jobs, cards });
  }

  useEffect(() => {
    const exits = presence.cards.filter((card) => card.exiting);
    const keys = new Set(exits.map(exitKey));
    for (const [key, timer] of timers.current) {
      if (keys.has(key)) continue;
      clearTimeout(timer);
      timers.current.delete(key);
    }
    for (const card of exits) {
      const key = exitKey(card);
      if (timers.current.has(key)) continue;
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          setPresence((current) => ({
            ...current,
            cards: current.cards.filter(
              (item) => !item.exiting || exitKey(item) !== key,
            ),
          }));
        }, EXIT_MS),
      );
    }
  }, [presence.cards]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);
  return presence.cards;
}

export function AutomationJobCard({ job, exiting = false, label: customLabel, indeterminate = job.status === "UPLOADING",
  onReview, onReupload, onCancel,
}: {
  job: Pick<AutomationJob, "id" | "name" | "status" | "progress" | "error"> & {
    result?: ImportResult | null;
    errorCode?: AutomationJob["errorCode"];
  };
  exiting?: boolean;
  label?: string;
  indeterminate?: boolean;
  onReview?: () => void;
  onReupload?: () => void;
  onCancel?: () => void;
}) {
  const errorId = useId();
  const { label: statusLabel, Icon: StatusIcon, animation } = statuses[job.status];
  const result = job.status === "COMPLETED" ? job.result : undefined;
  const label = result ? importResultLabel(result) : customLabel ?? statusLabel;
  const processing = job.status === "PROCESSING";
  const failed = job.status === "FAILED";
  const completed = job.status === "COMPLETED";
  const warning = completed && result && result.status !== "imported";
  const Icon = warning ? AlertTriangle : StatusIcon;
  const percentage = Math.round(Math.min(100, Math.max(0, job.progress)));
  const tone = failed
    ? "text-rose-600 dark:text-rose-300"
    : warning
      ? "text-amber-700 dark:text-amber-300"
      : processing || completed
      ? "text-primary"
      : "text-muted-foreground";
  return (
    <article
      aria-label={`Verarbeitung: ${job.name}`}
      aria-hidden={exiting || undefined}
      className={cn(
        "rounded-2xl border border-border/70 bg-card bg-linear-to-br from-card to-card/90 p-4 shadow-sm transition-[opacity,transform] duration-300 ease-out sm:p-5 motion-reduce:animate-none motion-reduce:transition-none",
        processing && "border-primary/20 to-primary/5",
        failed && "border-rose-400/20",
        warning && "border-amber-400/30",
        exiting
          ? "pointer-events-none -translate-y-1 opacity-0"
          : "animate-in fade-in slide-in-from-top-2",
      )}
    >
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <span
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 ring-1 ring-inset ring-border/60",
            tone,
            processing && "bg-primary/10 ring-primary/15",
            failed && "bg-rose-500/10 ring-rose-400/15",
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-[18px] motion-reduce:animate-none", animation)}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-sm font-medium text-foreground"
            title={job.name}
          >
            {job.name}
          </p>
          <span
            className={cn(
              "mt-1.5 inline-flex items-center rounded-full bg-muted/60 px-2 py-0.5 text-[11px] font-medium",
              tone,
              processing && "bg-primary/10",
              failed && "bg-rose-500/10",
            )}
          >
            {label}
          </span>
        </div>
        {completed && <div className="order-last w-full min-w-0 space-y-2 text-xs">
          {result ? <>
            <dl className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Importergebnis">
              {[
                ["Neu", result.inserted], ["Aktualisiert", result.updated], ["Duplikate", result.duplicates],
                ["Prüfung", result.review], ["Übersprungen", result.skipped],
              ].map(([name, count]) => <div key={name} className="flex gap-1">
                <dt className="text-muted-foreground">{name}</dt>
                <dd className="font-semibold tabular-nums">{count}</dd>
              </div>)}
            </dl>
            {result.inserted === 0 && <p className="text-muted-foreground">
              {result.duplicates > 0 && result.updated === 0 && result.review === 0 && result.skipped === 0
                ? "Keine neuen Buchungen: Alle erkannten Buchungen waren bereits vorhanden."
                : result.status === "unsupported"
                  ? "Keine neuen Buchungen: Dieses Dateiformat wurde nicht unterstützt."
                  : "Keine neuen Buchungen. Aktualisierungen und offene Prüfungen stehen oben."}
            </p>}
            {(result.review > 0 || result.issues.length > 0 || result.status === "unsupported") && <div className="flex flex-wrap gap-2">
              {result.review > 0 && onReview && <Button size="sm" variant="outline" onClick={onReview}>Buchungen korrigieren</Button>}
              {(result.status === "unsupported" || result.issues.some((issue) => issue.action === "reupload")) && onReupload &&
                <Button size="sm" variant="outline" onClick={onReupload}>Auszug erneut auswählen</Button>}
            </div>}
            {result.issues.length > 0 && <details className="rounded-lg border p-2">
              <summary className="cursor-pointer font-medium">Importhinweise ({result.issues.length})</summary>
              <ul className="mt-2 space-y-2">
                {result.issues.map((issue) => <li key={issue.id} className="break-words">
                  {issue.line && <span className="text-muted-foreground">Zeile {issue.line}: </span>}{issue.message}
                  {issue.evidence && <p className="mt-1 text-muted-foreground">Quellbeleg: {issue.evidence}</p>}
                  <p className="mt-1 text-muted-foreground">{issue.action === "correct"
                    ? "Quellbeleg prüfen und Buchung ausdrücklich bestätigen."
                    : "Vollständigen unterstützten EUR-Auszug erneut auswählen; keine Werte werden geraten."}</p>
                </li>)}
              </ul>
            </details>}
          </> : <p className="text-muted-foreground">
            Technisch abgeschlossen. Ergebniszahlen für diesen älteren Import sind nicht verfügbar.
          </p>}
        </div>}
        {!indeterminate && <span
          className={cn(
            "w-12 shrink-0 pt-0.5 text-right text-sm font-semibold tabular-nums",
            tone,
          )}
        >
          {percentage}%
        </span>}
        {onCancel && !completed && !failed && <Button type="button" variant="ghost" size="icon"
          className="-mt-1 -mr-1 size-8 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Verarbeitung abbrechen: ${job.name}`} title="Abbrechen" onClick={onCancel}>
          <X className="size-4" aria-hidden="true" />
        </Button>}
      </div>
      <div
        role="progressbar"
        aria-label={`Fortschritt: ${job.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percentage}
        aria-valuetext={indeterminate ? label : `${percentage}% (${label})`}
        aria-describedby={job.error ? errorId : undefined}
        className="h-2 overflow-hidden rounded-full bg-muted/80 ring-1 ring-inset ring-foreground/5"
      >
        <div
          className={cn(
            "relative h-full overflow-hidden rounded-full bg-primary transition-all duration-500 ease-out motion-reduce:transition-none",
            (processing || indeterminate) && "automation-progress-shimmer",
            indeterminate && "animate-pulse motion-reduce:animate-none",
            failed && "bg-rose-500",
          )}
          style={{ width: indeterminate ? "35%" : `${percentage}%` }}
        />
      </div>
      {job.error && (
        <p
          id={errorId}
          role="alert"
          className={cn(
            "mt-3 rounded-xl border px-3 py-2 text-xs leading-relaxed break-words",
            failed
              ? "border-rose-400/15 bg-rose-500/5 text-rose-600 dark:text-rose-300"
              : "border-border/60 bg-muted/30 text-muted-foreground",
          )}
        >
          {job.error}
        </p>
      )}
      {failed && onReupload && (!job.errorCode || (job.errorCode.startsWith("PARSE_") &&
        job.errorCode !== "PARSE_INFRASTRUCTURE")) && (
          <Button className="mt-3" size="sm" variant="outline" onClick={onReupload}>Auszug erneut auswählen</Button>
        )}
    </article>
  );
}

export function AutomationStatus({ jobs: suppliedJobs, error: suppliedError, showCompleted = false, onReview, onReupload, onCancel }: {
  jobs?: AutomationJob[];
  error?: string | null;
  showCompleted?: boolean;
  onReview?: () => void;
  onReupload?: () => void;
  onCancel?: (id: string) => void;
} = {}) {
  const automation = useAutomation();
  const jobs = suppliedJobs ?? automation.jobs;
  const error = suppliedError === undefined ? automation.error : suppliedError;
  const cards = useJobCards(jobs, showCompleted);
  const workerMissing = automation.worker?.running === false && jobs.some(isActiveJob);
  if (!cards.length && !error && !automation.catalogue) return null;
  return (
    <section aria-label="Hintergrundverarbeitung" className="mb-4 space-y-3">
      {automation.catalogue && (
        <p role={automation.catalogue.warning ? "alert" : "status"}
          className="rounded-xl border border-border/70 bg-muted/30 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {automation.catalogue.warning ?? (automation.catalogue.status === "refreshing"
            ? "Öffentliche Händlerquellen werden aktualisiert. Buchungsdaten bleiben lokal."
            : `Händlererkennung: ${automation.catalogue.sources} öffentliche Kataloggebiete eingelesen · zusätzlich lokale Regeln, Buchungszweck und bestätigte Zuordnungen.`)}
        </p>
      )}
      {workerMissing && (
        <p role="alert"
          className="rounded-xl border border-amber-400/30 bg-amber-500/5 px-4 py-3 text-sm leading-relaxed text-amber-800 dark:text-amber-200">
          Der Hintergrund-Worker läuft nicht, deshalb wartet die Verarbeitung. Bitte <code>npm run worker</code> starten;
          wartende Auszüge werden danach automatisch abgearbeitet.
        </p>
      )}      {error && (
        <p
          role="alert"
          className="rounded-xl border border-rose-400/20 bg-rose-500/5 px-4 py-3 text-sm text-rose-600 dark:text-rose-300"
        >
          {error}
        </p>
      )}
      <div
        aria-live="polite"
        aria-relevant="additions text"
        className="space-y-3"
      >
        {cards.map((card) => (
          <AutomationJobCard key={card.job.id} {...card} onReview={onReview} onReupload={onReupload}
            onCancel={onCancel && card.job.kind === "statement" ? () => onCancel(card.job.id) : undefined} />
        ))}
      </div>
    </section>
  );
}
