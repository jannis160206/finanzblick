// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatEmptyState, ComposerButton, MessageActions, StatusLine } from "@/components/assistant-chat-parts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("turns Send into a Stop button while an answer is running", () => {
  const onStop = vi.fn();
  const { rerender } = render(<form><ComposerButton busy={false} disabled={false} onStop={onStop} /></form>);
  expect(screen.getByRole("button", { name: "Senden" }).getAttribute("type")).toBe("submit");
  rerender(<form><ComposerButton busy disabled onStop={onStop} /></form>);
  expect(screen.queryByRole("button", { name: "Senden" })).toBeNull();
  const stop = screen.getByRole("button", { name: "Antwort stoppen" });
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

it("offers starter questions and shows what the assistant is doing", () => {
  const onPick = vi.fn();
  render(<>
    <ChatEmptyState prompts={["Zeige mir meine Verträge", "Wie viel ist noch frei?"]} disabled={false} onPick={onPick} />
    <StatusLine text="Suche passendes Wissen…" />
  </>);
  expect(screen.getByRole("heading", { name: "Wobei kann ich dir helfen?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Wie viel ist noch frei?" }));
  expect(onPick).toHaveBeenCalledWith("Wie viel ist noch frei?");
  expect(screen.getByText("Suche passendes Wissen…")).toBeTruthy();
});
