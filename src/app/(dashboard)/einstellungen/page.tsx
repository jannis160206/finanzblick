import { Suspense } from "react";
import { Settings } from "@/components/settings";
import { PageSkeleton } from "@/components/page-skeleton";

export default function SettingsRoute() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Settings />
    </Suspense>
  );
}
