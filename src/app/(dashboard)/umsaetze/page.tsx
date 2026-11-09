import { Suspense } from "react";
import { Transactions } from "@/components/transactions";
import { PageSkeleton } from "@/components/page-skeleton";

export default function TransactionsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Transactions />
    </Suspense>
  );
}
