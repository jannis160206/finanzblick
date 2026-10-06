import { Suspense } from "react";
import { notFound } from "next/navigation";
import { Transactions } from "@/components/transactions";
import { Months } from "@/components/months";
import { Pockets } from "@/components/pockets";
import { Plan } from "@/components/plan";
import { Settings } from "@/components/settings";
import { PayrollTaxes } from "@/components/payroll-taxes";

const views = {
  umsaetze: Transactions,
  monate: Months,
  pockets: Pockets,
  plan: Plan,
  "gehalt-steuern": PayrollTaxes,
  einstellungen: Settings,
};
export default async function FinancePage({
  params,
}: {
  params: Promise<{ view: string }>;
}) {
  const { view } = await params;
  if (!Object.hasOwn(views, view)) notFound();
  const View = views[view as keyof typeof views];
  return (
    <Suspense
      fallback={
        <p className="text-sm text-muted-foreground">Ansicht wird geladen …</p>
      }
    >
      <View />
    </Suspense>
  );
}
