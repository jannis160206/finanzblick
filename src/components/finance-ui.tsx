"use client";

import { useId, useState, type ReactNode } from "react";
import {
  Bike,
  CircleHelp,
  Palmtree,
  PiggyBank,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { number } from "@/lib/format";
import { parseMoneyText } from "@/lib/money-parse";
import { type Pocket } from "@/lib/types";
import { FinancialData } from "@/components/financial-data";

export const pocketIcons: Record<Pocket, LucideIcon> = {
  Notgroschen: ShieldCheck,
  Urlaub: Palmtree,
  Sparkonto: PiggyBank,
  Motorrad: Bike,
};
export const pocketColors: Record<Pocket, string> = {
  Notgroschen: "var(--chart-1)",
  Urlaub: "var(--chart-2)",
  Sparkonto: "var(--chart-3)",
  Motorrad: "var(--chart-4)",
};
export function PageHeading({
  eyebrow,
  title,
  description,
  sensitiveDescription = false,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  sensitiveDescription?: boolean;
  children?: ReactNode;
}) {
  return (
    <div data-page-heading className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="eyebrow mb-2">{eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-[34px]">
          {title}
        </h1>
        {description && (sensitiveDescription
          ? <FinancialData as="p" className="mt-2 text-sm text-muted-foreground">{description}</FinancialData>
          : <p className="mt-2 text-sm text-muted-foreground">{description}</p>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
export function SectionHeading({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div>
        <h2 className="font-semibold tracking-tight">{title}</h2>
        {subtitle && (
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {children}
    </div>
  );
}
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-5 py-10 text-center">
      <CircleHelp className="size-7 text-muted-foreground" />
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {description}
      </p>
      {children}
    </div>
  );
}
export function MoneyInput({
  value,
  onCommit,
  label,
  nullable = false,
  min = 0,
  className,
}: {
  value: number | null;
  onCommit: (value: number | null) => void;
  label: string;
  nullable?: boolean;
  min?: number;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const hintId = useId();
  function commit() {
    if (document.documentElement.dataset.securityMode === "locked") return;
    if (draft === null) return;
    if (nullable && draft.trim() === "") {
      onCommit(null);
      setDraft(null);
      setError(null);
      return;
    }
    const parsed = parseMoneyText(draft);
    if (parsed === null) {
      setError("Ungültiger Betrag. Beispiel: 1.500,50");
      return;
    }
    if (parsed < min) {
      setError(`Mindestens ${number(min)} €`);
      return;
    }
    onCommit(parsed);
    setDraft(null);
    setError(null);
  }
  return (
    <>
    <Input
      aria-label={label}
      aria-invalid={error !== null}
      aria-describedby={[error ? errorId : null, nullable ? hintId : null].filter(Boolean).join(" ") || undefined}
      inputMode="decimal"
      className={cn(
        "editable h-8 min-w-24 text-right font-mono text-xs",
        className,
      )}
      value={draft ?? (value === null ? "" : number(value))}
      placeholder={nullable ? "Auto" : "0,00"}
      onChange={(event) => {
        setDraft(event.target.value);
        setError(null);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(null);
          setError(null);
        }
      }}
    />
    {nullable && <span id={hintId} className="sr-only">Leer lassen: wird automatisch berechnet.</span>}
    {error && (
      <p id={errorId} role="alert" className="mt-1 text-right text-2xs font-medium text-destructive">
        {error}
      </p>
    )}
    </>
  );
}
export function InputLegend() {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <span className="size-2 rounded-sm bg-amber-400" />
      Eingabe
      <span className="ml-2 size-2 rounded-sm bg-muted-foreground/40" />
      Berechnet
    </span>
  );
}
