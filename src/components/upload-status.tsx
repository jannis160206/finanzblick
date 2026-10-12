"use client";

import { Clock3 } from "lucide-react";
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

const phases: Record<UploadPhase, { status: AutomationJob["status"]; label: string }> = {
  waiting: { status: "QUEUED", label: "Wartet auf Übertragung" },
  uploading: { status: "UPLOADING", label: "Wird hochgeladen" },
  reading: { status: "PROCESSING", label: "Datei wird geprüft" },
  saving: { status: "PROCESSING", label: "Buchungen werden gespeichert" },
  accepted: { status: "QUEUED", label: "Angenommen · wartet auf Status" },
  completed: { status: "COMPLETED", label: "Abgeschlossen" },
  failed: { status: "FAILED", label: "Import fehlgeschlagen" },
};

export function UploadStatus({
  activities, jobs, error, summary, reviewCount,
}: {
  activities: UploadActivity[];
  jobs: AutomationJob[];
  error: string | null;
  summary?: { imported: number; issues: string[] };
  reviewCount: number;
}) {
  const remoteIds = new Set(jobs.map((job) => job.id));
  const local = activities.filter((item) => !remoteIds.has(item.id));
  const activeCount = local.filter(isActiveUpload).length +
    jobs.filter((job) => job.kind === "statement" && isActiveJob(job)).length;
  const hasIssues = !!error || !!summary?.issues.length ||
    activities.some((item) => item.phase === "failed") ||
    jobs.some((job) => job.status === "FAILED" || !!job.error);
  const latestJobs = jobs.map((job) => {
    const failure = activities.find((item) => item.id === job.id && item.phase === "failed");
    return failure ? { ...job, error: job.error ?? failure.error } : job;
  });
  const empty = !local.length && !jobs.length && !summary && !error;
  const announcement = `${activeCount} ${activeCount === 1 ? "Upload" : "Uploads"} in Bearbeitung.${hasIssues ? " Importhinweise vorhanden." : ""}`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="icon" className="relative size-11 shrink-0"
          aria-label="Uploadstatus" title={`Uploadstatus · ${announcement}`}>
          <Clock3 className="size-4" aria-hidden="true" />
          {(activeCount > 0 || hasIssues) && (
            <span aria-hidden="true" data-upload-badge
              className={cn("absolute -top-2 -right-2 flex min-w-5 items-center justify-center rounded-full border-2 border-card px-1 text-[10px] leading-4 font-semibold tabular-nums",
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
            {activeCount ? announcement : "Aktuelle Uploads, Ergebnisse und Importhinweise."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3 pt-0">
          {empty && <div className="rounded-xl border border-dashed p-6 text-center">
            <Clock3 className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">Noch keine Uploads</p>
            <p className="mt-1 text-xs text-muted-foreground">Neue Kontoauszüge und ihr Fortschritt erscheinen hier.</p>
          </div>}
          <div aria-live="polite" className="space-y-3">
            {local.map((item) => <AutomationJobCard key={item.id}
              job={{ id: item.id, name: item.name, status: phases[item.phase].status,
                progress: item.phase === "completed" ? 100 : 0, error: item.error }}
              label={phases[item.phase].label}
              indeterminate={isActiveUpload(item)} />)}
          </div>
          <AutomationStatus jobs={latestJobs} error={error} showCompleted />
          {summary && <StatementImportStatus imported={summary.imported}
            issues={summary.issues} reviewCount={reviewCount} />}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
