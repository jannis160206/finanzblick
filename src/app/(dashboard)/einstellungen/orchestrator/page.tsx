import { OrchestratorAdmin } from "@/components/orchestrator-admin";

// Hidden admin view: only linked from the settings, never part of the main navigation.
export default function OrchestratorRoute() {
  return <OrchestratorAdmin />;
}