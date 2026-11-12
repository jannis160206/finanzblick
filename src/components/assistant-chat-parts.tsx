"use client";

import { type ComponentPropsWithoutRef, type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { AnimatePresence, m } from "motion/react";
import { useTheme } from "next-themes";
import { BorderBeam } from "border-beam";
import { BotAvatar, type BotAvatarState, type BotAvatarType } from "bot-avatars";
import { MetalFx } from "metal-fx";
import { ThinkingOrb } from "thinking-orbs";
import { ArrowUp, Check, Copy, RefreshCw, Square, ThumbsDown, ThumbsUp } from "lucide-react";
import { dialogSpring, exitTween, useMotionMode } from "@/components/ui/premium-dialog/motion";
import { agentLabel, type AgentId } from "@/lib/assistant/orchestrator";
import { workStatus, type WorkActivity, type WorkStatus } from "@/lib/assistant/status";
import { cn } from "@/lib/utils";

/** Each agent has its own bot: the star is the orchestrator (and the general chat it falls back to), every specialist a shape of its own. */
export const agentAvatar: Record<AgentId, BotAvatarType> = {
  general: "star", transactions: "droid", contracts: "flower", budget: "clover", payroll: "mech",
};
export const agentName: Record<AgentId, string> = {
  general: "Orchestrator", transactions: "Umsätze", contracts: "Verträge", budget: "Budget & Prognose", payroll: "Gehalt & Steuern",
};

// BorderBeam and MetalFx only follow the system theme on their own; the app has its own switch.
function useAppTheme(): "dark" | "light" {
  return useTheme().resolvedTheme === "light" ? "light" : "dark";
}

/**
 * An agent's bot. `working` hops while it computes, `default` looks around, `sleeping` dozes until it is needed.
 * `still` keeps the pose without motion (older messages, reduced motion); without a label it is decoration.
 */
export function AgentAvatar({ agent, state = "default", size = 32, still, label, className }: {
  agent: AgentId; state?: BotAvatarState; size?: number; still?: boolean; label?: string; className?: string;
}) {
  const mode = useMotionMode();
  return <BotAvatar type={agentAvatar[agent]} state={state} size={size} paused={still || mode !== "full"} interactive={!still && mode === "full"}
    className={cn("shrink-0", className)} {...(label ? { "aria-label": label, title: label } : { "aria-hidden": true })} />;
}

/** What a running answer shows: the current step and the words streamed so far. */
export type LiveRun = { status?: WorkStatus; text?: string };
export type LiveRunStore = ReturnType<typeof createLiveRun>;

/**
 * Status and streamed words of the running answer live outside React state, so only the live row re-renders;
 * words arrive faster than the screen refreshes and are drawn at most once per frame.
 */
export function createLiveRun() {
  let value: LiveRun = {};
  let queued: string | undefined;
  let frame: { cancel: () => void } | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: LiveRun) => {
    value = next;
    for (const listener of listeners) listener();
  };
  const nextFrame = (run: () => void) => {
    if (typeof requestAnimationFrame === "function" && !document.hidden) {
      const id = requestAnimationFrame(run);
      return { cancel: () => cancelAnimationFrame(id) };
    }
    const id = setTimeout(run, 16);
    return { cancel: () => clearTimeout(id) };
  };
  return {
    get: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setStatus(status: WorkStatus | undefined | ((current?: WorkStatus) => WorkStatus | undefined)) {
      const next = typeof status === "function" ? status(value.status) : status;
      if (next !== value.status) publish({ ...value, status: next });
    },
    setText(text?: string) {
      queued = text;
      if (text === undefined) {
        frame?.cancel();
        frame = undefined;
        if (value.text !== undefined) publish({ ...value, text: undefined });
        return;
      }
      frame ??= nextFrame(() => {
        frame = undefined;
        if (queued !== value.text) publish({ ...value, text: queued });
      });
    },
    reset() {
      frame?.cancel();
      frame = undefined;
      queued = undefined;
      if (value.status || value.text !== undefined) publish({});
    },
  };
}

