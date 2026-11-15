"use client";

import { useId, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { Check, ChevronDown, ChevronRight, X } from "lucide-react";
import { exitTween, useMotionMode } from "@/components/ui/premium-dialog/motion";
import { modelTitle, taskLabel } from "@/lib/ai/models";
import { callLabel } from "@/lib/assistant/orchestrator-info";
import type { AssistantModelUse, AssistantToolCall } from "@/lib/types";
import { cn } from "@/lib/utils";

const ease = [0.32, 0.72, 0, 1] as const;
const focusRing = "rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const fallbackTitle = (use: AssistantModelUse) => `DeepSeek nicht verfügbar${use.reason ? ` (${use.reason})` : ""} – das lokale Modell hat geantwortet`;

/** One tool call in a line: outcome, name and a short input; it folds out to the full input and the shortened result. */
function ToolRow({ call }: { call: AssistantToolCall }) {
  const [open, setOpen] = useState(false);
  const detail = useId();
  const mode = useMotionMode();
  const expandable = !!call.args || !!call.result;
  const head = <>
    {call.ok ? <Check aria-hidden="true" className="size-3 shrink-0 text-success" /> : <X aria-hidden="true" className="size-3 shrink-0 text-destructive" />}
    <span className="shrink-0 text-foreground/90">{callLabel(call.tool)}</span>
    {" "}<span className="sr-only">{call.ok ? "(erfolgreich)" : "(Fehler)"}</span>
    {call.args && <>{" "}<span className="min-w-0 truncate text-muted-foreground">· {call.args}</span></>}
  </>;
  return <li data-call={call.tool}>
    {expandable
      ? <button type="button" aria-expanded={open} aria-controls={open ? detail : undefined} onClick={() => setOpen((value) => !value)}
        className={cn("flex min-h-6 w-full min-w-0 items-center gap-1.5 rounded-sm text-left transition-colors hover:text-foreground", focusRing)}>
        {head}
        <ChevronRight aria-hidden="true" className={cn("ml-auto size-3 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none", open && "rotate-90")} />
      </button>
      : <div className="flex min-h-6 min-w-0 items-center gap-1.5">{head}</div>}
    <AnimatePresence initial={false}>
      {open && <m.div id={detail} key="detail" className="overflow-hidden"
        initial={mode === "full" ? { height: 0, opacity: 0 } : { opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
        exit={mode === "full" ? { height: 0, opacity: 0, transition: exitTween } : { opacity: 0, transition: { duration: mode === "none" ? 0 : 0.12 } }}
        transition={{ duration: mode === "none" ? 0 : 0.2, ease }}>
        <dl className="mb-1.5 ml-[1.125rem] mt-0.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 rounded-md bg-muted/40 px-2 py-1.5">
          {call.args && <><dt className="text-muted-foreground">Eingabe</dt><dd className="break-words">{call.args}</dd></>}
          {call.result && <><dt className="text-muted-foreground">Ergebnis</dt><dd className="line-clamp-4 break-words text-muted-foreground">{call.result}</dd></>}
        </dl>
      </m.div>}
    </AnimatePresence>
  </li>;
}

/** The system prompt, two lines by default; the whole text only on request. */
function PromptPreview({ prompt }: { prompt: string }) {
  const [full, setFull] = useState(false);
  return <div>
    <p className="text-muted-foreground">Prompt</p>
    {full
      ? <pre tabIndex={0} className={cn("mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-2xs text-muted-foreground", focusRing)}>{prompt}</pre>
      : <p className="mt-0.5 line-clamp-2 break-words font-mono text-muted-foreground/90">{prompt}</p>}
    <button type="button" aria-expanded={full} onClick={() => setFull((value) => !value)}
      className={cn("mt-0.5 min-h-6 text-muted-foreground underline decoration-border underline-offset-2 transition-colors hover:text-foreground", focusRing)}>
      {full ? "Weniger" : "Ganzen Prompt zeigen"}
    </button>
  </div>;
}

/**
 * How an answer came about, behind a small closed "Details" link: the models, the tool calls as compact lines and the system
 * prompt, shortened. Nothing of it shows in the conversation until it is opened.
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
  return <>
    <button type="button" aria-expanded={open} aria-controls={open ? panel : undefined} onClick={() => setOpen((value) => !value)}
      data-model={writer?.model} title={writer ? writer.fallback ? fallbackTitle(writer) : modelTitle(writer) : undefined}
      className={cn("inline-flex min-h-7 items-center gap-1 text-2xs text-muted-foreground/80 transition-colors hover:text-foreground", focusRing)}>
      Details
      {writer?.fallback && <>{" "}<span className="sr-only">(lokales Modell)</span><span aria-hidden="true" className="size-1.5 rounded-full bg-warning" /></>}
      <ChevronDown aria-hidden="true" className={cn("size-3 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")} />
    </button>
    <AnimatePresence initial={false}>
      {open && <m.div id={panel} key="details" role="region" aria-label="Details zur Antwort" className="order-last basis-full overflow-hidden" data-answer-details=""
        initial={mode === "full" ? { height: 0, opacity: 0 } : { opacity: 0 }} animate={{ height: "auto", opacity: 1 }}
        exit={mode === "full" ? { height: 0, opacity: 0, transition: exitTween } : { opacity: 0, transition: { duration: mode === "none" ? 0 : 0.12 } }}
        transition={{ duration: mode === "none" ? 0 : 0.22, ease }}>
        <div className="mb-0.5 mt-1 space-y-1.5 border-l-2 border-border/70 pl-3 text-2xs leading-relaxed">
          <p className="break-words">
            <span className="text-muted-foreground">Modelle: </span>
            {models?.length ? models.map((use, index) => <span key={`${use.task}-${index}`} title={use.fallback ? fallbackTitle(use) : undefined}>
              {index > 0 && <span aria-hidden="true" className="text-muted-foreground"> · </span>}
              <span className={cn(use.provider === "local" && "text-warning")}>{modelTitle(use)}{use.fallback && " (Rückfall)"}</span>
              <span className="text-muted-foreground"> ({taskLabel[use.task]})</span>
            </span>) : <span className="text-muted-foreground">{source === "KI" ? "nicht gespeichert" : "keins – feste Regel der App"}</span>}
          </p>
          {tools.length > 0 && <div>
            <p className="text-muted-foreground">Werkzeuge</p>
            <ul aria-label="Werkzeuge" className="mt-0.5">{tools.map((call, index) => <ToolRow key={`${call.tool}-${index}`} call={call} />)}</ul>
          </div>}
          {prompt && <PromptPreview prompt={prompt} />}
        </div>
      </m.div>}
    </AnimatePresence>
  </>;
}
