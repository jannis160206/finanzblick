import { Suspense } from "react";
import { BudgetPage } from "@/components/budget-page";
import { PageSkeleton } from "@/components/page-skeleton";

export default function BudgetRoute() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <BudgetPage />
    </Suspense>
  );
}
