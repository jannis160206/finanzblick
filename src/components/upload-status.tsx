"use client";

import { Clock3 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader,
  DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { AutomationJobCard, AutomationStatus } from "@/components/automation-status";
import { StatementImportStatus } from "@/components/statement-import-status";
import { isActiveJob, isActiveUpload, type UploadActivity, type UploadPhase } from "@/components/upload-activity";
import type { AutomationJob } from "@/lib/automation/schema";
import { cn } from "@/lib/utils";
import { retainImportResults, type ImportResult } from "@/lib/import/results";
import { automationFailure } from "@/lib/automation/errors";

const phases: Record<UploadPhase, { status: AutomationJob["status"]; label: string }> = {
  waiting: { status: "QUEUED", label: "Wartet auf Übertragung" },
  uploading: { status: "UPLOADING", label: "Wird hochgeladen" },
  reading: { status: "PROCESSING", label: "Datei wird geprüft" },
  saving: { status: "PROCESSING", label: "Buchungen werden gespeichert" },
  accepted: { status: "QUEUED", label: "Angenommen · wartet auf Status" },
  completed: { status: "COMPLETED", label: "Abgeschlossen" },
  failed: { status: "FAILED", label: "Import fehlgeschlagen" },
};

const cancellablePhases = new Set<UploadPhase>(["waiting", "uploading", "accepted"]);

export function UploadStatus({
  activities, jobs, error, summary, reviewCount, results = [], onReview, onReupload, onCancel,
}: {
  activities: UploadActivity[];
  jobs: AutomationJob[];
  error: string | null;
  summary?: { imported: number; issues: string[] };
  reviewCount: number;
  results?: ImportResult[];
  onReview?: () => void;
  onReupload?: () => void;
  onCancel?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const retainedResults = retainImportResults(results);
  const resultById = new Map(retainedResults.map((result) => [result.uploadId, result]));
  const remoteIds = new Set(jobs.map((job) => job.id));
  const activityIds = new Set(activities.map((item) => item.id));
  const local = [
    ...activities.filter((item) => !remoteIds.has(item.id)).map((item) => ({
      ...item, result: resultById.get(item.id) ?? item.result,
    })),
    ...retainedResults.filter((result) => !remoteIds.has(result.uploadId) && !activityIds.has(result.uploadId))
      .map((result): UploadActivity => ({ id: result.uploadId, name: result.name,
        phase: result.status === "failed" ? "failed" : "completed",
        error: result.status === "failed" && result.errorCode ? automationFailure(result.errorCode).message : null,
        errorCode: result.errorCode, updatedAt: result.completedAt, result })),
  ];
  const activeCount = local.filter(isActiveUpload).length +
    jobs.filter((job) => job.kind === "statement" && isActiveJob(job)).length;
  const latestJobs = jobs.map((job) => {
    const failure = activities.find((item) => item.id === job.id && item.phase === "failed");
    return { ...job, result: resultById.get(job.id) ?? job.result,
      error: job.error ?? failure?.error ?? null };
  });
  const recentIds = new Set([
    ...local.filter((item) => !isActiveUpload(item)).reverse(),
    ...latestJobs.filter((job) => job.kind === "statement" && !isActiveJob(job)),
  ].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 2).map((item) => item.id));
  const visibleLocal = local.filter((item) => isActiveUpload(item) || recentIds.has(item.id));
  const visibleJobs = latestJobs.filter((job) => isActiveJob(job) || recentIds.has(job.id));
  const hasResults = retainedResults.length > 0 || latestJobs.some((job) => job.result);
  const hasIssues = !!error || (!hasResults && !!summary?.issues.length) ||
    visibleLocal.some((item) => item.phase === "failed" || (item.result && item.result.status !== "imported")) ||
    visibleJobs.some((job) => job.status === "FAILED" || !!job.error || (job.result && job.result.status !== "imported"));
  const empty = !visibleLocal.length && !visibleJobs.length && !summary && !error;
  const announcement = `${activeCount} ${activeCount === 1 ? "Upload" : "Uploads"} in Bearbeitung.${hasIssues ? " Importhinweise vorhanden." : ""}`;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="icon" className="relative size-11 shrink-0"
          aria-label="Uploadstatus" title={`Uploadstatus · ${announcement}`}>
          <Clock3 className="size-4" aria-hidden="true" />
          {(activeCount > 0 || hasIssues) && (
            <span aria-hidden="true" data-upload-badge
              className={cn("absolute -top-2 -right-2 flex min-w-5 items-center justify-center rounded-full border-2 border-card px-1 text-2xs leading-4 font-semibold tabular-nums",
                activeCount ? "bg-primary text-primary-foreground" : "bg-amber-500 text-black")}>
              {activeCount || "!"}
            </span>
          )}
          <span className="sr-only" role="status">{announcement}</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Uploadstatus</DialogTitle>
          <DialogDescription className="whitespace-normal">
            {activeCount ? announcement : "Die letzten zwei Imports und ihre Hinweise."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3 pt-0">
          {empty && <div className="rounded-xl border border-dashed p-6 text-center">
            <Clock3 className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">Noch keine Uploads</p>
            <p className="mt-1 text-xs text-muted-foreground">Neue Kontoauszüge und ihr Fortschritt erscheinen hier.</p>
          </div>}
          <div aria-live="polite" className="space-y-3">
            {visibleLocal.map((item) => <AutomationJobCard key={item.id}
              job={{ id: item.id, name: item.name, status: phases[item.phase].status,
                progress: item.phase === "completed" ? 100 : 0, error: item.error,
                result: item.result, errorCode: item.errorCode }}
              label={phases[item.phase].label}
              indeterminate={isActiveUpload(item)}
              onCancel={onCancel && cancellablePhases.has(item.phase) ? () => onCancel(item.id) : undefined}
              onReview={onReview ? () => { setOpen(false); onReview(); } : undefined}
              onReupload={onReupload ? () => { setOpen(false); onReupload(); } : undefined} />)}
          </div>
          <AutomationStatus jobs={visibleJobs} error={error} showCompleted onCancel={onCancel}
            onReview={onReview ? () => { setOpen(false); onReview(); } : undefined}
            onReupload={onReupload ? () => { setOpen(false); onReupload(); } : undefined} />
          {summary && !hasResults && <StatementImportStatus imported={summary.imported}
            issues={summary.issues} reviewCount={reviewCount} />}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
