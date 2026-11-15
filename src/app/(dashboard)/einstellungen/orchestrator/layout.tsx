import type { ReactNode } from "react";
import { OrchestratorShell } from "@/components/orchestrator-admin";

// Hidden admin view: only linked from the settings, never part of the main navigation. The header and the subpage
// navigation stay while the subpages change.
export default function OrchestratorLayout({ children }: { children: ReactNode }) {
  return <OrchestratorShell>{children}</OrchestratorShell>;
}