"use client";

import { Select, SelectContent, SelectItem, SelectItemText, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** Imported and in the budget, imported but held for review, or not imported yet. */
export type PayrollMonthState = "imported" | "review" | "missing";

const dot: Record<PayrollMonthState, string> = {
  imported: "bg-success",
  review: "bg-warning ring-2 ring-warning/30",
  missing: "bg-muted-foreground/35",
};
const spoken: Record<PayrollMonthState, string> = {
  imported: "importiert",
  review: "zur Prüfung",
  missing: "noch nicht importiert",
};
const nameFormat = new Intl.DateTimeFormat("de-AT", { month: "long", timeZone: "UTC" });
export const payrollMonthName = (month: number) => nameFormat.format(new Date(Date.UTC(2026, month - 1, 15)));

/**
 * The twelve Abrechnungsmonate of a year, each with a small status dot (also in the closed select). Months without a
 * payslip are listed but cannot be chosen; screen readers hear the state the dot shows.
 */
export function PayrollMonthSelect({ id, value, states, onChange }: {
  id: string;
  value: number;
  states: Partial<Record<number, PayrollMonthState>>;
  onChange: (month: number) => void;
}) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
      <SelectTrigger id={id} className="w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => {
          const state = states[month] ?? "missing";
          return (
            <SelectItem key={month} value={String(month)} disabled={state === "missing"}
              // Named directly: the item text is labelled by default, and Chrome reads its hidden status as a separate block.
              aria-labelledby={undefined} aria-label={`${payrollMonthName(month)}, ${spoken[state]}`}>
              <SelectItemText>
                <span className="inline-flex items-center gap-2">
                  <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", dot[state])} />
                  {payrollMonthName(month)}
                  <span className="sr-only">, {spoken[state]}</span>
                </span>
              </SelectItemText>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
