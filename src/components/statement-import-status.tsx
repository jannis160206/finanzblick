"use client";

import { useId, useState } from "react";
import {
  Check,
  ChevronDown,
  FileImage,
  FileText,
  ListChecks,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function issueDetails(issue: string) {
  const parts =
    /^(.*?\.(?:csv|xlsx|pdf|png|jpe?g|webp))(?:, Zeile (\d+))?: ([\s\S]+)$/i.exec(
      issue,
    );
  const message = parts?.[3] ?? issue;
  const screenshot = /^Amex-Screenshot:\s*([\s\S]+)$/.exec(message);
  return {
    file: parts?.[1],
    line: parts?.[2],
    source: screenshot ? "Amex-Screenshot" : undefined,
    message: screenshot?.[1] ?? message,
  };
}

export function StatementImportStatus({
  imported,
  reviewCount,
  issues,
}: {
  imported: number;
  reviewCount: number;
  issues: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const hintsId = useId();
  const stats = [
    { label: "Übernommen", value: imported, icon: Check, accent: imported > 0 },
    {
      label: "Prüfung offen",
      value: reviewCount,
      icon: ListChecks,
      accent: false,
    },
  ];
  return (
    <section
      aria-label="Importstatus"
      className="mb-4 overflow-hidden rounded-2xl border border-border/70 bg-card/60"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:px-5">
        <dl className="flex flex-wrap gap-x-5 gap-y-2 py-1">
          {stats.map(({ label, value, icon: Icon, accent }) => (
            <div key={label} className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-lg",
                  accent
                    ? "bg-primary/10 text-primary"
                    : "bg-muted/70 text-muted-foreground",
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
              </span>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-sm font-semibold tabular-nums">
                {value.toLocaleString("de-AT")}
              </dd>
            </div>
          ))}
        </dl>
        {issues.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11 gap-2 rounded-xl px-2 text-xs"
            aria-label="Importhinweise"
            aria-expanded={expanded}
            aria-controls={hintsId}
            onClick={() => setExpanded((previous) => !previous)}
          >
            <TriangleAlert
              className="size-3.5 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
            <span>
              <span className="font-semibold tabular-nums">
                {issues.length.toLocaleString("de-AT")}
              </span>{" "}
              {issues.length === 1 ? "Hinweis" : "Hinweise"}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none",
                expanded && "rotate-180",
              )}
            />
          </Button>
        )}
      </div>
      {issues.length > 0 && (
        <ul
          id={hintsId}
          aria-label="Importhinweise"
          hidden={!expanded}
          className="divide-y divide-border/60 border-t border-border/60"
        >
          {issues.map((issue, index) => {
            const detail = issueDetails(issue);
            const Icon = /\.(?:png|jpe?g|webp)$/i.test(detail.file ?? "")
              ? FileImage
              : FileText;
            return (
              <li
                key={`${index}:${issue}`}
                className="flex items-start gap-3 px-4 py-3 sm:px-5"
              >
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <p className="text-sm font-medium break-words [overflow-wrap:anywhere]">
                      {detail.message}
                    </p>
                    {detail.source && (
                      <span className="rounded-md bg-muted/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {detail.source}
                      </span>
                    )}
                    {detail.line && (
                      <span className="rounded-md border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        Zeile {detail.line}
                      </span>
                    )}
                  </div>
                  {detail.file && (
                    <p className="text-xs leading-relaxed break-all text-muted-foreground">
                      {detail.file}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
