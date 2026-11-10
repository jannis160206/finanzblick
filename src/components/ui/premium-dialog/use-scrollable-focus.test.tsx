// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useScrollableFocus } from "./use-scrollable-focus";

let notify: (() => void) | undefined;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { notify = callback; }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); notify = undefined; });

function Body() {
  const ref = useRef<HTMLDivElement>(null);
  const focus = useScrollableFocus(ref);
  return <div ref={ref} data-testid="body" tabIndex={focus.tabIndex} className={focus.className} />;
}

function size(node: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(node, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(node, "clientHeight", { configurable: true, value: clientHeight });
}

it("makes the body a tab stop only while its content overflows", () => {
  render(<Body />);
  const body = screen.getByTestId("body");
  size(body, 400, 400);
  act(() => notify?.());
  expect(body.hasAttribute("tabindex")).toBe(false);
  size(body, 900, 400);
  act(() => notify?.());
  expect(body.getAttribute("tabindex")).toBe("0");
  expect(body.className).toContain("focus-visible:outline-ring");
  size(body, 380, 400);
  act(() => notify?.());
  expect(body.hasAttribute("tabindex")).toBe(false);
});
