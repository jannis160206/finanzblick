import { Suspense } from "react";
import { ContractsPage } from "@/components/contracts/contracts-page";
import { PageSkeleton } from "@/components/page-skeleton";

export default function ContractsRoute() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ContractsPage />
    </Suspense>
  );
}
