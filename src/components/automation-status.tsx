"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  RotateCw,
} from "lucide-react";
import { useAutomation } from "./automation-context";
import type { AutomationJob } from "@/lib/automation/schema";
import { cn } from "@/lib/utils";

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

export function AutomationJobCard({ job, exiting = false, label: customLabel, indeterminate = job.status === "UPLOADING" }: {
  job: Pick<AutomationJob, "id" | "name" | "status" | "progress" | "error">;
  exiting?: boolean;
  label?: string;
  indeterminate?: boolean;
}) {
  const errorId = useId();
  const { label: statusLabel, Icon, animation } = statuses[job.status];
  const label = customLabel ?? statusLabel;
  const processing = job.status === "PROCESSING";
  const failed = job.status === "FAILED";
  const completed = job.status === "COMPLETED";
  const percentage = Math.round(Math.min(100, Math.max(0, job.progress)));
  const tone = failed
    ? "text-rose-600 dark:text-rose-300"
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
        exiting
          ? "pointer-events-none -translate-y-1 opacity-0"
          : "animate-in fade-in slide-in-from-top-2",
      )}
    >
      <div className="mb-4 flex items-start gap-3">
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
        {!indeterminate && <span
          className={cn(
            "w-12 shrink-0 pt-0.5 text-right text-sm font-semibold tabular-nums",
            tone,
          )}
        >
          {percentage}%
        </span>}
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
    </article>
  );
}

export function AutomationStatus({ jobs: suppliedJobs, error: suppliedError, showCompleted = false }: {
  jobs?: AutomationJob[];
  error?: string | null;
  showCompleted?: boolean;
} = {}) {
  const automation = useAutomation();
  const jobs = suppliedJobs ?? automation.jobs;
  const error = suppliedError === undefined ? automation.error : suppliedError;
  const cards = useJobCards(jobs, showCompleted);
  if (!cards.length && !error) return null;
  return (
    <section aria-label="Hintergrundverarbeitung" className="mb-4 space-y-3">
      {error && (
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
          <AutomationJobCard key={card.job.id} {...card} />
        ))}
      </div>
    </section>
  );
}
