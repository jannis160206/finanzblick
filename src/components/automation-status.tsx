"use client";

import { useAutomation } from "./automation-context";
import type { AutomationJob } from "@/lib/automation/schema";

const labels: Record<AutomationJob["status"], string> = {
  UPLOADING: "Wird hochgeladen",
  QUEUED: "In der Warteschlange",
  PROCESSING: "Wird verarbeitet",
  RETRYING: "Erneuter Versuch geplant",
  COMPLETED: "Abgeschlossen",
  FAILED: "Verarbeitung fehlgeschlagen",
};

export function AutomationStatus() {
  const { jobs, error } = useAutomation();
  if (!jobs.length && !error) return null;
  return (
    <section
      aria-label="Hintergrundverarbeitung"
      className="mb-4 space-y-3 rounded-2xl border bg-card p-4"
    >
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div aria-live="polite" className="space-y-3">
        {jobs.slice(0, 5).map((job) => (
          <div key={job.id} className="space-y-1">
            <div className="flex flex-wrap justify-between gap-2 text-xs">
              <span className="truncate font-medium">{job.name}</span>
              <span>
                {labels[job.status]} · {job.progress}%
              </span>
            </div>
            <progress
              aria-label={`Fortschritt: ${job.name}`}
              value={job.progress}
              max={100}
              className="h-1.5 w-full accent-primary"
            />
            {job.error && (
              <p className="text-xs text-destructive">{job.error}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
