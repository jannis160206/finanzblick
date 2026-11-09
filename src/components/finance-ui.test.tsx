// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MoneyInput, PageHeading } from "./finance-ui";

afterEach(() => { cleanup(); delete document.documentElement.dataset.securityMode; });

it("omits unnecessary page descriptions without leaving an empty paragraph", () => {
  const { container } = render(<PageHeading title="Einstellungen" />);
  expect(screen.getByRole("heading", { name: "Einstellungen" })).toBeTruthy();
  expect(container.querySelectorAll("p")).toHaveLength(0);
});

it("keeps useful context and page actions when provided", () => {
  render(<PageHeading title="Umsätze" description="12 Buchungen">
    <button>Importieren</button>
  </PageHeading>);
  expect(screen.getByText("12 Buchungen")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Importieren" })).toBeTruthy();
});

it("keeps a money draft uncommitted when privacy locking removes focus", () => {
  const commit = vi.fn();
  render(<MoneyInput value={100} onCommit={commit} label="Planbetrag" />);
  const input = screen.getByRole("textbox", { name: "Planbetrag" });
  fireEvent.change(input, { target: { value: "125,50" } });
  document.documentElement.dataset.securityMode = "locked";
  fireEvent.blur(input);
  expect(commit).not.toHaveBeenCalled();
  expect(input.getAttribute("value")).toBe("125,50");
  document.documentElement.dataset.securityMode = "open";
  fireEvent.blur(input);
  expect(commit).toHaveBeenCalledExactlyOnceWith(125.5);
});

it.each([
  ["1.500", 1500],
  ["1.500,5", 1500.5],
  ["1,5", 1.5],
])("commits %s as %s euros", (text, value) => {
  const commit = vi.fn();
  render(<MoneyInput value={100} onCommit={commit} label="Planbetrag" />);
  const input = screen.getByRole("textbox", { name: "Planbetrag" });
  fireEvent.change(input, { target: { value: text } });
  fireEvent.blur(input);
  expect(commit).toHaveBeenCalledExactlyOnceWith(value);
  expect(input.getAttribute("aria-invalid")).toBe("false");
});

it("keeps an invalid draft in the field with a linked visible error", () => {
  const commit = vi.fn();
  render(<MoneyInput value={100} onCommit={commit} label="Planbetrag" />);
  const input = screen.getByRole("textbox", { name: "Planbetrag" });
  fireEvent.change(input, { target: { value: "abc" } });
  fireEvent.blur(input);
  expect(commit).not.toHaveBeenCalled();
  expect(input.getAttribute("value")).toBe("abc");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.hasAttribute("title")).toBe(false);
  const message = screen.getByRole("alert");
  expect(message.textContent).toContain("Ungültiger Betrag");
  expect(input.getAttribute("aria-describedby")).toBe(message.id);
  fireEvent.change(input, { target: { value: "12" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(input.hasAttribute("aria-describedby")).toBe(false);
});

it("explains amounts below the minimum and lets Escape discard the draft", () => {
  const commit = vi.fn();
  render(<MoneyInput value={100} onCommit={commit} label="Planbetrag" min={10} />);
  const input = screen.getByRole("textbox", { name: "Planbetrag" });
  fireEvent.change(input, { target: { value: "5" } });
  fireEvent.blur(input);
  expect(screen.getByRole("alert").textContent).toContain("Mindestens 10,00");
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(input.getAttribute("value")).toBe("100,00");
});
