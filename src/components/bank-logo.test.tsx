// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { BankLogo } from "./bank-logo";

afterEach(cleanup);

const mark = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-bank-logo]")!;

describe("BankLogo", () => {
  it("shows the monogram in the bank color right away and hides it from assistive technology", () => {
    const { container } = render(<BankLogo bank="Trade Republic" />);
    const tile = mark(container);
    expect(tile.textContent).toBe("TR");
    expect(tile.getAttribute("aria-hidden")).toBe("true");
    expect(tile.style.backgroundColor).toBe("rgb(17, 17, 17)");
    expect(tile.className).toContain("text-white");
  });

  it("asks for the registry name and reveals the image only after it has loaded", () => {
    const { container } = render(<BankLogo bank="Raiffeisenbank Kärnten · Giro" country="AT" />);
    const image = container.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("/api/banks/logo?name=Raiffeisen&country=AT");
    expect(image.getAttribute("alt")).toBe("");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("decoding")).toBe("async");
    expect(image.className).toContain("opacity-0");
    expect(image.className).toContain("bg-white");
    expect(image.className).toContain("ring-black/5");
    fireEvent.load(image);
    expect(image.className).toContain("opacity-100");
    expect(mark(container).textContent).toBe("R");
  });

  it("keeps the monogram after an error and does not retry the same logo", () => {
    const first = render(<BankLogo bank="Testbank Fehlerfall" />);
    fireEvent.error(first.container.querySelector("img")!);
    expect(first.container.querySelector("img")).toBeNull();
    expect(mark(first.container).textContent).toBe("TF");
    const second = render(<BankLogo bank="Testbank Fehlerfall" size="lg" />);
    expect(second.container.querySelector("img")).toBeNull();
    expect(mark(second.container).textContent).toBe("TF");
    const other = render(<BankLogo bank="Testbank Anders" />);
    expect(other.container.querySelector("img")).not.toBeNull();
  });

  it.each([
    ["xs", "size-4", "rounded-md"],
    ["sm", "size-6", "rounded-md"],
    ["md", "size-8", "rounded-lg"],
    ["lg", "size-10", "rounded-xl"],
  ] as const)("uses the %s size", (size, box, radius) => {
    const { container } = render(<BankLogo bank="N26" size={size} className="ring-2 ring-card" />);
    const tile = mark(container);
    expect(tile.className).toContain(box);
    expect(tile.className).toContain(radius);
    expect(tile.className).toContain("ring-card");
    expect(container.querySelector("img")!.className).toContain(radius);
  });

  it("falls back to a generic bank icon without a name", () => {
    for (const bank of [null, undefined, "   "]) {
      const { container, unmount } = render(<BankLogo bank={bank} />);
      expect(container.querySelector("svg")).not.toBeNull();
      expect(container.querySelector("img")).toBeNull();
      expect(mark(container).textContent).toBe("");
      unmount();
    }
  });

  it("renders on the server without browser APIs", () => {
    const markup = renderToString(<BankLogo bank="Amex" size="md" />);
    expect(markup).toContain("AE");
    expect(markup).toContain("/api/banks/logo?name=American+Express&amp;country=AT");
    expect(markup).toContain("opacity-0");
  });
});
