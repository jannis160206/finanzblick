// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Dialog } from "radix-ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatEmptyState, ComposerButton, createLiveRun, LiveAnswer, MessageActions } from "@/components/assistant-chat-parts";
import { AnswerDetails } from "@/components/assistant-details";
import { statusFor, workStatus } from "@/lib/assistant/status";

// jsdom has no canvas; the orb and the bots simply draw nothing.
beforeEach(() => { vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null); });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps one button that sends and, while an answer is running, stops it", () => {
  const onStop = vi.fn();
  const { rerender } = render(<form><ComposerButton busy={false} disabled={false} onStop={onStop} /></form>);
  const send = screen.getByRole("button", { name: "Senden" });
  expect(send.getAttribute("type")).toBe("submit");
  rerender(<form><ComposerButton busy disabled onStop={onStop} /></form>);
  const stop = screen.getByRole("button", { name: "Antwort stoppen" });
  expect(stop).toBe(send);
  expect(stop.getAttribute("type")).toBe("button");
  expect(stop.hasAttribute("disabled")).toBe(false);
  fireEvent.click(stop);
  expect(onStop).toHaveBeenCalledOnce();
});

it("copies an answer and confirms it for screen readers", async () => {
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
  const onRegenerate = vi.fn();
  render(<MessageActions text="Im November hast du 412 € ausgegeben." disabled={false} onRegenerate={onRegenerate} />);
  fireEvent.click(screen.getByRole("button", { name: "Antwort kopieren" }));
  expect((await screen.findByRole("status")).textContent).toBe("Kopiert");
  expect(writeText).toHaveBeenCalledWith("Im November hast du 412 € ausgegeben.");
  fireEvent.click(screen.getByRole("button", { name: "Neu generieren" }));
  expect(onRegenerate).toHaveBeenCalledOnce();
});

