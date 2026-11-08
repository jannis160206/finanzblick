"use client";

import { Check } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { currency } from "@/lib/format";
import { cn } from "@/lib/utils";

// What to move to which pocket this month; checked off once the transfer is booked.
export function MonthlyFunding() {
  const { dashboard: d } = useFinance();
  const allocationBlocked = "allocationBlocked" in d.current && d.current.allocationBlocked === true;
  const rows = d.monthlyFunding.some((item) => item.id === "savings") ? d.monthlyFunding : [
    { id: "savings", name: "Sparkonto", pocket: "Sparkonto", amount: 0, transferred: 0, done: false },
    ...d.monthlyFunding,
  ];
  return (
    <section className="panel mt-5 min-w-0 overflow-hidden" aria-label="Pocket-Verteilung diesen Monat">
      <h2 className="px-4 pt-4 text-sm font-medium sm:px-5">Diesen Monat überweisen</h2>
      <div className="mt-3 divide-y divide-border/60 border-t border-border/60">
        {rows.map((item) => {
          const combined = "combined" in item && item.combined === true;
          const confirmedSavings = item.id === "savings" && !combined && item.done;
          const note = combined ? "Gemeinsame Überweisung"
            : item.id === "savings" ? (item.done ? "Überwiesen" : allocationBlocked ? "Empfehlung pausiert" : "Sparempfehlung") : undefined;
          return <div key={item.id} className={cn("grid min-h-14 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2.5 sm:px-5",
            confirmedSavings && "bg-primary/5")} data-funding-pot={item.pocket} data-funding-combined={combined || undefined}>
            <span className="min-w-0 break-words text-sm font-medium">{item.name}</span>
            <FinancialData as="span" className={cn("inline-flex items-center gap-2 whitespace-nowrap text-base font-semibold tabular-nums", confirmedSavings && "text-primary")}>
              {item.done && <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-label={`${item.name} überwiesen`} />}
              <span>{currency(confirmedSavings ? item.transferred : item.amount)}</span>
            </FinancialData>
            {note && <FinancialData as="span" className="col-start-2 justify-self-end text-2xs text-muted-foreground">{note}</FinancialData>}
          </div>;
        })}
      </div>
    </section>
  );
}
