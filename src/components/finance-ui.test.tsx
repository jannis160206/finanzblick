// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MoneyInput, PageHeading } from "./finance-ui";

afterEach(() => { cleanup(); delete document.documentElement.dataset.securityMode; });

it("omits unnecessary page descriptions without leaving an empty paragraph", () => {
  const { container } = render(<PageHeading eyebrow="KONFIGURATION" title="Einstellungen" />);
  expect(screen.getByRole("heading", { name: "Einstellungen" })).toBeTruthy();
  expect(container.querySelectorAll("p")).toHaveLength(1);
});

it("keeps useful context and page actions when provided", () => {
  render(<PageHeading eyebrow="BUCHUNGEN" title="Umsätze" description="12 Buchungen">
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
