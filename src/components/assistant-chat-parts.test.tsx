// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Dialog } from "radix-ui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatEmptyState, ComposerButton, createLiveRun, LiveAnswer, MessageActions } from "@/components/assistant-chat-parts";
import { workStatus } from "@/lib/assistant/status";

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

it("greets with the orchestrator and its specialists and offers starter questions", () => {
  const onPick = vi.fn();
  render(<ChatEmptyState prompts={[{ text: "Zeige mir meine Verträge", agent: "contracts" }, { text: "Wie viel ist noch frei?", agent: "budget" }]}
    disabled={false} onPick={onPick} />);
  expect(screen.getByRole("heading", { name: "Wobei kann ich dir helfen?" })).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Dein Assistenten-Team" })).getAllByRole("img").map((bot) => bot.getAttribute("aria-label")))
    .toEqual(["Umsätze", "Verträge", "Orchestrator", "Budget & Prognose", "Gehalt & Steuern"]);
  fireEvent.click(screen.getByRole("button", { name: "Wie viel ist noch frei?" }));
  expect(onPick).toHaveBeenCalledWith("Wie viel ist noch frei?");
});

it("shows only the thinking orb and the current step while an answer is worked on", async () => {
  const live = createLiveRun();
  live.setStatus(workStatus.knowledge);
  const { container } = render(<LiveAnswer live={live} />);
  expect(screen.getByText("Suche passendes Wissen…")).toBeTruthy();
  expect(container.querySelector("[data-status-line]")?.getAttribute("data-activity")).toBe("searching");
  // One canvas: the orb in the avatar's place; the bot only appears once the answer is done.
  const canvases = container.querySelectorAll("canvas");
  expect(canvases).toHaveLength(1);
  expect(canvases[0].closest("[data-orb]")?.getAttribute("data-orb")).toBe("searching");
  act(() => live.setStatus({ ...workStatus.answer, agent: "budget" }));
  live.setText("Bis Monatsende");
  live.setText("Bis Monatsende sind 412 € frei");
  expect(await screen.findByText("frei")).toBeTruthy();
  expect(container.querySelector("[data-orb]")?.getAttribute("data-orb")).toBe("composing");
  expect(screen.getByText("Budget & Prognose · KI")).toBeTruthy();
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
