// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FinancialData, FinancialWorkspace } from "./financial-data";

const privacy = vi.hoisted(() => ({ locked: false }));
vi.mock("./security-mode-provider", () => ({ useSecurityMode: () => privacy }));
afterEach(() => { cleanup(); privacy.locked = false; });

it("preserves data and geometry markup while excluding locked data from focus and accessibility", () => {
  const { rerender } = render(<FinancialData as="p" className="tabular-nums">123,45 €</FinancialData>);
  const value = screen.getByText("123,45 €");
  expect(value.tagName).toBe("P");
  expect(value.hasAttribute("inert")).toBe(false);
  privacy.locked = true;
  rerender(<FinancialData as="p" className="tabular-nums">123,45 €</FinancialData>);
  expect(screen.getByText("123,45 €")).toBe(value);
  expect(value.hidden).toBe(false);
  expect(value.getAttribute("aria-hidden")).toBe("true");
  expect(value.hasAttribute("inert")).toBe(true);
  privacy.locked = false;
  rerender(<FinancialData as="p" className="tabular-nums">123,45 €</FinancialData>);
  expect(value.hasAttribute("aria-hidden")).toBe(false);
  expect(value.hasAttribute("inert")).toBe(false);
});

it("keeps financial table structure valid and hides private row names from assistive technology", () => {
  privacy.locked = true;
  const { container } = render(<table><thead><tr><th>Verwendungszweck</th></tr></thead><FinancialData as="tbody"><tr><td>Privater Name</td></tr></FinancialData></table>);
  expect(screen.getByRole("columnheader", { name: "Verwendungszweck" })).toBeTruthy();
  expect(screen.queryByRole("cell", { name: "Privater Name" })).toBeNull();
  expect(container.querySelector("table > tbody > tr > td")?.textContent).toBe("Privater Name");
});

it("preserves a private workspace's accessible page title without remounting its underlying data", () => {
  privacy.locked = true;
  const { container, rerender } = render(<FinancialWorkspace title="Gehalt & Steuern"><div data-page-heading><h1>Gehalt & Steuern</h1></div><input aria-label="Privater Betrag" defaultValue="123" /></FinancialWorkspace>);
  const input = container.querySelector("input")!;
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.queryByRole("textbox")).toBeNull();
  privacy.locked = false;
  rerender(<FinancialWorkspace title="Gehalt & Steuern"><div data-page-heading><h1>Gehalt & Steuern</h1></div><input aria-label="Privater Betrag" defaultValue="123" /></FinancialWorkspace>);
  expect(screen.getByRole("textbox")).toBe(input);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(input.value).toBe("123");
});
