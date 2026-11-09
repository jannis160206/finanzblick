import { Suspense } from "react";
import { PayrollTaxes } from "@/components/payroll-taxes";
import { FinancialWorkspace } from "@/components/financial-data";
import { PageSkeleton } from "@/components/page-skeleton";

export default function PayrollRoute() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <FinancialWorkspace title="Gehalt & Steuern"><PayrollTaxes /></FinancialWorkspace>
    </Suspense>
  );
}
