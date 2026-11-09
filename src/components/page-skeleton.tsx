import { Skeleton } from "@/components/ui/skeleton";

export function PageSkeleton({ label = "Ansicht wird geladen …" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <span className="sr-only">{label}</span>
      <div className="space-y-2">
        <Skeleton className="h-8 w-48 rounded-lg" />
        <Skeleton className="h-4 w-36 rounded-md" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <Skeleton className="h-52 rounded-3xl border border-border/60" />
        <div className="grid gap-px overflow-hidden rounded-3xl border border-border/60">
          {[0, 1, 2].map((index) => (
            <div key={index} className="flex items-center gap-3 bg-card px-5 py-4">
              <Skeleton className="size-10 shrink-0 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-24 rounded" />
                <Skeleton className="h-5 w-32 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-12">
        <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-5 sm:p-6 xl:col-span-7">
          <Skeleton className="h-4 w-40 rounded" />
          <Skeleton className="h-7 w-32 rounded" />
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="space-y-2">
              <Skeleton className="h-3 w-full rounded" />
              <Skeleton className="h-1.5 w-full rounded-full" />
            </div>
          ))}
        </div>
        <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-5 sm:p-6 xl:col-span-5">
          <Skeleton className="h-4 w-32 rounded" />
          <Skeleton className="h-8 w-40 rounded" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
