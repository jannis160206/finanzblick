export const ASK_ASSISTANT_EVENT = "finanzblick:ask-assistant";

// Opens the floating assistant from anywhere, optionally with a prepared question.
export function askAssistant(question = "") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(ASK_ASSISTANT_EVENT, { detail: question }));
}
