"use client";

import { type ComponentPropsWithoutRef, type ReactNode, useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "motion/react";
import { ArrowUp, Check, Copy, RefreshCw, Sparkles, Square, ThumbsDown, ThumbsUp } from "lucide-react";
import { dialogSpring, exitTween, useMotionMode } from "@/components/ui/premium-dialog/motion";
import { cn } from "@/lib/utils";

/**
 * Three dots in a soft wave: each one lifts, grows and brightens in turn, like a breath moving through the row.
 * Reduced motion keeps only a slow fade; tests render them still.
 */
export function ThinkingDots({ className }: { className?: string }) {
  const mode = useMotionMode();
  return <span className={cn("inline-flex items-center gap-[3px]", className)} aria-hidden="true">
    {[0, 1, 2].map((dot) => mode === "none"
      ? <span key={dot} className="size-1.5 rounded-full bg-primary" />
      : <m.span key={dot} className="size-1.5 rounded-full bg-primary"
        animate={mode === "full" ? { y: [0, -4, 0], scale: [0.78, 1.18, 0.78], opacity: [0.35, 1, 0.35] } : { opacity: [0.35, 1, 0.35] }}
        transition={{ duration: mode === "full" ? 1.05 : 1.8, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut", delay: dot * 0.15 }} />)}
  </span>;
}

/** What the assistant is doing right now; each new step slides in sharp from a soft blur while the old one leaves. */
export function StatusLine({ text, className }: { text: string; className?: string }) {
  const mode = useMotionMode();
  return <span className={cn("inline-flex min-w-0 items-center gap-2.5 text-[0.8125rem] text-muted-foreground", className)} data-status-line="">
    <ThinkingDots />
    <span className="grid min-w-0">
      {mode === "none" ? <span className="truncate">{text}</span>
        : <AnimatePresence mode="popLayout" initial={false}>
          <m.span key={text} className="col-start-1 row-start-1 truncate"
            initial={mode === "full" ? { opacity: 0, y: 6, filter: "blur(3px)" } : { opacity: 0 }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={mode === "full" ? { opacity: 0, y: -6, filter: "blur(3px)", transition: exitTween } : { opacity: 0, transition: exitTween }}
            transition={mode === "full" ? dialogSpring : { duration: 0.16 }}>{text}</m.span>
        </AnimatePresence>}
    </span>
  </span>;
}

/** Streamed text: every newly arrived word fades in from a slight blur (CSS, so long answers stay cheap). */
export function StreamingText({ text }: { text: string }) {
  return <span className="whitespace-pre-line">
    {text.split(/(\s+)/).map((part, index) => /^\s*$/.test(part) ? part
      // Words are only ever appended, so their position is their identity.
      : <span key={index} className="assistant-word">{part}</span>)}
  </span>;
}

/** A new message springs in (slight scale and slide); messages that were already there on open stay still. */
export function MessageEnter({ animate, mine, children, className, ...rest }: {
  animate: boolean; mine: boolean; children: ReactNode; className?: string;
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "className">) {
  const mode = useMotionMode();
  if (!animate || mode === "none") return <div className={className} {...rest}>{children}</div>;
  return <m.div className={className} {...(rest as object)} style={{ transformOrigin: mine ? "100% 100%" : "0% 100%" }}
    initial={mode === "full" ? { opacity: 0, y: 10, x: mine ? 10 : 0, scale: 0.97 } : { opacity: 0 }}
    animate={{ opacity: 1, y: 0, x: 0, scale: 1 }} transition={mode === "full" ? dialogSpring : { duration: 0.18 }}>{children}</m.div>;
}

/** Calm start: a greeting and a few finance questions to tap. */
export function ChatEmptyState({ prompts, disabled, onPick }: { prompts: string[]; disabled: boolean; onPick: (text: string) => void }) {
  const mode = useMotionMode();
  const item = (index: number) => mode === "full"
    ? { initial: { opacity: 0, y: 8, scale: 0.98 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: { ...dialogSpring, delay: 0.08 + index * 0.05 } }
    : mode === "reduced" ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2 } } : { initial: false as const };
  return <section className="flex flex-col items-center px-2 pt-6 pb-2 text-center" aria-labelledby="assistant-welcome">
    <m.span {...item(0)} className="flex size-12 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-card ring-1 ring-primary/15">
      <Sparkles aria-hidden="true" className="size-5" />
    </m.span>
    <m.h2 {...item(1)} id="assistant-welcome" className="mt-4 text-lg font-semibold tracking-tight text-balance">Wobei kann ich dir helfen?</m.h2>
    <m.p {...item(2)} className="mt-1.5 max-w-[46ch] text-sm leading-relaxed text-pretty text-muted-foreground">
      Frag mich zu deinen Ausgaben, Verträgen, Sparzielen oder deinem Budget. Ich rechne mit deinen echten Zahlen und ändere nur etwas, wenn du bestätigst.
    </m.p>
    <ul className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Vorschläge zum Start">
      {prompts.map((prompt, index) => <m.li key={prompt} {...item(3 + index)}>
        <button type="button" disabled={disabled} onClick={() => onPick(prompt)}
          className="min-h-10 rounded-full border border-border bg-card px-4 text-sm text-foreground/85 shadow-card transition-[background-color,border-color,color,transform] duration-150 hover:border-primary/50 hover:bg-primary/8 hover:text-foreground active:scale-[0.97] disabled:opacity-50 motion-reduce:active:scale-100">
          {prompt}
        </button>
      </m.li>)}
    </ul>
  </section>;
}

function ActionButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
    className="inline-flex min-h-8 min-w-8 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] duration-150 hover:bg-muted hover:text-foreground focus-visible:text-foreground active:scale-90 disabled:opacity-35 motion-reduce:active:scale-100">
    {children}
  </button>;
}

/** Quiet actions under an answer: copy, ask again, and the thumbs that teach the assistant. */
export function MessageActions({ text, onRegenerate, feedback, onFeedback, disabled, className }: {
  text: string; onRegenerate?: () => void; feedback?: "up" | "down"; onFeedback?: (value: "up" | "down") => void; disabled: boolean; className?: string;
}) {
  const [copied, setCopied] = useState<"ok" | "failed">();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setCopied("ok");
    } catch {
      setCopied("failed");
    }
    timer.current = setTimeout(() => setCopied(undefined), 1800);
  }
  return <div className={cn("flex items-center gap-0.5 pl-11", className)} role="group" aria-label="Aktionen zur Antwort">
    <ActionButton label="Antwort kopieren" onClick={() => void copy()}>
      {copied === "ok" ? <Check aria-hidden="true" className="size-3.5 text-primary" /> : <Copy aria-hidden="true" className="size-3.5" />}
    </ActionButton>
    <span role="status" className={cn("text-2xs transition-opacity duration-150", copied ? "opacity-100" : "opacity-0")}>
      {copied === "ok" ? "Kopiert" : copied === "failed" ? "Kopieren nicht möglich" : ""}
    </span>
    {onRegenerate && <ActionButton label="Neu generieren" onClick={onRegenerate} disabled={disabled}><RefreshCw aria-hidden="true" className="size-3.5" /></ActionButton>}
    {feedback ? <span className="inline-flex items-center gap-1.5 px-1.5 text-2xs text-muted-foreground">
      {feedback === "up" ? <ThumbsUp aria-hidden="true" className="size-3.5 text-primary" /> : <ThumbsDown aria-hidden="true" className="size-3.5" />}Danke für dein Feedback</span>
      : onFeedback && <>
        <ActionButton label="Hilfreich" onClick={() => onFeedback("up")} disabled={disabled}><ThumbsUp aria-hidden="true" className="size-3.5" /></ActionButton>
        <ActionButton label="Nicht hilfreich – ich lerne daraus" onClick={() => onFeedback("down")} disabled={disabled}><ThumbsDown aria-hidden="true" className="size-3.5" /></ActionButton>
      </>}
  </div>;
}

/** Send turns into Stop while an answer is on its way; the icon swaps with a short spring. */
export function ComposerButton({ busy, disabled, onStop }: { busy: boolean; disabled: boolean; onStop: () => void }) {
  const mode = useMotionMode();
  const motion = mode === "full" ? { initial: { opacity: 0, scale: 0.6, rotate: busy ? -90 : 90 }, animate: { opacity: 1, scale: 1, rotate: 0 }, transition: dialogSpring }
    : mode === "reduced" ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.12 } } : { initial: false as const };
  const base = "inline-flex size-10 shrink-0 items-center justify-center rounded-full transition-[background-color,color,transform] duration-150 active:scale-90 motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card";
  return busy
    ? <button type="button" onClick={onStop} aria-label="Antwort stoppen" title="Antwort stoppen" className={cn(base, "bg-foreground text-background hover:bg-foreground/85")}>
      <m.span key="stop" {...motion} className="inline-flex"><Square aria-hidden="true" className="size-3.5 fill-current" /></m.span>
    </button>
    : <button type="submit" disabled={disabled} aria-label="Senden" title="Senden (Enter)"
      className={cn(base, "bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground")}>
      <m.span key="send" {...motion} className="inline-flex"><ArrowUp aria-hidden="true" className="size-4" /></m.span>
    </button>;
}

/** The assistant's mark next to its messages. */
export function AssistantMark() {
  return <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/15" aria-hidden="true">
    <Sparkles className="size-4" />
  </span>;
}
