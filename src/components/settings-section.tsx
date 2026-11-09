import type { ReactNode, Ref } from "react";
import type { LucideIcon } from "lucide-react";

export function SettingsSection({
  id, title, description, icon: Icon, action, children, sectionRef,
}: {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  sectionRef?: Ref<HTMLElement>;
}) {
  return <section ref={sectionRef} id={id} aria-labelledby={`${id}-heading`} className="panel scroll-mt-24 overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 px-5 py-5 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-primary">
          <Icon aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 id={`${id}-heading`} className="text-base font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      {action}
    </div>
    <div className="p-5 sm:p-6">{children}</div>
  </section>;
}
