"use client";

import { useId, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { AnimatePresence } from "motion/react";
import { Check, type LucideIcon } from "lucide-react";
import { Slot } from "radix-ui";
import { Input } from "@/components/ui/input";
import { number } from "@/lib/format";
import { parseMoneyText } from "@/lib/money-parse";
import { cn } from "@/lib/utils";
import { MotionBox, itemVariants } from "./motion";
import { usePremiumDialog } from "./premium-dialog";

type FieldProps = {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  /** For controls that are groups (radio cards, switches): labelled instead of `<label for>`. */
  group?: boolean;
  className?: string;
  /** The control; receives id, aria-invalid and aria-describedby. */
  children: ReactElement;
};

/** Label, hint and error wired to one control, consistent in every dialog. */
export function Field({ label, hint, error, optional = false, group = false, className, children }: FieldProps) {
  const { mode } = usePremiumDialog();
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  const labelClass = "flex items-baseline justify-between gap-2 text-sm font-medium";
  const caption = <>{label}{optional && <span className="text-xs font-normal text-muted-foreground">{" "}optional</span>}</>;
  return (
    <MotionBox mode={mode} variants={itemVariants(mode)} className={cn("space-y-2", className)} data-field>
      {group ? <p id={`${id}-label`} className={labelClass}>{caption}</p> : <label htmlFor={id} className={labelClass}>{caption}</label>}
      <Slot.Root {...(group ? { "aria-labelledby": `${id}-label` } : { id })} aria-invalid={error ? true : undefined} aria-describedby={describedBy}>
        {children}
      </Slot.Root>
      {hint && <p id={hintId} className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      {mode === "none"
        ? error && <p id={errorId} role="alert" className="text-xs font-medium text-destructive">{error}</p>
        : <AnimatePresence initial={false}>
            {error && <MotionBox key="error" as="p" mode={mode} id={errorId} role="alert" className="text-xs font-medium text-destructive"
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>{error}</MotionBox>}
          </AnimatePresence>}
    </MotionBox>
  );
}

/** Parses what MoneyField shows; null for empty or unclear input. */
export const moneyValue = (text: string) => (text.trim() ? parseMoneyText(text) : null);
export const moneyText = (value: number | null | undefined) => (value === null || value === undefined ? "" : number(value));

/** Euro amount as typed in Austria ("1.250,50"), tidied on blur; the value stays text until saving. */
export function MoneyField({ value, onValueChange, className, onBlur, ...props }: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type"> & {
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <div className="relative">
      <Input inputMode="decimal" autoComplete="off" placeholder="0,00" value={value} {...props}
        className={cn("pr-9 text-right tabular-nums", className)}
        onChange={(event) => onValueChange(event.target.value)}
        onBlur={(event) => {
          const parsed = moneyValue(event.target.value);
          if (parsed !== null) onValueChange(number(parsed));
          onBlur?.(event);
        }} />
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">€</span>
    </div>
  );
}

export type ChoiceOption<T extends string> = {
  value: T;
  label: string;
  description?: ReactNode;
  meta?: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
};

/** Single choice as cards (radio group with arrow keys). */
export function ChoiceCards<T extends string>({ value, onValueChange, options, columns = 2, className, ...aria }: {
  value: T | null;
  onValueChange: (value: T) => void;
  options: readonly ChoiceOption<T>[];
  columns?: 2 | 3;
  className?: string;
  id?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.filter((option) => !option.disabled);
  const focusIndex = Math.max(0, options.findIndex((option) => option.value === value));
  function move(event: KeyboardEvent, from: number) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (!step || !enabled.length) return;
    event.preventDefault();
    let next = from;
    do next = (next + step + options.length) % options.length; while (options[next].disabled);
    onValueChange(options[next].value);
    buttons.current[next]?.focus();
  }
  return (
    <div role="radiogroup" {...aria} className={cn("grid gap-2", columns === 3 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2", className)}>
      {options.map((option, index) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button key={option.value} ref={(node) => { buttons.current[index] = node; }} type="button" role="radio" aria-checked={selected}
            disabled={option.disabled} tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => onValueChange(option.value)} onKeyDown={(event) => move(event, index)}
            className={cn(
              "group relative flex min-h-16 min-w-0 flex-col items-start gap-1 rounded-2xl border p-3.5 text-left transition-[border-color,background-color,box-shadow,scale] duration-150 ease-soft",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:scale-[0.98] motion-reduce:active:scale-100 disabled:opacity-50",
              selected ? "border-primary/70 bg-accent-muted shadow-[0_0_0_1px_var(--primary)]" : "border-border/80 bg-background/40 hover:border-border hover:bg-accent/50",
            )}>
            <span className={cn("absolute top-3 right-3 flex size-5 items-center justify-center rounded-full border transition-[background-color,border-color,scale] duration-150",
              selected ? "scale-100 border-primary bg-primary text-primary-foreground" : "scale-90 border-border bg-card")}>
              {selected && <Check aria-hidden="true" className="size-3" />}
            </span>
            {Icon && <Icon aria-hidden="true" className={cn("mb-1 size-4", selected ? "text-primary" : "text-muted-foreground")} />}
            <span className="pr-6 text-sm font-semibold">{option.label}</span>
            {option.description && <span className="text-xs leading-snug text-muted-foreground">{option.description}</span>}
            {option.meta && <span className="mt-auto pt-1 text-xs font-medium tabular-nums text-foreground/80">{option.meta}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** On/off setting with a description; a switch, not a checkbox look-alike. */
export function ToggleRow({ checked, onCheckedChange, label, description, disabled, className }: {
  checked: boolean; onCheckedChange: (checked: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean; className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex items-center justify-between gap-4 rounded-2xl border border-border/70 bg-background/40 px-4 py-3", className)}>
      <span className="min-w-0">
        <span id={`${id}-label`} className="block text-sm font-medium">{label}</span>
        {description && <span id={`${id}-description`} className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{description}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} aria-labelledby={`${id}-label`} aria-describedby={description ? `${id}-description` : undefined}
        disabled={disabled} onClick={() => onCheckedChange(!checked)}
        className={cn("relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50 pointer-coarse:h-8 pointer-coarse:w-14",
          checked ? "bg-primary" : "bg-muted-foreground/30")}>
        <span aria-hidden="true" className={cn("block size-5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-soft pointer-coarse:size-6",
          checked ? "translate-x-6 pointer-coarse:translate-x-7" : "translate-x-1")} />
      </button>
    </div>
  );
}

/** Loading placeholder inside a dialog body. */
export function DialogSkeleton({ rows = 3, label = "Wird geladen …" }: { rows?: number; label?: string }) {
  return (
    <div role="status" className="space-y-4 py-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="space-y-2">
          <div className="h-3 w-24 rounded bg-muted motion-safe:animate-pulse" />
          <div className="h-10 rounded-lg bg-muted/70 motion-safe:animate-pulse" />
        </div>
      ))}
    </div>
  );
}

/** Empty list inside a dialog: says what is missing and what to do next. */
export function DialogEmpty({ icon: Icon, title, children }: { icon?: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-surface-sunken/60 px-5 py-8 text-center">
      {Icon && <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-2xl bg-card text-muted-foreground shadow-xs"><Icon className="size-5" /></span>}
      <p className="text-sm font-semibold">{title}</p>
      {children && <div className="max-w-sm text-xs leading-relaxed text-muted-foreground">{children}</div>}
    </div>
  );
}

/** Keeps the original text while the user types and parses it only on demand. */
export function useMoneyState(initial: number | null | undefined) {
  return useState(() => moneyText(initial));
}
