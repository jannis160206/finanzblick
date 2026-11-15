import { z } from "zod";
import { defaultPrompts, isPromptId, MAX_PROMPT_LENGTH, promptMeta, type PromptOverrides } from "@/lib/ai/agent-prompts";
import { AgentPromptsFileError, agentPromptsPath, readPromptOverrides, savePrompt } from "@/lib/server/agent-prompts-store";
import { assistantCaller } from "@/lib/server/assistant-access";
import { feedbackDisplayPath } from "@/lib/server/feedback-store";
import { accountErrorResponse, jsonResponse, readJsonBody } from "@/lib/server/http";

export const runtime = "nodejs";

function failed(error: unknown): Response {
  if (!(error instanceof AgentPromptsFileError)) return accountErrorResponse(error);
  console.error("Agent prompts file is damaged; it was left untouched.");
  return jsonResponse({ error: "Die Prompt-Datei ist beschädigt und wird nicht überschrieben. Bitte die Datei prüfen." }, 500);
}

const listed = (overrides: PromptOverrides) => promptMeta.map((meta) => ({
  ...meta, default: defaultPrompts[meta.id], text: overrides[meta.id] ?? defaultPrompts[meta.id], custom: overrides[meta.id] !== undefined,
}));

/** Every agent prompt with its default and the active text; admin only. */
export async function GET(request: Request): Promise<Response> {
  try {
    await assistantCaller(request, "admin");
    const path = agentPromptsPath();
    return jsonResponse({ file: feedbackDisplayPath(path), prompts: listed(await readPromptOverrides(path)) });
  } catch (error) {
    return failed(error);
  }
}

const promptId = z.string().refine(isPromptId);
const putSchema = z.union([
  z.object({ id: promptId, text: z.string().trim().min(1).max(MAX_PROMPT_LENGTH) }).strict(),
  z.object({ id: promptId, reset: z.literal(true) }).strict(),
]);

/** Saves a prompt or puts it back to the default; the next chat run uses it. Admin only. */
export async function PUT(request: Request): Promise<Response> {
  try {
    await assistantCaller(request, "admin-write", "agent-prompts");
    const parsed = putSchema.safeParse(await readJsonBody(request, 24 * 1024));
    if (!parsed.success || !isPromptId(parsed.data.id)) return jsonResponse({ error: "Ungültige Anfrage." }, 400);
    const overrides = await savePrompt(parsed.data.id, "text" in parsed.data ? parsed.data.text : undefined);
    return jsonResponse({ prompts: listed(overrides) });
  } catch (error) {
    return failed(error);
  }
}
