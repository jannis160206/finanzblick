"use client";

import { useCallback, useState } from "react";
import type { AutomationJob } from "@/lib/automation/schema";

export type UploadPhase = "waiting" | "uploading" | "reading" | "saving" | "accepted" | "completed" | "failed";
export type UploadActivity = {
  id: string;
  name: string;
  phase: UploadPhase;
  error: string | null;
  updatedAt: number;
};

export function isActiveUpload(activity: UploadActivity) {
  return activity.phase !== "completed" && activity.phase !== "failed";
}

export function isActiveJob(job: AutomationJob) {
  return job.status !== "COMPLETED" && job.status !== "FAILED";
}

function boundedActivities(activities: UploadActivity[]) {
  const recent = new Set(activities.filter((item) => !isActiveUpload(item))
    .reverse().sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 2).map((item) => item.id));
  return activities.filter((item) => isActiveUpload(item) || recent.has(item.id));
}

export function useUploadActivity(jobs: AutomationJob[]) {
  const [activities, setActivities] = useState<UploadActivity[]>([]);
  // A shared UUID hands off to the account's realtime job without filename matching.
  const ids = new Set(jobs.map((job) => job.id));
  const remaining = activities.filter((item) => item.phase !== "accepted" || !ids.has(item.id));
  if (remaining.length !== activities.length) setActivities(remaining);
  const add = useCallback((items: UploadActivity[]) => {
    setActivities((current) => boundedActivities([...current, ...items]));
  }, []);
  const change = useCallback((ids: string[], phase: UploadPhase, error: string | null = null) => {
    const selected = new Set(ids);
    const updatedAt = Date.now();
    setActivities((current) => boundedActivities(current.map((item) =>
      selected.has(item.id) ? { ...item, phase, error, updatedAt } : item,
    )));
  }, []);
  return { activities, add, change };
}
