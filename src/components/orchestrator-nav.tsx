"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, m } from "motion/react";
import { ChevronRight, Workflow } from "lucide-react";
import { dialogSpring, exitTween, useMotionMode } from "@/components/ui/premium-dialog/motion";
import { orchestratorHref, orchestratorPages } from "@/lib/assistant/orchestrator-pages";
import { cn } from "@/lib/utils";

const focusRing = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The subpages of the orchestrator view; the highlight glides to the open one. */
export function OrchestratorNav() {
  const pathname = usePathname();
  const mode = useMotionMode();
  return <nav aria-label="Orchestrator-Bereiche" className="mb-6">
    <ul className="flex flex-wrap gap-1 rounded-2xl border border-border/70 bg-card p-1 shadow-card">
      {orchestratorPages.map((page) => {
        const href = orchestratorHref(page.slug);
        const active = pathname === href;
        return <li key={page.slug} className="relative">
          {active && (mode === "full"
            ? <m.span layoutId="orchestrator-nav-active" aria-hidden="true" className="absolute inset-0 rounded-xl bg-primary/12" transition={dialogSpring} />
            : <span aria-hidden="true" className="absolute inset-0 rounded-xl bg-primary/12" />)}
          <Link href={href} aria-current={active ? "page" : undefined} title={page.description}
            className={cn("relative flex min-h-10 items-center rounded-xl px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground aria-[current=page]:text-foreground", focusRing)}>
            {page.label}
          </Link>
        </li>;
      })}
    </ul>
  </nav>;
}

/** The quiet link in the settings, with an arrow that folds out the orchestrator's subpages. */
export function OrchestratorSettingsLinks({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const list = useId();
  const mode = useMotionMode();
  return <div className={className}>
    <div className="flex items-center gap-0.5">
      <Link href={orchestratorHref("aufbau")} title="Aufbau, Agenten-Prompts, Läufe und Feedback des Finanz-Assistenten"
        className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:text-foreground lg:px-3", focusRing)}>
        <Workflow aria-hidden="true" className="size-3.5" />Assistent-Orchestrator
      </Link>
      <button type="button" aria-expanded={open} aria-controls={open ? list : undefined} onClick={() => setOpen((value) => !value)}
        aria-label={open ? "Orchestrator-Unterseiten ausblenden" : "Orchestrator-Unterseiten anzeigen"}
        className={cn("inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground", focusRing)}>
        <m.span className="inline-flex" animate={{ rotate: open ? 90 : 0 }} transition={mode === "full" ? dialogSpring : { duration: 0 }}>
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </m.span>
      </button>
    </div>
    <AnimatePresence initial={false}>
      {open && <m.ul key="pages" id={list} aria-label="Orchestrator-Unterseiten" className="ml-4 mt-0.5 space-y-0.5 border-l border-border/70 pl-2 lg:ml-5"
        initial={mode === "full" ? { opacity: 0, y: -6, filter: "blur(2px)" } : { opacity: 0 }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={mode === "full" ? { opacity: 0, y: -6, filter: "blur(2px)", transition: exitTween } : { opacity: 0, transition: exitTween }}
        transition={mode === "full" ? dialogSpring : { duration: mode === "none" ? 0 : 0.16 }}>
        {orchestratorPages.map((page) => <li key={page.slug}>
          <Link href={orchestratorHref(page.slug)}
            className={cn("flex min-h-9 items-center rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground", focusRing)}>
            {page.label}
          </Link>
        </li>)}
      </m.ul>}
    </AnimatePresence>
  </div>;
}
