"use client";

import { useState } from "react";
import { FileUp, ReceiptText } from "lucide-react";
import { useFinance } from "@/components/finance-provider";
import { PayslipImportPanel } from "@/components/payslip-import";
import { PageHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { PayrollCoverage, PayrollResults } from "@/components/payroll-results";
import { PayrollDetails } from "@/components/payroll-details";
import { TaxFolderPanel } from "@/components/tax-folder-panel";
import { payrollPresentation } from "@/components/payroll-presentation";
import { payrollEmployerKey, type Payslip } from "@/lib/payslip-schema";

function PayrollWorkspace() {
  const { state } = useFinance();
  const [year, setYear] = useState<Payslip["year"]>(
    state.settings.asOf.startsWith("2027") ? 2027 : 2026,
  );
  const [selectedEmployer, setSelectedEmployer] = useState("");
  const employers = [
    ...new Map(
      (state.payslips ?? [])
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
  const view = payrollPresentation(
    state.payslips ?? [],
    year,
    employer,
    state.settings.asOf,
  );

  return (
    <>
      <PageHeading
        title="Gehalt & Steuern"
      >
        <div
          className="flex flex-wrap items-end gap-3"
          aria-label="Abrechnungsauswahl"
          role="group"
        >
          <div className="min-w-0 text-xs text-muted-foreground">
            <label className="block" htmlFor="payroll-year">
              Steuerjahr
            </label>
            <select
              id="payroll-year"
              className="select-input mt-1 w-28"
              value={year}
              onChange={(event) =>
                setYear(event.target.value === "2027" ? 2027 : 2026)
              }
            >
              <option value="2026">2026</option>
              <option value="2027">2027</option>
            </select>
          </div>
          {employers.length > 0 && (
            <div className="min-w-0 max-w-full text-xs text-muted-foreground sm:w-64">
              <label className="block" htmlFor="payroll-employer">
                Dienstverhältnis
              </label>
              <select
                id="payroll-employer"
                className="select-input mt-1 w-full min-w-0 max-w-full truncate"
                title={employer}
                value={employer}
                onChange={(event) => setSelectedEmployer(event.target.value)}
              >
                {employers.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button asChild className="min-h-10">
            <a href="#payroll-import">
              <FileUp className="size-4" aria-hidden="true" />
              Abrechnung hinzufügen
            </a>
          </Button>
        </div>
      </PageHeading>
      <div className="space-y-5">
        <PayrollCoverage view={view} />
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
          {view.latest ? (
            <PayrollResults view={view} />
          ) : (
            <section
              aria-label="Abrechnungsstand"
              className="panel flex flex-col items-start gap-3 p-6 sm:p-8"
            >
              <span aria-hidden="true" className="flex size-11 items-center justify-center rounded-2xl bg-accent-muted text-primary">
                <ReceiptText className="size-5" />
              </span>
              <h2 className="font-semibold">
                Noch keine Lohnabrechnungen für {year}
              </h2>
              <p className="max-w-md text-sm leading-relaxed text-muted-foreground">
                Lade deine PDF-Abrechnungen hoch. Erkannte Werte erscheinen dann hier.
              </p>
              <Button asChild variant="soft" size="sm" className="mt-1">
                <a href="#payroll-import"><FileUp aria-hidden="true" />PDF hochladen</a>
              </Button>
            </section>
          )}
          <PayslipImportPanel
            year={year}
            employer={employer}
            onImported={(entry) => {
              setYear(entry.year);
              setSelectedEmployer(entry.employer);
            }}
          />
        </div>
        {view.latest && (
          <PayrollDetails view={view} />
        )}
        <TaxFolderPanel year={year} />
      </div>
    </>
  );
}

export function PayrollTaxes() {
  const { ready } = useFinance();
  return ready ? (
    <PayrollWorkspace />
  ) : (
    <p role="status" className="text-sm text-muted-foreground">
      Lohnabrechnungen werden geladen …
    </p>
  );
}