it("saves a rating at once, opens the comment field after 👎 and sends the comment with Enter", async () => {
  const onFeedback = vi.fn();
  const onComment = vi.fn();
  const onCommenting = vi.fn();
  const props = { text: "Antwort", disabled: false, onFeedback, onComment, onCommenting };
  const { rerender } = render(<MessageActions {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Nicht hilfreich – mit Kommentar" }));
  expect(onFeedback).toHaveBeenCalledWith("down");
  rerender(<MessageActions {...props} feedback="down" commenting />);
  expect(screen.getByRole("button", { name: "Als nicht hilfreich bewertet" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("Feedback gespeichert")).toBeTruthy();
  const field = screen.getByRole("textbox", { name: /Was war nicht gut\?/ });
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect(screen.getByRole("button", { name: "Senden" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(field, { target: { value: "  Die Summe stimmt nicht  " } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onComment).toHaveBeenCalledWith("Die Summe stimmt nicht");
  expect(onCommenting).toHaveBeenLastCalledWith(false);
});

it("offers an optional comment after 👍 and closes the field with Escape", () => {
  const onCommenting = vi.fn();
  const onComment = vi.fn();
  const { rerender } = render(<MessageActions text="Antwort" disabled={false} feedback="up" onFeedback={vi.fn()} onComment={onComment} onCommenting={onCommenting} />);
  expect(screen.getByRole("button", { name: "Als hilfreich bewertet" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Kommentar hinzufügen/ }));
  expect(onCommenting).toHaveBeenCalledWith(true);
  rerender(<MessageActions text="Antwort" disabled={false} feedback="up" commenting onFeedback={vi.fn()} onComment={onComment} onCommenting={onCommenting} />);
  fireEvent.keyDown(screen.getByRole("textbox", { name: /Was war gut\?/ }), { key: "Escape" });
  expect(onCommenting).toHaveBeenLastCalledWith(false);
  expect(onComment).not.toHaveBeenCalled();
});

it("closes only the comment field on Escape, not the assistant dialog around it", () => {
  const onOpenChange = vi.fn();
  const onCommenting = vi.fn();
  render(<Dialog.Root open onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Content aria-describedby={undefined}><Dialog.Title>Finanz-Assistent</Dialog.Title>
    <MessageActions text="Antwort" disabled={false} feedback="down" commenting onFeedback={vi.fn()} onComment={vi.fn()} onCommenting={onCommenting} />
  </Dialog.Content></Dialog.Portal></Dialog.Root>);
  fireEvent.keyDown(screen.getByRole("textbox", { name: /Was war nicht gut\?/ }), { key: "Escape" });
  expect(onCommenting).toHaveBeenLastCalledWith(false);
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("greets with the droid alone and offers starter questions", () => {
  const onPick = vi.fn();
  const { container } = render(<ChatEmptyState prompts={[{ text: "Zeige mir meine Verträge" }, { text: "Wie viel ist noch frei?" }]} disabled={false} onPick={onPick} />);
  expect(screen.getByRole("heading", { name: "Wobei kann ich dir helfen?" })).toBeTruthy();
  // One bot only, the droid; which specialist works on an answer stays internal.
  expect([...container.querySelectorAll("[data-bot-avatar]")].map((bot) => bot.getAttribute("data-bot-avatar"))).toEqual(["droid"]);
  expect(screen.getByRole("img", { name: "Finanz-Assistent" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Wie viel ist noch frei?" }));
  expect(onPick).toHaveBeenCalledWith("Wie viel ist noch frei?");
});

it("shows only the thinking orb and a word or two while an answer is worked on, then the words in a plain bubble", async () => {
  const live = createLiveRun();
  live.setStatus(workStatus.knowledge);
  const { container } = render(<LiveAnswer live={live} />);
  expect(container.querySelector("[data-status-line]")?.textContent).toBe("Suche…");
  expect(container.querySelector("[data-status-line]")?.getAttribute("data-activity")).toBe("searching");
  // One canvas: the orb in the avatar's place; the bot only appears once the answer is done. No card, no tools, no model.
  const canvases = container.querySelectorAll("canvas");
  expect(canvases).toHaveLength(1);
  expect(canvases[0].closest("[data-orb]")?.getAttribute("data-orb")).toBe("searching");
  act(() => live.setStatus(statusFor("forecast", "budget")));
  expect(container.querySelector("[data-status-line]")?.textContent).toBe("Rechne…");
  act(() => live.setStatus({ ...workStatus.think, agent: "payroll" }));
  expect(container.querySelector("[data-status-line]")?.textContent).toBe("Denke nach…");
  act(() => live.setStatus(workStatus.web));
  expect(container.querySelector("[data-status-line]")?.textContent).toBe("Suche im Web…");
  act(() => live.setStatus({ ...workStatus.answer, agent: "budget" }));
  live.setText("Bis Monatsende");
  live.setText("Bis Monatsende sind 412 € frei");
  expect(await screen.findByText("frei")).toBeTruthy();
  // Once words stream, only they show; the status line is gone.
  expect(container.querySelector("[data-status-line]")).toBeNull();
  expect(container.querySelector("[data-orb]")?.getAttribute("data-orb")).toBe("composing");
  // The specialist at work stays internal: no agent name, no tool, no model in the chat.
  expect(container.textContent).not.toMatch(/Budget & Prognose|Kontoprognose|DeepSeek|Werkzeug/);
});

it("keeps how an answer came about behind a small closed Details link: models, compact tool lines, a shortened prompt", () => {
  render(<AnswerDetails source="KI" prompt="Du bist Finanzblick und kennst Monatsplan, Konten und Sparziele des Nutzers."
    models={[{ provider: "deepseek", model: "deepseek-flash", task: "supervise" }, { provider: "deepseek", model: "deepseek-v4-pro", task: "synthesize" }]}
    calls={[{ tool: "query", ok: true, summary: "Ausgaben & Einnahmen", args: "Wie viel für Essen im Oktober?", result: "Essen im Oktober: 312 €" },
      { tool: "web", ok: false, summary: "Websuche", args: "Bitcoin Kurs" }]} />);
  const toggle = screen.getByRole("button", { name: "Details" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.getAttribute("title")).toBe("DeepSeek V4 Pro");
  expect(screen.queryByText(/Du bist Finanzblick/)).toBeNull();
  expect(screen.queryByText(/Ausgaben & Einnahmen/)).toBeNull();
  fireEvent.click(toggle);
  const panel = within(screen.getByRole("region", { name: "Details zur Antwort" }));
  expect(panel.getByText(/^Modelle:/).closest("p")?.textContent).toBe("Modelle: DeepSeek Flash (Supervisor) · DeepSeek V4 Pro (Supervisor-Antwort)");
  const [query, web] = within(panel.getByRole("list", { name: "Werkzeuge" })).getAllByRole("listitem");
  expect(query.textContent).toBe("Ausgaben & Einnahmen (erfolgreich) · Wie viel für Essen im Oktober?");
  expect(web.textContent).toBe("Websuche (Fehler) · Bitcoin Kurs");
  // The result only on click; a call without a result is no button.
  expect(panel.queryByText("Essen im Oktober: 312 €")).toBeNull();
  expect(within(web).queryByRole("button")).toBeNull();
  fireEvent.click(within(query).getByRole("button"));
  expect(panel.getByText("Essen im Oktober: 312 €")).toBeTruthy();
  // The prompt is clamped to two lines until it is asked for in full.
  expect(panel.getByText(/^Du bist Finanzblick/).className).toContain("line-clamp-2");
  fireEvent.click(panel.getByRole("button", { name: "Ganzen Prompt zeigen" }));
  expect(panel.getByText(/^Du bist Finanzblick/).tagName).toBe("PRE");
});

it("marks a fallback to the local model with a small dot and says why", () => {
  render(<AnswerDetails source="KI" models={[{ provider: "local", model: "OpenVINO/Qwen3-8B-int4-cw-ov", task: "synthesize", fallback: true, reason: "Rate-Limit (HTTP 429)" }]} />);
  const toggle = screen.getByRole("button", { name: "Details (lokales Modell)" });
  expect(toggle.getAttribute("title")).toBe("DeepSeek nicht verfügbar (Rate-Limit (HTTP 429)) – das lokale Modell hat geantwortet");
});

it("draws streamed words at most once per frame and clears at once", async () => {
  const live = createLiveRun();
  const seen: (string | undefined)[] = [];
  live.subscribe(() => seen.push(live.get().text));
  live.setText("Ein");
  live.setText("Ein Wort");
  live.setText("Ein Wort nach");
  await waitFor(() => expect(seen).toEqual(["Ein Wort nach"]));
  live.setText(undefined);
  expect(seen).toEqual(["Ein Wort nach", undefined]);
});
