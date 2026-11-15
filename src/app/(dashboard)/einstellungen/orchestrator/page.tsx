import { redirect } from "next/navigation";
import { orchestratorHref } from "@/lib/assistant/orchestrator-pages";

export default function OrchestratorRoute() {
  redirect(orchestratorHref("uebersicht"));
}