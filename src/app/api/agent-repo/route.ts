import { z } from "zod";
import { agentPrompts, defaultPrompts, MAX_PROMPT_LENGTH } from "@/lib/ai/agent-prompts";
import { agentSystemPrompt } from "@/lib/ai/agent-step";
import { DATA_RULE } from "@/lib/ai/untrusted";
import {
  agentDefs, agentSources, agentToolSpecs, dataCatalog, dataSource, dataSources, defaultKnowledge, isAgentKey, isLlmAgentKey, MAX_KNOWLEDGE_CHARS,
  MAX_KNOWLEDGE_DOC, toolSpecs, type AgentKey,
} from "@/lib/agents/registry";
import {
  agentRepoKeys, AgentRepoFileError, agentRepoPath, MAX_TOOL_DESCRIPTION, readRepo, repoLive, resetAgent, saveRepo, type RepoFile, type RepoKey,
} from "@/lib/server/agent-repo-store";
import { assistantCaller } from "@/lib/server/assistant-access";
import { feedbackDisplayPath } from "@/lib/server/feedback-store";
import { accountErrorResponse, jsonResponse, readJsonBody } from "@/lib/server/http";
import { promptRules } from "@/lib/server/rules-store";

export const runtime = "nodejs";

function failed(error: unknown): Response {
  if (error instanceof RangeError) return jsonResponse({ error: error.message }, 400);
  if (!(error instanceof AgentRepoFileError)) return accountErrorResponse(error);
  console.error("Agent repo file is damaged; it was left untouched.");
  return jsonResponse({ error: "Die Datei des Agent-Repos ist beschädigt und wird nicht überschrieben. Bitte die Datei prüfen." }, 500);
}

const live = (file: RepoFile, key: string) => file.items[key]?.at(-1);
const keyLabel = (key: string): string => {
  const [kind, id, doc] = key.split(":");
  if (kind === "prompt") return `Prompt ${id}`;
  if (kind === "agent") return "Modell & Limits";
  if (kind === "tool") return `Werkzeug ${id}`;
  return `Wissen ${doc ?? id}`;
};

/** Everything the admin view shows: agents with prompts, models, limits and history; tools; knowledge; data catalog. */
async function overview(file: RepoFile) {
  const repo = repoLive(file);
  const rules = await promptRules();
  const knowledge = Object.fromEntries(agentDefs.map((agent) => {
    const code = defaultKnowledge[agent.key] ?? [];
    return [agent.key, (repo.knowledge[agent.key] ?? []).map((doc) => {
      const version = live(file, `knowledge:${agent.key}:${doc.id}`);
      return { ...doc, chars: doc.text.length, code: code.some((item) => item.id === doc.id), custom: !!version && version.value !== null,
        ...(version ? { version: version.v, by: version.by, at: version.at } : {}) };
    })];
  }));
  const agents = agentDefs.map((agent) => {
    const keys = agentRepoKeys(agent.key, file);
    const history = keys.flatMap((key) => (file.items[key] ?? []).map((version) => ({ key, label: keyLabel(key), v: version.v, at: version.at, by: version.by,
      ...(version.note ? { note: version.note } : {}), reset: version.value === null })))
      .sort((a, b) => b.at.localeCompare(a.at) || b.v - a.v).slice(0, 30);
    const edited = keys.filter((key) => (live(file, key)?.value ?? null) !== null);
    return {
      key: agent.key, name: agent.name, kind: agent.kind, summary: agent.summary, ...(agent.mode ? { mode: agent.mode } : {}),
      ...(agent.config ? { config: repo.agents[agent.key] ?? agent.config, defaults: agent.config } : {}),
      tools: agentToolSpecs(agent.key).map((tool) => tool.name), sources: agentSources(agent.key).map(dataSource),
      prompts: agentPrompts(agent.key).map((meta) => ({ ...meta, default: defaultPrompts[meta.id], text: repo.prompts[meta.id] ?? defaultPrompts[meta.id],
        custom: repo.prompts[meta.id] !== undefined })),
      ...(isLlmAgentKey(agent.key) ? { assembled: agentSystemPrompt(agent.key, repo, rules) }
        : agent.key === "review" ? { assembled: `${repo.prompts.review ?? defaultPrompts.review} ${DATA_RULE}` } : {}),
      knowledge: knowledge[agent.key]?.length ?? 0,
      edits: edited.length,
      ...(history.length ? { version: Math.max(...keys.map((key) => live(file, key)?.v ?? 0)) } : {}),
      history,
    };
  });
  const tools = toolSpecs.map((tool) => {
    const version = live(file, `tool:${tool.name}`);
    return { name: tool.name, label: tool.label, kind: tool.kind, ...(tool.source ? { source: dataSource(tool.source) } : {}), agents: tool.agents,
      description: repo.tools[tool.name] ?? tool.description, default: tool.description, custom: !!version && version.value !== null,
      ...(version ? { version: version.v } : {}), param: tool.param };
  });
  return {
    file: feedbackDisplayPath(agentRepoPath()), agents, tools, knowledge, sources: dataSources, catalog: dataCatalog,
    limits: { knowledgeChars: MAX_KNOWLEDGE_CHARS, knowledgeDoc: MAX_KNOWLEDGE_DOC, promptLength: MAX_PROMPT_LENGTH, toolDescription: MAX_TOOL_DESCRIPTION },
  };
}

/** The agent repo for the admin view. */
export async function GET(request: Request): Promise<Response> {
  try {
    await assistantCaller(request, "admin");
    return jsonResponse(await overview(await readRepo()));
  } catch (error) {
    return failed(error);
  }
}

const putSchema = z.object({
  changes: z.array(z.object({ key: z.string().min(5).max(120), value: z.unknown() }).strict()).min(1).max(12),
  note: z.string().trim().max(200).optional(),
}).strict();

/** Saves new versions (a prompt, an agent's model and limits, a tool description, a knowledge document); `null` puts the code default back. */
export async function PUT(request: Request): Promise<Response> {
  try {
    const user = await assistantCaller(request, "admin-write", "agent-repo");
    const parsed = putSchema.safeParse(await readJsonBody(request, 64 * 1024));
    if (!parsed.success) return jsonResponse({ error: "Ungültige Anfrage." }, 400);
    const file = await saveRepo(parsed.data.changes.map((change) => ({ key: change.key as RepoKey, value: change.value })),
      { by: user?.username ?? "Admin", ...(parsed.data.note ? { note: parsed.data.note } : {}) });
    return jsonResponse(await overview(file));
  } catch (error) {
    return failed(error);
  }
}

const postSchema = z.object({ reset: z.string().refine(isAgentKey) }).strict();

/** "Alles auf Code zurücksetzen" for one agent; the history keeps every version. */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await assistantCaller(request, "admin-write", "agent-repo");
    const parsed = postSchema.safeParse(await readJsonBody(request, 4 * 1024));
    if (!parsed.success || !isAgentKey(parsed.data.reset)) return jsonResponse({ error: "Ungültige Anfrage." }, 400);
    const file = await resetAgent(parsed.data.reset as AgentKey, { by: user?.username ?? "Admin" });
    return jsonResponse(await overview(file));
  } catch (error) {
    return failed(error);
  }
}