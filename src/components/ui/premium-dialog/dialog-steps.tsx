"use client";

import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, DialogFooterButtonContext } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog-base";
import { useCompactLayout } from "@/components/ui/use-compact-layout";
import { cn } from "@/lib/utils";
import { MotionBox, stepVariants } from "./motion";
import { usePremiumDialog } from "./premium-dialog";

export type DialogStepProps = {
  id: string;
  title: string;
  /** Returns false to stay on the step; the step shows its own field errors. */
  validate?: () => boolean;
  children: ReactNode;
};

/** One step of a DialogSteps form; only a marker, DialogSteps renders it. */
export function DialogStep(props: DialogStepProps) {
  return <>{props.children}</>;
}

type DialogStepsProps = {
  children: ReactNode;
  /** auto: steps when the form would not fit or on phones; always/never force a layout. */
  mode?: "auto" | "always" | "never";
  onComplete: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  /** Editing an existing entry: every step can be opened and saving is possible at any time. */
  editing?: boolean;
  disabled?: boolean;
  /** Disables only the final save (not "Weiter"), e.g. until a calculation basis is complete. */
  submitDisabled?: boolean;
  /** General message above the buttons, e.g. a storage error. */
  message?: ReactNode;
  initialStep?: string;
  onStepChange?: (id: string) => void;
  className?: string;
};

const FOCUSABLE = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="radio"][aria-checked="true"], [role="switch"], button[data-step-focus]';

function focusInside(container: HTMLElement | null, selector: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: false });
  }));
}

export function DialogSteps({
  children, mode = "auto", onComplete, submitLabel = "Speichern", cancelLabel = "Abbrechen", editing = false, disabled = false,
  submitDisabled = false, message, initialStep, onStepChange, className,
}: DialogStepsProps) {
  const steps = Children.toArray(children).filter((child): child is ReactElement<DialogStepProps> => isValidElement(child) && child.type === DialogStep)
    .map((child) => child.props);
  const { mode: motion, setStepped } = usePremiumDialog();
  const compact = useCompactLayout();
  const [layout, setLayout] = useState<"steps" | "single">(() =>
    mode === "always" || (mode === "auto" && compact && steps.length > 1) ? "steps" : "single");
  const decided = useRef(mode !== "auto");
  const [index, setIndex] = useState(() => Math.max(0, steps.findIndex((step) => step.id === initialStep)));
  const [direction, setDirection] = useState(1);
  const [reached, setReached] = useState(() => editing ? steps.length - 1 : Math.max(0, steps.findIndex((step) => step.id === initialStep)));
  const body = useRef<HTMLDivElement>(null);
  const liveId = useId();
  const current = steps[Math.min(index, steps.length - 1)];
  const last = index >= steps.length - 1;

  // Decide once per opening, before paint: a form that does not fit becomes a step-by-step dialog.
  useLayoutEffect(() => {
    if (decided.current) return;
    decided.current = true;
    const node = body.current;
    if (steps.length > 1 && (compact || (node && node.scrollHeight - node.clientHeight > 8))) setLayout("steps");
  }, [compact, steps.length]);

  useEffect(() => {
    setStepped(layout === "steps");
    return () => setStepped(false);
  }, [layout, setStepped]);

  const currentId = current?.id;
  useEffect(() => { if (currentId) onStepChange?.(currentId); }, [currentId, onStepChange]);

  function invalid(stepIndex: number) {
    const step = steps[stepIndex];
    return step?.validate ? !step.validate() : false;
  }

  function showError(container: HTMLElement | null) {
    focusInside(container, '[aria-invalid="true"]');
  }

  function goTo(target: number) {
    if (target === index || target < 0 || target >= steps.length) return;
    if (target > index && !editing) {
      for (let step = index; step < target; step++) if (invalid(step)) { if (step !== index) { setDirection(1); setIndex(step); } showError(body.current); return; }
    }
    setDirection(target > index ? 1 : -1);
    setIndex(target);
    setReached((value) => Math.max(value, target));
    focusInside(body.current, FOCUSABLE);
  }

  function completeAll() {
    for (let step = 0; step < steps.length; step++) {
      if (!invalid(step)) continue;
      if (layout === "steps") {
        if (step !== index) { setDirection(step > index ? 1 : -1); setIndex(step); }
        showError(body.current);
      } else {
        const section = body.current?.querySelector<HTMLElement>(`[data-step-section="${steps[step].id}"]`);
        section?.scrollIntoView?.({ block: "start", behavior: "smooth" });
        showError(section ?? body.current);
      }
      return;
    }
    onComplete();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const final = layout === "single" || editing || last;
    if (final && submitDisabled) return;
    if (final) completeAll();
    else goTo(index + 1);
  }

  const stepped = layout === "steps";
  return (
    <form noValidate onSubmit={submit} className={cn("flex min-h-0 flex-1 flex-col", className)} data-layout={layout}>
      {stepped && <StepIndicator steps={steps} index={index} reached={reached} editing={editing} onSelect={goTo} />}
      <div ref={body} data-slot="dialog-body" className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-6 pb-6 sm:px-8">
        {stepped && current ? (
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <MotionBox key={current.id} mode={motion} custom={direction} variants={stepVariants(motion)} initial="enter" animate="center" exit="leave"
              role="group" aria-label={current.title} className="space-y-5 pt-1">
              {current.children}
            </MotionBox>
          </AnimatePresence>
        ) : (
          <div className="space-y-8 pt-1">
            {steps.map((step) => (
              <section key={step.id} data-step-section={step.id} aria-labelledby={`${liveId}-${step.id}`} className="space-y-5">
                {steps.length > 1 && <h3 id={`${liveId}-${step.id}`} className="text-sm font-semibold text-muted-foreground">{step.title}</h3>}
                {step.children}
              </section>
            ))}
          </div>
        )}
      </div>
      {message && <div className="shrink-0 px-6 pb-3 sm:px-8">{message}</div>}
      <StepFooter
        stepped={stepped} index={index} last={last} editing={editing} disabled={disabled} submitDisabled={submitDisabled}
        submitLabel={submitLabel} cancelLabel={cancelLabel} onBack={() => goTo(index - 1)} onNext={() => goTo(index + 1)} />
      {stepped && current && <p className="sr-only" aria-live="polite">Schritt {index + 1} von {steps.length}: {current.title}</p>}
    </form>
  );
}

