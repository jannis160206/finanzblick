import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@/lib/types";
import { agentIds } from "./orchestrator";
import { agentOrder, agentToolList, assistantRuns, lookupTool, toolCall, toolLabel } from "./orchestrator-info";
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

  it("lists the tool calls of all answers of a run with their outcome, and the answering tool of older answers", () => {
    const change = { title: "Spar", diffs: [], operations: [
      { op: "categorize" as const, ids: ["t1", "t2"], category: "Lebensmittel" as const, learn: false },
      { op: "transaction_tag" as const, ids: ["t1"], tag: "Urlaub" },
    ] };
    const chat: AssistantMessage[] = [
      user("u1", 1_000, "Was ist ein ETF und was habe ich für Essen ausgegeben?"),
      answer("a1", 1_400, { tool: "free", calls: [toolCall(lookupTool.knowledge, { empty: true }), toolCall("web", { ok: false }), toolCall("free")] }),
      answer("a1b", 1_500, { tool: "query", calls: [toolCall("query", { ok: false })] }),
      user("u2", 2_000, "Kategorisiere Spar als Lebensmittel"),
      answer("a2", 2_300, { tool: "booking", change, status: "applied", calls: [toolCall("booking", { change })] }),
      user("u3", 3_000, "Sparziel Japan"),
      answer("a3", 3_200, { draft: { action: "savings_goal" }, status: "dismissed", calls: [toolCall("savings_goal")] }),
      user("u4", 4_000, "Merk dir: Puffer 500 €"),
      answer("a4", 4_200, { tool: "remember", status: "preview", calls: [toolCall("remember")] }),
      // Answers from before the calls were recorded only know their tool.
      user("u5", 5_000, "Wie viel netto bekomme ich?"), answer("a5", 5_300, { tool: "payroll" }),
      user("u6", 6_000, "Kaputt"), answer("a6", 6_100, { tool: "query", text: "Dabei ist etwas schiefgegangen. Bitte formuliere es etwas anders." }),
      user("u7", 7_000, "Hallo"), answer("a7", 7_100),
    ];
    const calls = Object.fromEntries(assistantRuns(chat).map((run) => [run.id, run.calls.map((call) => `${call.tool} · ${call.summary} · ${call.state}`)]));
    expect(calls).toEqual({
      u1: ["knowledge_search · Kein Wissen gefunden · ok", "web · Websuche · failed", "free · Antwort formulieren · ok", "query · Ausgaben & Einnahmen · failed"],
      u2: ["booking · Kategorisiere Buchungen und eine weitere Änderung · applied"],
      u3: ["savings_goal · Plane Sparziel · dismissed"],
      u4: ["remember · Merke mir etwas · pending"],
      u5: ["payroll · Gehaltsübersicht · ok"],
      u6: ["query · Ausgaben & Einnahmen · failed"],
      u7: [],
    });
  });
});
