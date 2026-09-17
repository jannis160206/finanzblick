// @vitest-environment jsdom
import { cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNativeSelectBoundary } from "./use-native-select-boundary";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mount(supported = true) {
  vi.stubGlobal("CSS", { supports: vi.fn(() => supported) });
  function Harness() {
    useNativeSelectBoundary();
    return <><select aria-label="Picker"><optgroup label="Group"><option>Choice</option></optgroup></select><div>Outside</div></>;
  }
  const view = render(<Harness />);
  const select = view.getByLabelText("Picker") as HTMLSelectElement;
  const matches = vi.spyOn(select, "matches").mockReturnValue(true);
  return { ...view, select, matches };
}

function reachesDocument(target: Element, type: string) {
  const listener = vi.fn();
  document.addEventListener(type, listener);
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
  target.dispatchEvent(event);
  document.removeEventListener(type, listener);
  expect(event.defaultPrevented).toBe(false);
  return listener.mock.calls.length > 0;
}

describe("native select event boundary", () => {
  it.each(["wheel", "touchmove"])("isolates native picker %s without cancelling its default scrolling", (type) => {
    const { select } = mount();
    for (const target of [select, select.querySelector("optgroup")!, select.querySelector("option")!]) {
      expect(reachesDocument(target, type)).toBe(false);
    }
  });

  it.each(["wheel", "touchmove"])("leaves %s outside the picker and on closed selects to modal scroll locking", (type) => {
    const { select, matches, getByText } = mount();
    expect(reachesDocument(getByText("Outside"), type)).toBe(true);
    matches.mockReturnValue(false);
    expect(reachesDocument(select, type)).toBe(true);
  });

  it("does not change scrolling in browsers without customizable native pickers", () => {
    const { select } = mount(false);
    expect(reachesDocument(select, "wheel")).toBe(true);
    expect(reachesDocument(select, "touchmove")).toBe(true);
  });

  it("removes its listeners on unmount", () => {
    const { unmount } = mount();
    const remove = vi.spyOn(window, "removeEventListener");
    unmount();
    for (const type of ["wheel", "touchmove", "keydown"]) {
      expect(remove).toHaveBeenCalledWith(type, expect.any(Function), true);
    }
  });

  it("shares one listener set between category lists and dialogs until the last unmount", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { select, unmount } = mount();
    const second = renderHook(() => useNativeSelectBoundary());
    for (const type of ["wheel", "touchmove", "keydown"]) {
      expect(add.mock.calls.filter(([event]) => event === type)).toHaveLength(1);
    }
    second.unmount();
    expect(remove.mock.calls.filter(([event]) => event === "wheel")).toHaveLength(0);
    expect(reachesDocument(select, "wheel")).toBe(false);
    unmount();
    expect(remove.mock.calls.filter(([event]) => event === "wheel")).toHaveLength(1);
  });
});