function StepFooter({ stepped, index, last, editing, disabled, submitDisabled, submitLabel, cancelLabel, onBack, onNext }: {
  stepped: boolean; index: number; last: boolean; editing: boolean; disabled: boolean; submitDisabled: boolean; submitLabel: string; cancelLabel: string;
  onBack: () => void; onNext: () => void;
}) {
  const { presentation } = usePremiumDialog();
  const compact = useCompactLayout();
  const primary = !stepped || editing || last ? submitLabel : "Weiter";
  return (
    <div data-slot="dialog-footer" className={cn("flex shrink-0 items-center gap-2 border-t border-border/60 bg-muted/20 px-6 py-4 sm:px-8",
      presentation === "sheet" && "pb-[calc(1rem+var(--safe-bottom,0px))]")}>
      <DialogFooterButtonContext.Provider value={false}>
        {stepped && index > 0 ? (
          <Button type="button" variant="ghost" size={compact ? "icon" : "default"} aria-label="Zurück" onClick={onBack}>
            <ChevronLeft aria-hidden="true" />{!compact && "Zurück"}
          </Button>
        ) : (
          <DialogClose asChild><Button type="button" variant="ghost">{cancelLabel}</Button></DialogClose>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          {stepped && editing && !last && (
            <Button type="button" variant="outline" onClick={onNext}>Weiter<ChevronRight aria-hidden="true" /></Button>
          )}
          <Button type="submit" disabled={disabled || (primary !== "Weiter" && submitDisabled)} className="min-w-28">
            {primary}{primary === "Weiter" && <ChevronRight aria-hidden="true" />}
          </Button>
        </div>
      </DialogFooterButtonContext.Provider>
    </div>
  );
}

function StepIndicator({ steps, index, reached, editing, onSelect }: {
  steps: DialogStepProps[]; index: number; reached: number; editing: boolean; onSelect: (index: number) => void;
}) {
  const { mode } = usePremiumDialog();
  return (
    <nav aria-label="Schritte" className="shrink-0 px-6 pb-4 sm:px-8 md:pb-5">
      <p className="mb-2 flex items-baseline justify-between gap-3 text-xs md:hidden">
        <span className="truncate font-semibold">{steps[index]?.title}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">Schritt {index + 1} von {steps.length}</span>
      </p>
      <ol className="flex gap-1.5">
        {steps.map((step, position) => {
          const done = position < index;
          const reachable = editing || position <= reached;
          return (
            <li key={step.id} className="min-w-0 flex-1">
              <button type="button" disabled={!reachable} onClick={() => onSelect(position)}
                aria-current={position === index ? "step" : undefined}
                aria-label={`${position + 1}. ${step.title}${done ? " (erledigt)" : ""}`}
                className="group block w-full rounded-md py-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default pointer-coarse:py-3">
                <span className="block h-1.5 overflow-hidden rounded-full bg-muted">
                  <span className={cn("block h-full origin-left rounded-full bg-primary", mode === "full" && "transition-transform duration-300 ease-soft")}
                    style={{ transform: `scaleX(${position <= index ? 1 : 0})` }} />
                </span>
                <span className={cn("mt-1.5 hidden items-center gap-1 truncate text-2xs md:flex",
                  position === index ? "font-medium text-foreground" : reachable ? "text-muted-foreground group-hover:text-foreground" : "text-muted-foreground/60")}>
                  {done && <Check aria-hidden="true" className="size-3 shrink-0 text-primary" />}
                  <span className="truncate">{step.title}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
