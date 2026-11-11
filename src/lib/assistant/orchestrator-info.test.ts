import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@/lib/types";
import { agentIds } from "./orchestrator";
import { agentOrder, agentToolList, assistantRuns, toolLabel } from "./orchestrator-info";
import { assistantTools } from "./tools";

const user = (id: string, at: number, text: string): AssistantMessage => ({ id, role: "user", text, at });
const answer = (id: string, at: number, extra: Partial<AssistantMessage> = {}): AssistantMessage => ({ id, role: "assistant", text: "Antwort", at, ...extra });

describe("orchestrator admin data", () => {
  it("names every tool and lists each one under exactly one agent", () => {
    expect(Object.keys(toolLabel).toSorted()).toEqual([...assistantTools].toSorted());
    expect(agentOrder.toSorted()).toEqual([...agentIds].toSorted());
    const listed = agentOrder.flatMap((agent) => agentToolList(agent));
    expect(listed.toSorted()).toEqual([...assistantTools].toSorted());
  });

  it("pairs each question with its first answer, newest first, with agent, route, status and duration", () => {
    const chat: AssistantMessage[] = [
      answer("briefing", 0, { text: "Wochenüberblick" }),
      user("u1", 1_000, "Hallo"), answer("a1", 1_700, { agent: "general", via: "rule", ms: 680 }),
      user("u2", 2_000, "Wie viel netto bekomme ich?"), answer("a2", 2_900, { agent: "payroll", via: "rule" }),
      // A follow-up message of the same run (e.g. something remembered) does not count twice.
      answer("a2b", 2_950, { text: "Gemerkt" }),
      user("u3", 3_000, "blabla"), answer("a3", 3_500, { agent: "general", via: "fallback", correcting: "blabla" }),
      user("u4", 4_000, "Japan sparen"), answer("a4", 4_400, { agent: "budget", via: "rule", draft: { action: "savings_goal" }, status: "question" }),
      user("u5", 5_000, "Kaputt"), answer("a5", 5_200, { text: "Dabei ist etwas schiefgegangen. Bitte formuliere es etwas anders." }),
      user("u6", 6_000, "noch offen"),
    ];
    const runs = assistantRuns(chat);
    expect(runs.map((run) => [run.question, run.agent, run.via, run.status, run.ms])).toEqual([
      ["Kaputt", undefined, undefined, "error", 200],
      ["Japan sparen", "budget", "rule", "question", 400],
      ["blabla", "general", "fallback", "unclear", 500],
      ["Wie viel netto bekomme ich?", "payroll", "rule", "answered", 900],
      ["Hallo", "general", "rule", "answered", 680],
    ]);
    expect(assistantRuns(chat, 2)).toHaveLength(2);
    expect(assistantRuns([])).toEqual([]);
  });
});
