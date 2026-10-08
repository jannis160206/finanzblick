"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCompactLayout } from "@/components/ui/use-compact-layout";
import { PayrollDisclosure } from "@/components/payroll-ui";
import { payrollPeriod } from "@/components/payroll-presentation";
import { payslipKey, type Payslip } from "@/lib/payslip-schema";
import { currency, monthLabel } from "@/lib/format";

export function PayslipRecords({
  records,
  disabled,
  onDelete,
}: {
  records: Payslip[];
  disabled: boolean;
  onDelete: (record: Payslip, trigger: HTMLButtonElement) => void;
}) {
  const compact = useCompactLayout();
  if (!records.length) return null;
  const action = (record: Payslip) => (
    <Button
      variant="ghost"
      size="icon"
      className="size-9 shrink-0"
      aria-label={`Abrechnung entfernen: ${record.month}/${record.year}`}
      disabled={disabled}
      onClick={(event) => onDelete(record, event.currentTarget)}
    >
      <Trash2 className="size-3.5" aria-hidden="true" />
    </Button>
  );
  const extra = (record: Payslip) =>
    record.unresolvedSixthBonus ? (
      <p className="mt-1 text-xs text-muted-foreground">
        Weitere Prämie: {currency(record.unresolvedSixthBonus)} ·
        Sechstelzuordnung offen
      </p>
    ) : null;
  return (
    <PayrollDisclosure
      inset
      label="Gespeicherte Abrechnungen"
      title={`Gespeicherte Abrechnungen (${records.length})`}
    >
      {compact ? (
        <div className="divide-y" aria-label="Gespeicherte Lohnabrechnungen">
          {records.map((record) => (
            <article
              key={payslipKey(record)}
              className="py-3 first:pt-0"
              aria-label={monthLabel(payrollPeriod(record.year, record.month))}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-medium">
                    {monthLabel(payrollPeriod(record.year, record.month))}
                  </h3>
                  <p className="break-words text-xs text-muted-foreground">
                    {record.employer}
                  </p>
                </div>
                {action(record)}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Laufendes Brutto</dt>
                  <dd className="mt-1 break-words font-medium tabular-nums">
                    {currency(record.regularGross)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-muted-foreground">Sonderzahlung</dt>
                  <dd className="mt-1 break-words font-medium tabular-nums">
                    {currency(record.specialGross)}
                  </dd>
                </div>
              </dl>
              {extra(record)}
            </article>
          ))}
        </div>
      ) : (
        <div className="max-h-96 overflow-auto">
          <table
            className="w-full text-left text-xs"
            aria-label="Gespeicherte Lohnabrechnungen"
          >
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-muted-foreground">
                <th className="p-2">Abrechnung</th>
                <th className="p-2 text-right">Laufendes Brutto</th>
                <th className="p-2 text-right">Sonderzahlung</th>
                <th>
                  <span className="sr-only">Aktionen</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={payslipKey(record)} className="border-b last:border-0">
                  <th scope="row" className="p-2 text-left font-normal">
                    {monthLabel(payrollPeriod(record.year, record.month))}
                    <span className="block break-words text-muted-foreground">
                      {record.employer}
                    </span>
                    {extra(record)}
                  </th>
                  <td className="p-2 text-right whitespace-nowrap tabular-nums">
                    {currency(record.regularGross)}
                  </td>
                  <td className="p-2 text-right whitespace-nowrap tabular-nums">
                    {currency(record.specialGross)}
                  </td>
                  <td className="p-1">{action(record)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PayrollDisclosure>
  );
}
