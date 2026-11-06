import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { Transactions } from "@/components/transactions";
import { BudgetPage } from "@/components/budget-page";
import { SavingsPage } from "@/components/savings-page";
import { Settings } from "@/components/settings";
import { PayrollTaxes } from "@/components/payroll-taxes";
import { FinancialWorkspace } from "@/components/financial-data";

const views = {
  umsaetze: Transactions,
  budget: BudgetPage,
  sparen: SavingsPage,
  "gehalt-steuern": PayrollTaxes,
  einstellungen: Settings,
};
// Old bookmarks keep working after the pages were merged.
const moved: Record<string, string> = {
  monate: "/budget?ansicht=jahr",
  plan: "/budget",
  pockets: "/sparen",
  assistent: "/?assistent=1",
};
export default async function FinancePage({
  params,
}: {
  params: Promise<{ view: string }>;
}) {
  const { view } = await params;
  if (Object.hasOwn(moved, view)) redirect(moved[view]);
  if (!Object.hasOwn(views, view)) notFound();
  const View = views[view as keyof typeof views];
  return (
    <Suspense
      fallback={
        <p className="text-sm text-muted-foreground">Ansicht wird geladen …</p>
      }
    >
      {view === "gehalt-steuern" ? <FinancialWorkspace title="Gehalt & Steuern"><View /></FinancialWorkspace> : <View />}
    </Suspense>
  );
}