/** The thinking orb in the avatar's place while an answer is worked on; it moves like the work (searching, solving, composing …). */
export function OrbAvatar({ activity, className }: { activity: WorkActivity; className?: string }) {
  const mode = useMotionMode();
  const orb = <ThinkingOrb state={activity} size={32} paused={mode !== "full"} aria-hidden="true" />;
  return <span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center", className)} data-orb={activity}>
    {mode === "none" ? orb : <AnimatePresence mode="popLayout" initial={false}>
      <m.span key={activity} className="col-start-1 row-start-1 inline-flex"
        initial={mode === "full" ? { opacity: 0, scale: 0.6, filter: "blur(3px)" } : { opacity: 0 }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
        exit={mode === "full" ? { opacity: 0, scale: 0.6, filter: "blur(3px)", transition: exitTween } : { opacity: 0, transition: exitTween }}
        transition={mode === "full" ? dialogSpring : { duration: 0.16 }}>{orb}</m.span>
    </AnimatePresence>}
  </span>;
}

/** The step the assistant is on right now; each new step slides in sharp from a soft blur. */
export function StatusLine({ status, className }: { status: WorkStatus; className?: string }) {
  const mode = useMotionMode();
  const text = <span className="truncate">{status.text}</span>;
  return <span className={cn("grid min-w-0 text-[0.8125rem] text-muted-foreground", className)} data-status-line="" data-activity={status.activity}>
    {mode === "none" ? text : <AnimatePresence mode="popLayout" initial={false}>
      <m.span key={status.text} className="col-start-1 row-start-1 inline-flex min-w-0"
        initial={mode === "full" ? { opacity: 0, y: 6, filter: "blur(3px)" } : { opacity: 0 }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={mode === "full" ? { opacity: 0, y: -6, filter: "blur(3px)", transition: exitTween } : { opacity: 0, transition: exitTween }}
        transition={mode === "full" ? dialogSpring : { duration: 0.16 }}>{text}</m.span>
    </AnimatePresence>}
  </span>;
}

/**
 * The answer that is being worked on: the orb, the current step and the streamed words inside a traveling beam.
 * It subscribes to the live store itself, so streaming never re-renders the conversation above it.
 */
export function LiveAnswer({ live }: { live: LiveRunStore }) {
  const { status = workStatus.read, text } = useSyncExternalStore(live.subscribe, live.get, live.get);
  const row = useRef<HTMLDivElement>(null);
  // Keeps the growing answer in view; instant, so a smooth scroll per frame does not fight the next one.
  useLayoutEffect(() => { row.current?.scrollIntoView?.({ block: "end" }); }, [text, status.text]);
  return <div ref={row} data-live-answer="">
    <MessageEnter animate mine={false} className="flex items-start gap-3" aria-busy="true">
      <OrbAvatar activity={status.activity} />
      <GlowFrame kind="working" active className={text ? "min-w-0 max-w-[85%]" : "min-w-0"}>
        {text ? <div className="rounded-2xl border border-border/60 bg-card px-4 py-3 text-sm leading-relaxed shadow-card">
          <StatusLine status={status} className="mb-1.5" />
          <span className="sr-only">Assistent: </span><StreamingText text={text} />
          {status.agent && status.agent !== "general" && <span className="mt-1.5 block text-2xs text-muted-foreground">{agentLabel[status.agent]} · KI</span>}
        </div>
          : <div className="rounded-2xl border border-border/60 bg-card px-4 py-2.5 shadow-card"><StatusLine status={status} /></div>}
      </GlowFrame>
    </MessageEnter>
  </div>;
}

/** The orb that worked on an answer gives way to the bot of the agent who wrote it; afterwards only the bot stays. */
export function HandoffAvatar({ agent, activity, live }: { agent: AgentId; activity: WorkActivity; live: boolean }) {
  const mode = useMotionMode();
  const [orb, setOrb] = useState(true);
  if (mode !== "full") return <AgentAvatar agent={agent} still={!live} className="mt-0.5" />;
  return <span className="relative mt-0.5 grid size-8 shrink-0 place-items-center" data-handoff="">
    {orb && <m.span className="absolute inset-0 grid place-items-center" initial={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      animate={{ opacity: 0, scale: 0.4, filter: "blur(4px)" }} transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }} onAnimationComplete={() => setOrb(false)}>
      <ThinkingOrb state={activity} size={32} aria-hidden="true" />
    </m.span>}
    <m.span className="inline-flex" initial={{ opacity: 0, scale: 0.5, filter: "blur(4px)" }} animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
      transition={{ ...dialogSpring, delay: 0.08 }}>
      <AgentAvatar agent={agent} still={!live} />
    </m.span>
  </span>;
}

/**
 * A traveling beam around work in progress, or a slow breathing glow around a result that waits for confirmation.
 * Without motion (reduced motion, tests) only the content is shown.
 */
export function GlowFrame({ kind, active, className, children }: { kind: "working" | "pending"; active: boolean; className?: string; children: ReactNode }) {
  const mode = useMotionMode();
  const theme = useAppTheme();
  if (mode === "none") return <div className={className}>{children}</div>;
  return <BorderBeam size={kind === "working" ? "md" : "pulse-inner"} colorVariant="forest" theme={theme} active={active && mode === "full"}
    strength={kind === "working" ? 0.8 : 0.7} duration={kind === "working" ? 2.6 : 2.8} className={className}>{children}</BorderBeam>;
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

const team: AgentId[] = ["transactions", "contracts", "general", "budget", "payroll"];

/** Calm start: the orchestrator with its four specialists, who wake up when a matching question is pointed at. */
export function ChatEmptyState({ prompts, disabled, onPick }: {
  prompts: { text: string; agent: AgentId }[]; disabled: boolean; onPick: (text: string) => void;
}) {
  const mode = useMotionMode();
  const [pointed, setPointed] = useState<AgentId>();
  const item = (index: number) => mode === "full"
    ? { initial: { opacity: 0, y: 8, scale: 0.96 }, animate: { opacity: 1, y: 0, scale: 1 }, transition: { ...dialogSpring, delay: 0.06 + index * 0.05 } }
    : mode === "reduced" ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2 } } : { initial: false as const };
  return <section className="flex flex-col items-center px-2 pt-4 pb-2 text-center" aria-labelledby="assistant-welcome">
    <ul className="flex items-end justify-center gap-2.5 sm:gap-3.5" aria-label="Dein Assistenten-Team">
      {team.map((agent, index) => <m.li key={agent} {...item(index)} className="flex">
        <AgentAvatar agent={agent} size={agent === "general" ? 64 : 40} label={agentName[agent]}
          state={agent === "general" || pointed === agent ? "default" : "sleeping"} />
      </m.li>)}
    </ul>
    <m.h2 {...item(5)} id="assistant-welcome" className="mt-5 text-lg font-semibold tracking-tight text-balance">Wobei kann ich dir helfen?</m.h2>
    <m.p {...item(6)} className="mt-1.5 max-w-[46ch] text-sm leading-relaxed text-pretty text-muted-foreground">
      Ich gebe deine Frage an den passenden Spezialisten weiter – für Umsätze, Verträge, Budget oder Gehalt. Gerechnet wird mit deinen echten Zahlen, geändert nur, was du bestätigst.
    </m.p>
    <ul className="mt-5 flex flex-wrap justify-center gap-2" aria-label="Vorschläge zum Start">
      {prompts.map((prompt, index) => <m.li key={prompt.text} {...item(7 + index)}>
        <button type="button" disabled={disabled} onClick={() => onPick(prompt.text)}
          onPointerEnter={() => setPointed(prompt.agent)} onPointerLeave={() => setPointed(undefined)}
          onFocus={() => setPointed(prompt.agent)} onBlur={() => setPointed(undefined)}
          className="min-h-10 rounded-full border border-border bg-card px-4 text-sm text-foreground/85 shadow-card transition-[background-color,border-color,color,transform] duration-150 hover:border-primary/50 hover:bg-primary/8 hover:text-foreground active:scale-[0.97] disabled:opacity-50 motion-reduce:active:scale-100">
          {prompt.text}
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

/**
 * One button that sends, and stops while an answer is on its way. Whenever it can act, a liquid-metal ring runs around it:
 * a decorative layer on top, so the button itself never waits for (or depends on) the WebGL effect.
 */
export function ComposerButton({ busy, disabled, onStop }: { busy: boolean; disabled: boolean; onStop: () => void }) {
  const mode = useMotionMode();
  const theme = useAppTheme();
  const live = busy || !disabled;
  // The ring mounts the first time the button can act and then only fades and pauses: its shared WebGL context is
  // created once instead of on every keystroke.
  const [armed, setArmed] = useState(false);
  if (!armed && live && mode === "full") setArmed(true);
  // Prepared while the browser is idle, so the first keystroke does not wait for the WebGL setup.
  useEffect(() => {
    if (armed || mode !== "full") return;
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(() => setArmed(true), { timeout: 3000 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(() => setArmed(true), 1500);
    return () => clearTimeout(id);
  }, [armed, mode]);
  const icon = mode === "full" ? { initial: { opacity: 0, scale: 0.6, rotate: busy ? -90 : 90 }, animate: { opacity: 1, scale: 1, rotate: 0 }, transition: dialogSpring }
    : mode === "reduced" ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.12 } } : { initial: false as const };
  return <span className="relative isolate inline-flex shrink-0">
    {armed && mode === "full" && <span aria-hidden="true" data-metal-ring={live ? "on" : "off"}
      className={cn("pointer-events-none absolute -inset-[3px] transition-opacity duration-200", live ? "opacity-100" : "opacity-0")}>
      <MetalFx variant="circle" preset="silver" theme={theme} paused={!live}><span className="block size-[2.875rem] rounded-full" /></MetalFx>
    </span>}
    <button type={busy ? "button" : "submit"} onClick={busy ? onStop : undefined} disabled={!busy && disabled}
      aria-label={busy ? "Antwort stoppen" : "Senden"} title={busy ? "Antwort stoppen" : "Senden (Enter)"}
      className={cn("relative inline-flex size-10 items-center justify-center rounded-full transition-[background-color,color,transform] duration-150 active:scale-90 motion-reduce:active:scale-100",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
        busy ? "bg-foreground text-background hover:bg-foreground/85" : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground")}>
      <m.span key={busy ? "stop" : "send"} {...icon} className="inline-flex">
        {busy ? <Square aria-hidden="true" className="size-3.5 fill-current" /> : <ArrowUp aria-hidden="true" className="size-4" />}
      </m.span>
    </button>
  </span>;
}
