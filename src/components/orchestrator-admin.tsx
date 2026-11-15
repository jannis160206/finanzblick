"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { m } from "motion/react";
import { ChevronLeft, RefreshCw } from "lucide-react";
import { AgentDetailView } from "@/components/orchestrator/agent-detail";
import { AgentsView } from "@/components/orchestrator/agents";
import { DataCatalogView } from "@/components/orchestrator/data-catalog";
import { EvalsView } from "@/components/orchestrator/evals";
import { FeedbackView } from "@/components/orchestrator/feedback";
import { KnowledgeView } from "@/components/orchestrator/knowledge";
import { OverviewView } from "@/components/orchestrator/overview";
import { RunsView } from "@/components/orchestrator/runs";
import { RefreshContext } from "@/components/orchestrator/shared";
import { ToolsView } from "@/components/orchestrator/tools";
import { TopologyView } from "@/components/orchestrator/topology";
import { OrchestratorNav } from "@/components/orchestrator-nav";
import { useFinance } from "@/components/finance-provider";
import { PageHeading } from "@/components/finance-ui";
import { Button } from "@/components/ui/button";
import { dialogSpring, useMotionMode } from "@/components/ui/premium-dialog/motion";
import type { AgentKey } from "@/lib/agents/registry";
import { assistantRuns } from "@/lib/assistant/orchestrator-info";
import type { OrchestratorView } from "@/lib/assistant/orchestrator-pages";
import { cn } from "@/lib/utils";

/** Header and navigation of the orchestrator view; the subpages render below. */
export function OrchestratorShell({ children }: { children: ReactNode }) {
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(0);
  const track = useCallback((work: Promise<unknown>) => {
    setPending((count) => count + 1);
    void work.finally(() => setPending((count) => Math.max(0, count - 1)));
  }, []);
  const value = useMemo(() => ({ tick, track }), [tick, track]);
  return <div className="mx-auto max-w-6xl">
    <PageHeading title="Orchestrator" description="Die Agenten-Plattform des Finanz-Assistenten: Topologie, Daten, Wissen, Läufe, Evals und das Agent-Repo.">
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="ghost" size="sm"><Link href="/einstellungen"><ChevronLeft aria-hidden="true" />Einstellungen</Link></Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setTick((count) => count + 1)} disabled={pending > 0}>
          <RefreshCw aria-hidden="true" className={cn(pending > 0 && "animate-spin motion-reduce:animate-none")} />Aktualisieren
        </Button>
      </div>
    </PageHeading>
    <OrchestratorNav />
    <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
  </div>;
}

function View({ view, agent }: { view: OrchestratorView; agent?: AgentKey }) {
  const { state } = useFinance();
  const runs = useMemo(() => assistantRuns(state.assistantChat ?? []), [state.assistantChat]);
  switch (view) {
    case "uebersicht": return <OverviewView runs={runs} />;
    case "topologie": return <TopologyView />;
    case "daten": return <DataCatalogView />;
    case "wissen": return <KnowledgeView />;
    case "laeufe": return <RunsView runs={runs} />;
    case "evals": return <EvalsView />;
    case "agenten": return agent ? <AgentDetailView agent={agent} /> : <AgentsView />;
    case "werkzeuge": return <ToolsView />;
    case "feedback": return <FeedbackView />;
  }
}

/** One subpage of the admin view of the assistant's agent platform (or one agent's page); it glides in when opened. */
export function OrchestratorAdmin({ view, agent }: { view: OrchestratorView; agent?: AgentKey }) {
  const mode = useMotionMode();
  return <m.div key={agent ? `${view}:${agent}` : view} className="space-y-6" data-orchestrator-view={view}
    initial={mode === "full" ? { opacity: 0, y: 8, filter: "blur(2px)" } : false} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
    transition={mode === "full" ? dialogSpring : { duration: 0 }}>
    <View view={view} agent={agent} />
  </m.div>;
}
