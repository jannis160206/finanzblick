"use client";

import { useMemo } from "react";
import { FolderOpen } from "lucide-react";
import { TaxFolderDownload } from "@/components/assistant-cards";
import { useFinance } from "@/components/finance-provider";
import { currency } from "@/lib/format";
import { kzLabel, taxFolder } from "@/lib/tax-folder";

// Steuer-Mappe: possibly deductible bookings of the year, grouped by L1 Kennzahl, with CSV/print export.
export function TaxFolderPanel({ year }: { year: number }) {
  const { state } = useFinance();
  const folder = useMemo(() => taxFolder(state, year), [state, year]);
  return (
    <section aria-labelledby="tax-folder-heading" className="panel rounded-2xl p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="tax-folder-heading" className="flex items-center gap-2 font-semibold">
          <FolderOpen className="size-4 text-primary" aria-hidden="true" />
          Steuer-Mappe {year}
        </h2>
        {folder.count > 0 && (
          <p className="text-sm tabular-nums">
            {folder.count} {folder.count === 1 ? "Buchung" : "Buchungen"} · <span className="font-semibold">{currency(folder.total)}</span>
          </p>
        )}
      </div>
      <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
        Mögliche absetzbare Ausgaben für die Arbeitnehmerveranlagung, automatisch aus deinen Umsätzen gesammelt.
      </p>
      {folder.groups.length ? (
        <ul className="mt-3 divide-y divide-border/60 text-sm">
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
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">Für {year} habe ich keine typischerweise absetzbaren Buchungen gefunden.</p>
      )}
      {folder.count > 0 && <TaxFolderDownload state={state} year={year} />}
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{folder.note}</p>
    </section>
  );
}
