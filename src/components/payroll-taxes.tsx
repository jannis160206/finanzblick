"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, ReceiptText } from "lucide-react";
import { toast } from "sonner";
import { useFinance } from "@/components/finance-provider";
import { PayslipRemoveDialog, type PayslipRemoval } from "@/components/payslip-remove-dialog";
import { PayslipSummary } from "@/components/payslip-summary";
import { EnsurePayslipUpload, PayslipUploadButton, usePayslipImported } from "@/components/payslip-upload";
import { PageHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { PayrollCoverage, PayrollResults } from "@/components/payroll-results";
import { PayrollFocusCard } from "@/components/payroll-focus";
import { PayrollYearCard } from "@/components/payroll-year";
import { PayrollMonthSelect, type PayrollMonthState } from "@/components/payroll-month-select";
import { payrollPresentation } from "@/components/payroll-presentation";
import { employerPayslips } from "@/lib/payroll-overview";
import { successBonusPercent, type PayrollYear } from "@/lib/payroll-analysis";
import { confirmPayslip } from "@/lib/payroll-budget";
import { monthLabel } from "@/lib/format";
import { isReferencePayslip, payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";
import { payslipHold, type PayslipCheck } from "@/lib/payslip-validation";
import { wageTaxCaption } from "@/lib/wage-tax-at";

const scopeKey = (year: number, employer: string) => `${year}|${payrollEmployerKey(employer)}`;
const noPayslips: Payslip[] = [];

function PayrollWorkspace() {
  const { state, update } = useFinance();
  const [year, setYear] = useState<PayrollYear>(
    state.settings.asOf.startsWith("2027") ? 2027 : 2026,
  );
  const [selectedEmployer, setSelectedEmployer] = useState("");
  // The chosen month only applies to the year and employer it was picked for; otherwise the latest payslip leads.
  const [focus, setFocus] = useState<{ scope: string; month: number } | null>(null);
  const [removal, setRemoval] = useState<PayslipRemoval | null>(null);
  const [reviewRequest, setReviewRequest] = useState(0);
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
  const bonus = successBonusPercent(state.settings);
  const modelOptions = useMemo(() => ({ successBonusPercent: bonus }), [bonus]);
  // The analysis only depends on the payslips; picking another month must not recompute it.
  const view = useMemo(() => payrollPresentation(payslips, year, employer, asOf, modelOptions), [payslips, year, employer, asOf, modelOptions]);
  const entries = useMemo(() => employerPayslips(payslips, year, employer), [payslips, year, employer]);
  const credits = view.analysis.credits;
  const taxNote = `${wageTaxCaption(year)}${credits.label.startsWith("Absetzbeträge") ? " lt. Abrechnung" : ` (${credits.label})`}`;
  const confirmed = state.payrollBudget?.confirmed;
  // Contradicting payslips stay out of the budget until the user takes them in; their month gets an amber dot.
  const holds = useMemo(() => new Map(entries.flatMap((entry): [number, PayslipCheck[]][] => {
    const hold = payslipHold(entry, payslips, confirmed);
    return hold ? [[entry.month, hold.checks.filter((check) => check.level === "error")]] : [];
  })), [entries, payslips, confirmed]);
  const monthStates = useMemo(() => Object.fromEntries(entries.map((entry): [number, PayrollMonthState] =>
    [entry.month, holds.has(entry.month) ? "review" : "imported"])), [entries, holds]);
  const reviewPayslip = (entry: Payslip) => {
    if (entry.year === 2026 || entry.year === 2027) setYear(entry.year);
    setSelectedEmployer(entry.employer);
    setFocus({ scope: scopeKey(entry.year, entry.employer), month: entry.month });
    setReviewRequest((count) => count + 1);
  };
  useEffect(() => {
    if (reviewRequest) document.getElementById("payroll-focus")?.focus();
  }, [reviewRequest]);
  const confirmEntry = (entry: Payslip) => {
    update((current) => confirmPayslip(current, entry).state);
    toast.success(`Abrechnung ${monthLabel(`${entry.year}-${String(entry.month).padStart(2, "0")}`)} ins Budget übernommen`);
  };
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
    if (isReferencePayslip(entry)) return;
    setYear(entry.year === 2027 ? 2027 : 2026);
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
                <PayrollMonthSelect id="payroll-month" value={focusEntry.month} states={monthStates} onChange={selectMonth} />
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
            {/* Keyed by payslip so a removed month's buttons never hand focus to the next payslip. */}
            <PayrollFocusCard key={`${scope}|${focusEntry.month}`} entry={focusEntry} payslips={payslips}
              review={holds.get(focusEntry.month)} onConfirm={confirmEntry} taxNote={taxNote}
              onRemove={(entry, trigger) => setRemoval({ entry, trigger })} />
            <PayrollYearCard
              year={year}
              entries={entries}
              forecast={view.analysis.forecast.months}
              selectedMonth={focusEntry.month}
              onSelectMonth={selectMonth}
            />
            <PayrollResults view={view} />
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
        <PayslipSummary onReviewPayslip={reviewPayslip} />
      </div>
      <PayslipRemoveDialog target={removal} onClose={() => setRemoval(null)}
        fallbackFocus={() => document.querySelector<HTMLElement>("#payroll-month, #payroll-import")?.focus()} />
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
