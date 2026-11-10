"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ReceiptText } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { PayslipImportPanel } from "@/components/payslip-import";
import { EnsurePayslipUpload, PayslipUploadButton, usePayslipImported } from "@/components/payslip-upload";
import { PageHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { PayrollCoverage, PayrollResults } from "@/components/payroll-results";
import { PayrollFocusCard } from "@/components/payroll-focus";
import { PayrollYearCard } from "@/components/payroll-year";
import { PayrollMonths, payrollMonthName } from "@/components/payroll-months";
import { TaxFolderPanel } from "@/components/tax-folder-panel";
import { payrollPresentation } from "@/components/payroll-presentation";
import { employerPayslips } from "@/lib/payroll-overview";
import { payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";

const scopeKey = (year: number, employer: string) => `${year}|${payrollEmployerKey(employer)}`;
const noPayslips: Payslip[] = [];

function PayrollWorkspace() {
  const { state } = useFinance();
  const [year, setYear] = useState<Payslip["year"]>(
    state.settings.asOf.startsWith("2027") ? 2027 : 2026,
  );
  const [selectedEmployer, setSelectedEmployer] = useState("");
  // The chosen month only applies to the year and employer it was picked for; otherwise the latest payslip leads.
  const [focus, setFocus] = useState<{ scope: string; month: number } | null>(null);
  const payslips = state.payslips ?? noPayslips;
  const employers = [
    ...new Map(
      payslips
        .filter((entry) => entry.year === year)
        .map((entry) => [payrollEmployerKey(entry.employer), entry.employer]),
    ).values(),
  ];
  const employer =
    employers.find(
      (name) =>
        payrollEmployerKey(name) === payrollEmployerKey(selectedEmployer),
    ) ??
    employers[0] ??
    "";
  const asOf = state.settings.asOf;
  // The analysis only depends on the payslips; picking another month must not recompute it.
  const view = useMemo(() => payrollPresentation(payslips, year, employer, asOf), [payslips, year, employer, asOf]);
  const entries = useMemo(() => employerPayslips(payslips, year, employer), [payslips, year, employer]);
  const scope = scopeKey(year, employer);
  const focusEntry =
    (focus?.scope === scope
      ? entries.find((entry) => entry.month === focus.month)
      : undefined) ?? entries.at(-1);
  const focusIndex = focusEntry ? entries.indexOf(focusEntry) : -1;
  const previousEntry = focusIndex > 0 ? entries[focusIndex - 1] : undefined;
  const nextEntry = focusIndex >= 0 ? entries[focusIndex + 1] : undefined;
  const selectMonth = (month: number) => setFocus({ scope, month });
  usePayslipImported((entry) => {
    setYear(entry.year);
    setSelectedEmployer(entry.employer);
    setFocus({ scope: scopeKey(entry.year, entry.employer), month: entry.month });
  });

  return (
    <>
      <PageHeading title="Gehalt & Steuern">
        <div
          className="flex flex-wrap items-end gap-2 sm:gap-3"
          aria-label="Abrechnungsauswahl"
          role="group"
        >
          <div className="min-w-0 text-xs text-muted-foreground">
            <label className="block" htmlFor="payroll-year">
              Steuerjahr
            </label>
            <select
              id="payroll-year"
              className="select-input mt-1 w-24"
              value={year}
              onChange={(event) => {
                setYear(event.target.value === "2027" ? 2027 : 2026);
                setFocus(null);
              }}
            >
              <option value="2026">2026</option>
              <option value="2027">2027</option>
            </select>
          </div>
          {employers.length > 0 && (
            <div className="min-w-0 max-w-full text-xs text-muted-foreground sm:w-56">
              <label className="block" htmlFor="payroll-employer">
                Dienstverhältnis
              </label>
              <select
                id="payroll-employer"
                className="select-input mt-1 w-full min-w-0 max-w-full truncate"
                title={employer}
                value={employer}
                onChange={(event) => {
                  setSelectedEmployer(event.target.value);
                  setFocus(null);
                }}
              >
                {employers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {focusEntry && (
            <div className="min-w-0 text-xs text-muted-foreground">
              <label className="block" htmlFor="payroll-month">
                Monat
              </label>
              <div className="mt-1 flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Vorheriger Monat"
                  disabled={!previousEntry}
                  onClick={() => previousEntry && selectMonth(previousEntry.month)}
                >
                  <ChevronLeft aria-hidden="true" />
                </Button>
                <select
                  id="payroll-month"
                  className="select-input w-32"
                  value={focusEntry.month}
                  onChange={(event) => selectMonth(Number(event.target.value))}
                >
                  {entries.map((entry) => (
                    <option key={entry.month} value={entry.month}>
                      {payrollMonthName(entry.month)}
                    </option>
                  ))}
                </select>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Nächster Monat"
                  disabled={!nextEntry}
                  onClick={() => nextEntry && selectMonth(nextEntry.month)}
                >
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}
          <PayslipUploadButton />
        </div>
      </PageHeading>
      <div className="space-y-5">
        <PayrollCoverage view={view} />
        {focusEntry ? (
          <>
            <PayrollFocusCard entry={focusEntry} payslips={payslips} />
            <PayrollYearCard
              year={year}
              entries={entries}
              forecast={view.analysis.forecast.months}
              selectedMonth={focusEntry.month}
              onSelectMonth={selectMonth}
            />
            <PayrollResults view={view}>
              {/* Keyed by scope so an opened month never carries over to another year or employer. */}
              <PayrollMonths key={scope} view={view} entries={entries} selectedMonth={focusEntry.month} />
            </PayrollResults>
          </>
        ) : (
          <section
            aria-label="Abrechnungsstand"
            className="flex flex-col items-start gap-3 pt-2"
          >
            <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-2xl bg-accent-muted text-primary">
              <ReceiptText className="size-5" />
            </span>
            <h2 className="font-semibold">
              Noch keine Lohnabrechnungen für {year}
            </h2>
            <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
              Über „Abrechnungen hochladen“ PDFs auswählen – geschützte Dateien fragen nach dem Passwort.
            </p>
          </section>
        )}
        <PayslipImportPanel year={year} employer={employer} />
        <TaxFolderPanel year={year} />
      </div>
    </>
  );
}

export function PayrollTaxes() {
  const { ready } = useFinance();
  return ready ? (
    <EnsurePayslipUpload><PayrollWorkspace /></EnsurePayslipUpload>
  ) : (
    <p role="status" className="text-sm text-muted-foreground">
      Lohnabrechnungen werden geladen …
    </p>
  );
}
