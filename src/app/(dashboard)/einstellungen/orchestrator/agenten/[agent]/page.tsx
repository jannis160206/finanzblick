import { notFound } from "next/navigation";
import { OrchestratorAdmin } from "@/components/orchestrator-admin";
import { isAgentKey } from "@/lib/agents/registry";

export default async function AgentRoute({ params }: { params: Promise<{ agent: string }> }) {
  const { agent } = await params;
  if (!isAgentKey(agent)) notFound();
  return <OrchestratorAdmin view="agenten" agent={agent} />;
}