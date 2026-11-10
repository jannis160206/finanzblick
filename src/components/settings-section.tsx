"use client";

import { createContext, useContext, type ReactNode, type Ref } from "react";
import type { LucideIcon } from "lucide-react";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";

type SectionStyle = { level: 2 | 3; descriptions: "inline" | "tip" };
const SettingsSectionStyle = createContext<SectionStyle>({ level: 2, descriptions: "inline" });

export const useSettingsSectionStyle = () => useContext(SettingsSectionStyle);

/** Inside the settings page sections sit below a category heading and keep explanations behind an ⓘ. */
export function SettingsSectionStyleProvider({ value, children }: { value: SectionStyle; children: ReactNode }) {
  return <SettingsSectionStyle.Provider value={value}>{children}</SettingsSectionStyle.Provider>;
}

export function SettingsSection({
  id, title, description, icon: Icon, action, children, sectionRef, tone,
}: {
  id: string;
  title: string;
  description?: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  sectionRef?: Ref<HTMLElement>;
  tone?: "danger";
}) {
  const { level, descriptions } = useContext(SettingsSectionStyle);
  const Heading = level === 3 ? "h3" : "h2";
  return <section ref={sectionRef} id={id} aria-labelledby={`${id}-heading`}
    className={cn("panel scroll-mt-24 overflow-hidden", tone === "danger" && "border-destructive/30")}>
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-5 pt-5 sm:px-6 sm:pt-6">
      <div className="flex min-w-0 items-center gap-2.5">
        <Icon aria-hidden="true" className={cn("size-[1.125rem] shrink-0", tone === "danger" ? "text-destructive" : "text-primary")} />
        <Heading id={`${id}-heading`} className={cn("text-base font-semibold tracking-tight", tone === "danger" && "text-destructive")}>{title}</Heading>
        {description && descriptions === "tip" && <InfoTip label={title}>{description}</InfoTip>}
      </div>
      {action}
    </div>
    {description && descriptions === "inline" && <p className="px-5 pt-1 text-xs leading-relaxed text-muted-foreground sm:px-6">{description}</p>}
    <div className="p-5 pt-4 sm:p-6 sm:pt-5">{children}</div>
  </section>;
}