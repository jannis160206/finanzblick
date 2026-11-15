import { defaultPrompts, type PromptId, type PromptOverrides } from "@/lib/ai/agent-prompts";
import { activeRepo, AgentRepoFileError, agentRepoPath, readRepo, repoLive, saveRepo, type SaveMeta } from "./agent-repo-store";

/**
 * The prompts of the agent repo for callers that only need prompts (the local answer path, the review agent). Every save is a
 * new version in the repo; saving the default text or nothing puts the code default back.
 */

export { AgentRepoFileError as AgentPromptsFileError };
export const agentPromptsPath = agentRepoPath;

/** The edited prompts. A damaged repo throws, so it is never replaced. */
export async function readPromptOverrides(path = agentRepoPath()): Promise<PromptOverrides> {
  return repoLive(await readRepo(path)).prompts;
}

/** Saves one prompt as a new version, or puts the code default back with `undefined` (or the unchanged default). */
export async function savePrompt(id: PromptId, text: string | undefined, path = agentRepoPath(), meta: SaveMeta = { by: "Admin" }): Promise<PromptOverrides> {
  const value = text?.trim();
  const file = await saveRepo([{ key: `prompt:${id}`, value: !value || value === defaultPrompts[id] ? null : value }], meta, path);
  return repoLive(file).prompts;
}

/** The prompts for the next chat run; missing or damaged: the code defaults. */
export async function activePrompts(path = agentRepoPath()): Promise<PromptOverrides> {
  return (await activeRepo(path)).prompts;
}
