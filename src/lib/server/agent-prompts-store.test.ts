import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPrompts } from "@/lib/ai/agent-prompts";
import { agentSystemPrompt, agentToolDefinitions } from "@/lib/ai/agent-step";
import { answerPrompt, interpretPrompt } from "@/lib/ai/specialists";
import { DATA_RULE } from "@/lib/ai/untrusted";
import { activePrompts, AgentPromptsFileError, readPromptOverrides, savePrompt } from "./agent-prompts-store";
import { activeRepo, agentRepoPath, readRepo, repoLive, resetAgent, saveRepo } from "./agent-repo-store";
import { changeRules } from "./rules-store";

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "finanzblick-agent-repo-"));
  path = join(directory, "config", "agent-repo.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("agent repo", () => {
  it("keeps every edit as a version, applies the newest and puts the code default back; the fixed parts always stay", async () => {
    expect(await activePrompts(path)).toEqual({});
    await savePrompt("voice.budget", "  Du bist ein strenger Budget-Coach.  ", path);
    expect(await activePrompts(path)).toEqual({ "voice.budget": "Du bist ein strenger Budget-Coach." });
    const answer = answerPrompt("budget", [], await activePrompts(path));
    expect(answer.startsWith("Du bist ein strenger Budget-Coach. ")).toBe(true);
    expect(answer.endsWith(DATA_RULE)).toBe(true);
    expect(interpretPrompt("contracts", [], { "tools.contracts": "Nur Beispiele." })).toMatch(/Werkzeuge: .*contracts = .*Nur Beispiele\. /);
    // Model, limits, a tool description and knowledge are versions, too; a run sees them at once.
    await saveRepo([{ key: "agent:budget", value: { tier: "pro", maxSteps: 3 } }, { key: "tool:pulse", value: "Was heute noch frei ist." },
      { key: "knowledge:budget:sparregel", value: { title: "Sparregel", text: "Zuerst den Notgroschen auffüllen." } }], { by: "Admin", note: "Test" }, path);
    const repo = await activeRepo(path);
    expect(repo.agents.budget).toMatchObject({ tier: "pro", maxSteps: 3, maxToolCalls: 6 });
    expect(agentToolDefinitions("budget", repo).find((tool) => tool.function.name === "pulse")?.function.description).toBe("Was heute noch frei ist.");
    expect(agentSystemPrompt("budget", repo)).toMatch(/Dein Wissen [\s\S]*### Begriffe im Datenüberblick[\s\S]*### Sparregel\nZuerst den Notgroschen auffüllen\./);
    expect(agentSystemPrompt("budget", repo).endsWith(DATA_RULE)).toBe(true);
    // The default text puts the code default back; the history keeps every version.
    await savePrompt("voice.budget", defaultPrompts["voice.budget"], path);
    expect(await readPromptOverrides(path)).toEqual({});
    expect((await readRepo(path)).items["prompt:voice.budget"].map((version) => version.v)).toEqual([1, 2]);
    await resetAgent("budget", { by: "Admin" }, path);
    const reset = repoLive(await readRepo(path));
    expect(reset.agents.budget).toMatchObject({ tier: "fast", maxSteps: 4 });
    expect(reset.knowledge.budget?.map((doc) => doc.id)).toEqual(["begriffe-ueberblick"]);
    await expect(saveRepo([{ key: "agent:budget", value: { maxSteps: 99 } }], { by: "Admin" }, path)).rejects.toBeInstanceOf(RangeError);
  });

  it("takes over the prompts file of earlier versions once, moving the learned sentence of the old planning prompt to the orchestrator", async () => {
    const legacy = join(directory, "config", "agent-prompts.json");
    const rules = join(directory, "assistant-rules.json");
    const learned = "Bei Wechselwünschen lies zuerst die Verträge und suche dann im Web nach Alternativen.";
    await saveRepo([], { by: "x" }, join(directory, "config", "unused.json"));
    await writeFile(legacy, JSON.stringify({ format: "finanzblick-agent-prompts", version: 1,
      prompts: { supervisor: `Alter Planungstext. ${learned} Antworte nur mit JSON.`, "voice.payroll": "Du erklärst Steuern einfach." } }));
    await changeRules(() => [{ id: "rule-00000001", feedbackId: "fb-00000001", createdAt: "2026-11-15T17:00:00Z", updatedAt: "2026-11-15T17:00:00Z", status: "active",
      comment: "Verträge prüfen", question: "Q", answer: "A", kind: "prompt", rule: learned, scope: "all", target: "routing",
      prompt: { id: "agent.orchestrator", mode: "append", after: learned } }], rules);
    const file = await readRepo(path, rules);
    expect(file.items["prompt:voice.payroll"][0]).toMatchObject({ by: "Migration", value: "Du erklärst Steuern einfach." });
    expect(file.items["prompt:agent.orchestrator"][0].value).toBe(`${defaultPrompts["agent.orchestrator"]} ${learned}`);
    expect(file.items["prompt:supervisor" as "prompt:review"]).toBeUndefined();
  });

  it("never overwrites a damaged file and falls back to the defaults", async () => {
    await savePrompt("router", "x", path);
    await writeFile(path, "{ kaputt");
    await expect(readPromptOverrides(path)).rejects.toBeInstanceOf(AgentPromptsFileError);
    await expect(savePrompt("router", "y", path)).rejects.toBeInstanceOf(AgentPromptsFileError);
    expect(await readFile(path, "utf8")).toBe("{ kaputt");
    expect(await activePrompts(path)).toEqual({});
    expect(() => agentRepoPath({ FINANZBLICK_AGENT_REPO: "relativ.json" })).toThrow();
    expect(agentRepoPath({ NODE_ENV: "production", FINANZBLICK_DATABASE_PATH: join(directory, "accounts.sqlite") })).toBe(join(directory, "agent-repo.json"));
  });
});
