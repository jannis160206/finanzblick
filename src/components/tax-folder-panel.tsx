"use client";

import { useMemo } from "react";
import { ChevronDown, FolderOpen } from "lucide-react";
import { TaxFolderDownload } from "@/components/assistant-cards";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { currency } from "@/lib/format";
import { kzLabel, taxFolder } from "@/lib/tax-folder";

// Steuer-Mappe: possibly deductible bookings of the year, grouped by L1 Kennzahl, with CSV/print export.
export function TaxFolderPanel({ year }: { year: number }) {
  const { state } = useFinance();
  const folder = useMemo(() => taxFolder(state, year), [state, year]);
  return (
    <section aria-labelledby="tax-folder-heading" className="panel min-w-0">
      <details className="min-w-0">
        <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl px-5 py-4 focus-visible:outline-2 focus-visible:outline-ring sm:px-6 [&::-webkit-details-marker]:hidden">
          <h2 id="tax-folder-heading" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <FolderOpen className="size-4 text-primary" aria-hidden="true" />
            Steuer-Mappe {year}
          </h2>
          <FinancialData as="span" className="ml-auto text-sm text-muted-foreground tabular-nums">
            {folder.count > 0 ? (
              <>
                {folder.count} {folder.count === 1 ? "Buchung" : "Buchungen"} ·{" "}
                <span className="font-semibold text-foreground">{currency(folder.total)}</span>
              </>
            ) : (
              "Keine Belege"
            )}
          </FinancialData>
          <ChevronDown
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground [details[open]>summary>&]:rotate-180"
          />
        </summary>
        <div className="border-t px-5 py-4 sm:px-6">
          <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
            Mögliche absetzbare Ausgaben aus deinen Umsätzen.
          </p>
          {folder.groups.length ? (
            <FinancialData as="ul" className="mt-3 divide-y divide-border/60 text-sm">
              {folder.groups.map((group) => (
                <li key={group.id} className="flex items-start justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">{kzLabel(group)} · {group.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {group.section} · {group.count} {group.count === 1 ? "Beleg" : "Belege"}
                      {group.missing > 0 ? ` · ${group.missing} mit Beleg-Hinweis` : ""}
                    </span>
                    <span className="block text-xs text-muted-foreground">{group.hint}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">{currency(group.total)}</span>
                </li>
              ))}
            </FinancialData>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Für {year} nichts gefunden.</p>
          )}
          {folder.count > 0 && <TaxFolderDownload state={state} year={year} />}
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{folder.note}</p>
        </div>
      </details>
    </section>
  );
}
