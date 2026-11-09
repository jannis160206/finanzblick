import { Suspense } from "react";
import { SavingsPage } from "@/components/savings-page";
import { PageSkeleton } from "@/components/page-skeleton";

export default function SavingsRoute() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SavingsPage />
    </Suspense>
  );
}
