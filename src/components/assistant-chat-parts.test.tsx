// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatEmptyState, ComposerButton, MessageActions, StatusLine } from "@/components/assistant-chat-parts";
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

it("shows what the assistant is doing with a thinking orb that matches the work", () => {
  const { container } = render(<StatusLine status={workStatus.knowledge} />);
  expect(screen.getByText("Suche passendes Wissen…")).toBeTruthy();
  const line = container.querySelector("[data-status-line]");
  expect(line?.getAttribute("data-activity")).toBe("searching");
  expect(line?.querySelector("canvas")?.getAttribute("aria-hidden")).toBe("true");
});
