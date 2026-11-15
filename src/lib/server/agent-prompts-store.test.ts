import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPrompts } from "@/lib/ai/agent-prompts";
import { answerPrompt, interpretPrompt } from "@/lib/ai/specialists";
import { supervisorPrompt } from "@/lib/ai/supervisor";
import { DATA_RULE } from "@/lib/ai/untrusted";
import { activePrompts, AgentPromptsFileError, agentPromptsPath, readPromptOverrides, savePrompt } from "./agent-prompts-store";

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "finanzblick-agent-prompts-"));
  path = join(directory, "config", "agent-prompts.json");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("agent prompts", () => {
  it("saves, applies and resets an edited prompt; the fixed parts always stay", async () => {
    expect(await activePrompts(path)).toEqual({});
    await savePrompt("voice.budget", "  Du bist ein strenger Budget-Coach.  ", path);
    const prompts = await activePrompts(path);
    expect(prompts).toEqual({ "voice.budget": "Du bist ein strenger Budget-Coach." });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ format: "finanzblick-agent-prompts", version: 1 });
    const answer = answerPrompt("budget", [], true, prompts);
    expect(answer.startsWith("Du bist ein strenger Budget-Coach. Du bist der Supervisor")).toBe(true);
    expect(answer).toContain("Zahlen zu seinen Finanzen nimmst du nur aus den Fakten");
    expect(answer.endsWith(DATA_RULE)).toBe(true);
    // Tool lists and the data rule stay even when the guide is replaced; the team is added when the placeholder is gone.
    expect(interpretPrompt("contracts", [], { "tools.contracts": "Nur Beispiele." })).toMatch(/Werkzeuge: .*contracts = .*Nur Beispiele\. /);
    expect(supervisorPrompt({ supervisor: "Plane kurz. Antworte nur mit JSON." })).toMatch(/^Plane kurz\. Antworte nur mit JSON\.\nSpezialisten und Werkzeuge.*\n.*query/);
    expect(supervisorPrompt()).not.toContain("{werkzeuge}");
    expect(supervisorPrompt()).not.toContain("{rechner}");
    // The default text or a reset removes the entry again.
    await savePrompt("voice.budget", defaultPrompts["voice.budget"], path);
    expect(await activePrompts(path)).toEqual({});
    await savePrompt("synthesis", "Schreib knapp.", path);
    await savePrompt("synthesis", undefined, path);
    expect(await readPromptOverrides(path)).toEqual({});
  });

  it("never overwrites a damaged file and falls back to the defaults", async () => {
    await savePrompt("orchestrator", "x", path);
    await writeFile(path, "{ kaputt");
    await expect(readPromptOverrides(path)).rejects.toBeInstanceOf(AgentPromptsFileError);
    await expect(savePrompt("orchestrator", "y", path)).rejects.toBeInstanceOf(AgentPromptsFileError);
    expect(await readFile(path, "utf8")).toBe("{ kaputt");
    expect(await activePrompts(path)).toEqual({});
    expect(() => agentPromptsPath({ FINANZBLICK_AGENT_PROMPTS: "relativ.json" })).toThrow();
    expect(agentPromptsPath({ NODE_ENV: "production", FINANZBLICK_DATABASE_PATH: join(directory, "accounts.sqlite") })).toBe(join(directory, "agent-prompts.json"));
  });
});
