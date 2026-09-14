import { cn } from "@/lib/utils";

export function ReviewCount({ count, className }: { count: number; className?: string }) {
  if (!count) return null;
  const diameter = Math.max(20, String(count).length * 6 + 8);
  return (
    <span
      aria-label={`${count} offene Zuordnungen`}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-primary text-[10px] leading-none font-semibold text-primary-foreground tabular-nums", className)}
      style={{ width: diameter, height: diameter }}
    >
      {count}
    </span>
  );
}
