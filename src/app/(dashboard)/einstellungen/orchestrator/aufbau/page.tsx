import { redirect } from "next/navigation";
import { orchestratorHref } from "@/lib/assistant/orchestrator-pages";

// The former "Aufbau & Topologie" page; old links land on the topology.
export default function BuildRoute() {
  redirect(orchestratorHref("topologie"));
}