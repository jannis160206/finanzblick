export const ASK_ASSISTANT_EVENT = "finanzblick:ask-assistant";
export const CLOSE_ASSISTANT_EVENT = "finanzblick:close-assistant";

export type AssistantRequestDetail = {
  text: string;
  /** Send the question right away instead of leaving it in the input. */
  send?: boolean;
  /** The proactive hint the question came from. */
  insightId?: string;
};

export function assistantRequest(detail: unknown): AssistantRequestDetail {
  if (typeof detail === "string") return { text: detail };
  if (detail && typeof detail === "object" && "text" in detail && typeof detail.text === "string") {
    const value = detail as AssistantRequestDetail;
    return { text: value.text, ...(value.send ? { send: true } : {}), ...(typeof value.insightId === "string" ? { insightId: value.insightId } : {}) };
  }
  return { text: "" };
}

// Opens the floating assistant from anywhere, optionally with a prepared question; the plain string form still works.
export function askAssistant(question: string | AssistantRequestDetail = "") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string | AssistantRequestDetail>(ASK_ASSISTANT_EVENT, { detail: question }));
}

export function closeAssistant() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(CLOSE_ASSISTANT_EVENT));
}
