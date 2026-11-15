"use client";

import { useId, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { Check, ChevronDown, TriangleAlert } from "lucide-react";
import { exitTween, useMotionMode } from "@/components/ui/premium-dialog/motion";
import { modelLabel, modelTitle, taskLabel } from "@/lib/ai/models";
import { callLabel } from "@/lib/assistant/orchestrator-info";
import type { AssistantModelUse, AssistantToolCall } from "@/lib/types";
import { cn } from "@/lib/utils";

const fallbackTitle = (use: AssistantModelUse) => `DeepSeek nicht verfügbar${use.reason ? ` (${use.reason})` : ""} – das lokale Modell hat geantwortet`;

/**
 * Everything about how an answer came about, in one closed panel under it: the models (Flash plans, V4 Pro writes), the
 * system prompt of the answer and every tool call with its question and an excerpt of its result.
 */
export function AnswerDetails({ source, models, calls, prompt }: {
  source?: "KI" | "Regel"; models?: AssistantModelUse[]; calls?: AssistantToolCall[]; prompt?: string;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const mode = useMotionMode();
  const writer = models?.findLast((item) => item.task !== "suggest");
  const tools = calls ?? [];
  if (!source && !models?.length && !tools.length && !prompt) return null;
  const who = writer ? modelLabel(writer) : source === "KI" ? "KI" : "Regel";
  return <div className="contents" data-answer-details="">
    <button type="button" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((value) => !value)}
      className="inline-flex min-h-7 items-center gap-1 rounded-md text-2xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <ChevronDown aria-hidden="true" className={cn("size-3 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} />
      <span>Details</span>{" "}<span aria-hidden="true">·</span>{" "}
      <span data-model={writer?.model} title={writer?.fallback ? fallbackTitle(writer) : undefined}>{who}{writer?.fallback && " · Fallback"}</span>
      {tools.length > 0 && <>{" "}<span aria-hidden="true">·</span>{" "}<span>{tools.length === 1 ? "1 Werkzeug" : `${tools.length} Werkzeuge`}</span></>}
    </button>
    <AnimatePresence initial={false}>
      {open && <m.div id={panel} key="details" role="region" aria-label="Details zur Antwort"
        className="order-last basis-full space-y-3 rounded-xl border border-border/60 bg-muted/30 p-3 text-xs text-foreground"
        initial={mode === "full" ? { opacity: 0, y: -4, filter: "blur(2px)" } : { opacity: 0 }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={mode === "full" ? { opacity: 0, y: -4, filter: "blur(2px)", transition: exitTween } : { opacity: 0, transition: exitTween }}
        transition={{ duration: mode === "none" ? 0 : 0.18, ease: [0.32, 0.72, 0, 1] }}>
        <section aria-label="Modelle">
          <h4 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Modelle</h4>
          {models?.length ? <ul className="flex flex-wrap gap-1.5">
            {models.map((use, index) => <li key={`${use.task}-${index}`} title={use.fallback ? fallbackTitle(use) : undefined}
              className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs ring-1 ring-inset",
                use.provider === "local" ? "bg-warning-soft text-warning ring-warning/25" : use.model.includes("pro") ? "bg-primary/10 text-primary ring-primary/20" : "bg-background text-foreground ring-border/60")}>
              <span className="text-muted-foreground">{taskLabel[use.task]}:</span>{modelTitle(use)}{use.fallback && " · Fallback"}
            </li>)}
          </ul> : <p className="text-muted-foreground">{source === "KI" ? "Kein Modell gespeichert." : "Ohne KI – feste Regel der App."}</p>}
        </section>
        {prompt && <section aria-label="System-Prompt">
          <h4 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">System-Prompt</h4>
          <pre tabIndex={0} className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/70 p-2 font-mono text-2xs leading-relaxed text-muted-foreground ring-1 ring-inset ring-border/60 focus-visible:outline-2 focus-visible:outline-ring">{prompt}</pre>
        </section>}
        {tools.length > 0 && <section aria-label="Werkzeuge">
          <h4 className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Werkzeuge</h4>
          <ol className="space-y-1.5">
            {tools.map((call, index) => <li key={`${call.tool}-${index}`} className="rounded-lg bg-background/70 p-2 ring-1 ring-inset ring-border/60" data-call={call.tool}>
              <p className="flex items-center gap-1.5 font-medium">
                {call.ok ? <Check aria-hidden="true" className="size-3.5 text-success" /> : <TriangleAlert aria-hidden="true" className="size-3.5 text-destructive" />}
                <span>{callLabel(call.tool)}</span><span className="sr-only">{call.ok ? "(erfolgreich)" : "(Fehler)"}</span>
                <code className="ml-auto truncate font-mono text-2xs font-normal text-muted-foreground">{call.tool}</code>
              </p>
              {call.summary !== callLabel(call.tool) && <p className="mt-0.5 text-muted-foreground">{call.summary}</p>}
              {call.args && <p className="mt-1 break-words"><span className="text-muted-foreground">Eingabe: </span>{call.args}</p>}
              {call.result && <p className="mt-0.5 line-clamp-4 break-words"><span className="text-muted-foreground">Ergebnis: </span>{call.result}</p>}
            </li>)}
          </ol>
        </section>}
      </m.div>}
    </AnimatePresence>
  </div>;
}
