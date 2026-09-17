"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

export function FixedCostChoice({
  checked,
  onChange,
  disabled = false,
  eligible = true,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  eligible?: boolean;
}) {
  const helpId = useId();
  const help = !eligible
    ? "Nur für Ausgaben, nicht für Eingänge oder Umbuchungen."
    : checked
      ? "Diese Buchung zählt als Fixkosten. Es wird kein neuer Planbetrag angelegt."
      : "Ohne Markierung bleibt es eine normale Buchung.";
  return (
    <label title={help} className={cn(
      "flex min-h-10 min-w-0 items-center gap-2.5 py-1 text-muted-foreground transition-colors",
      disabled || !eligible ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:text-foreground",
    )}>
      <input
        type="checkbox"
        className="size-3.5 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        aria-label="Als Fixkosten markieren"
        aria-describedby={helpId}
        checked={checked && eligible}
        disabled={disabled || !eligible}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={cn("text-xs font-medium", checked && eligible && "text-foreground")}>
        Als Fixkosten markieren
      </span>
      <span className="ml-auto text-right text-[11px]">
        {!eligible ? "Nur Ausgaben" : checked ? "Kein neuer Planbetrag" : "Optional"}
      </span>
      <span id={helpId} className="sr-only">{help}</span>
    </label>
  );
}
