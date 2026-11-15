import { describe, expect, it } from "vitest";
import { callInput, runOrchestrator, type RuntimeDeps, type RuntimeEvent, type StepRequest, type StepResult } from "./runtime";

const call = (id: string, name: string, args: Record<string, string>) => ({ id, name, arguments: JSON.stringify(args) });

/** A run whose steps answer from a script per agent: the n-th step of an agent gets the n-th entry. */
function harness(script: Partial<Record<StepRequest["agent"], (request: StepRequest) => StepResult>>, extra: Partial<RuntimeDeps> = {}) {
  const steps: StepRequest[] = [];
  const executed: string[] = [];
  const events: RuntimeEvent[] = [];
  const deps: RuntimeDeps = {
    signal: new AbortController().signal,
    step: async (request) => {
      steps.push(structuredClone(request));
      const answer = script[request.agent];
      if (!answer) throw new Error(`no script for ${request.agent}`);
      return answer(request);
    },
    execute: async (agent, tool, input) => {
      executed.push(`${agent}:${tool}:${input}`);
      return { ok: true, content: `${tool} sagt: 412,50 € für „${input}“` };
    },
    emit: (event) => events.push(event),
    ...extra,
  };
  return { deps, steps, executed, events };
}

describe("agent runtime", () => {
  it("delegates to specialists at the same time, lets them use their tools and writes the answer from their findings", async () => {
    const { deps, steps, executed, events } = harness({
      orchestrator: (request) => request.turns.length === 0
        ? { calls: [call("o1", "budget", { aufgabe: "Was ist diesen Monat frei?" }), call("o2", "recherche", { aufgabe: "Was kostet ein günstiges Girokonto?" })] }
        : { calls: [], text: `Dir bleiben **412,50 €** frei. [1]` },
      budget: (request) => request.turns.length === 0 ? { calls: [call("b1", "pulse", { frage: "Wie viel kann ich heute ausgeben?" })] } : { calls: [], text: "Frei: 412,50 €" },
      research: (request) => request.turns.length === 0 ? { calls: [call("r1", "web", { suche: "günstiges Girokonto Österreich" })] } : { calls: [], text: "[1] 0 € bei Direktbanken" },
    });
    expect(await runOrchestrator("Lohnt sich ein anderes Konto?", deps)).toEqual({ kind: "answer", text: "Dir bleiben **412,50 €** frei. [1]" });
    expect(executed.sort()).toEqual(["budget:pulse:Wie viel kann ich heute ausgeben?", "research:web:günstiges Girokonto Österreich"]);
    // The orchestrator's second step sees both findings as tool results.
    const second = steps.filter((step) => step.agent === "orchestrator")[1];
    expect(second.turns[0].results).toEqual([{ id: "o1", content: "Frei: 412,50 €" }, { id: "o2", content: "[1] 0 € bei Direktbanken" }]);
    // A specialist sees its task, the user's message for context and its own tool results only.
    const budget = steps.filter((step) => step.agent === "budget");
    expect(budget[0]).toMatchObject({ message: "Was ist diesen Monat frei?", question: "Lohnt sich ein anderes Konto?", turns: [] });
    expect(steps.find((step) => step.agent === "orchestrator")?.question).toBeUndefined();
    expect(budget[1].turns[0].results[0].content).toContain("pulse sagt: 412,50 €");
    expect(events.filter((event) => event.type === "delegate").map((event) => event.type === "delegate" && event.agent)).toEqual(["budget", "research"]);
  });

  it("hands a change to the workflow, which asks first, and ends the run", async () => {
    const { deps, executed } = harness({ orchestrator: () => ({ calls: [call("o1", "aenderung", { auftrag: "Setz Tanken im Dezember auf 150 €" })] }) });
    expect(await runOrchestrator("Setz Tanken im Dezember auf 150 €", deps)).toEqual({ kind: "change", task: "Setz Tanken im Dezember auf 150 €" });
    expect(executed).toEqual([]);
  });

  it("keeps to the live limits: the last allowed step must answer in words, extra tool calls are dropped", async () => {
    const limits = { maxSteps: 2, maxToolCalls: 1, timeoutMs: 60_000, maxTokens: 500 };
    const { deps, steps, executed } = harness({
      orchestrator: (request) => request.final ? { calls: [], text: "Fertig.", limits } : { calls: [call("o1", "budget", { aufgabe: "A" }), call("o2", "umsaetze", { aufgabe: "B" })], limits },
      budget: (request) => request.final ? { calls: [], text: "Frei: 412,50 €" } : { calls: [call("b1", "pulse", { frage: "P" }), call("b2", "forecast", { frage: "F" })], limits },
    });
    expect(await runOrchestrator("Frage", deps)).toEqual({ kind: "answer", text: "Fertig." });
    expect(executed).toEqual(["budget:pulse:P"]);
    expect(steps.filter((step) => step.agent === "orchestrator").map((step) => step.final)).toEqual([false, true]);
    expect(steps.some((step) => step.agent === "transactions")).toBe(false);
  });

  it("turns a failing specialist and an unknown tool into text the orchestrator can react to", async () => {
    const { deps, steps } = harness({
      orchestrator: (request) => request.turns.length ? { calls: [], text: "Dazu habe ich gerade keine Daten." }
        : { calls: [call("o1", "gehalt", { aufgabe: "Netto?" }), call("o2", "zaubern", { aufgabe: "x" })] },
      payroll: () => { throw new Error("DeepSeek: Zeitüberschreitung"); },
    });
    expect(await runOrchestrator("Wie viel netto?", deps)).toEqual({ kind: "answer", text: "Dazu habe ich gerade keine Daten." });
    expect(steps.at(-1)?.turns[0].results).toEqual([{ id: "o1", content: "Der Spezialist hat nicht rechtzeitig geantwortet." }, { id: "o2", content: "Dieses Werkzeug gibt es nicht." }]);
  });

  it("reads the one argument of a call, also from a broken one", () => {
    expect(callInput(call("1", "web", { suche: " Girokonto " }))).toBe("Girokonto");
    expect(callInput({ id: "1", name: "web", arguments: "Girokonto Vergleich" })).toBe("Girokonto Vergleich");
    expect(callInput({ id: "1", name: "web", arguments: "" })).toBe("");
  });
});
