// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanzblickMark } from "./seasonal-icons";
import { SeasonalScene } from "./seasonal-scene";

const state = vi.hoisted(() => ({ theme: "default", motionReduced: false, pathname: "/" }));
vi.mock("./seasonal-theme-provider", () => ({ useSeasonalTheme: () => state }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  Object.assign(state, { theme: "default", motionReduced: false, pathname: "/" });
});

it("shows only the plain mark in the standard theme", () => {
  const { container } = render(<FinanzblickMark flicker />);
  expect(container.querySelector("[data-logo-state=standard]")).toBeTruthy();
  expect(container.querySelector(".logo-motif")).toBeNull();
  expect(container.querySelector(".logo-season-detail")).toBeNull();
});

it("lays the season motif over the mark and flickers only when asked and allowed", () => {
  state.theme = "halloween";
  const { container, rerender } = render(<FinanzblickMark flicker />);
  expect(container.querySelector("[data-logo-state=seasonal]")).toBeTruthy();
  expect(container.querySelector(".logo-motif")?.getAttribute("data-flicker")).toBe("true");
  expect(container.querySelector(".logo-motif svg")).toBeTruthy();
  rerender(<FinanzblickMark />);
  expect(container.querySelector(".logo-motif")?.getAttribute("data-flicker")).toBe("false");
  state.motionReduced = true;
  rerender(<FinanzblickMark flicker />);
  expect(container.querySelector(".logo-motif")?.getAttribute("data-flicker")).toBe("false");
});

it("renders an inert, hidden canvas for scene themes", () => {
  state.theme = "christmas";
  const { container } = render(<SeasonalScene />);
  const canvas = container.querySelector("canvas");
  expect(canvas?.getAttribute("aria-hidden")).toBe("true");
  expect(canvas?.className).toContain("season-scene");
});

it.each([
  ["standard theme", { theme: "default" }],
  ["a theme without scene", { theme: "easter" }],
  ["reduced motion", { theme: "halloween", motionReduced: true }],
  ["the transaction list", { theme: "halloween", pathname: "/umsaetze" }],
])("renders no scene for %s", (_name, patch) => {
  Object.assign(state, patch);
  const { container } = render(<SeasonalScene />);
  expect(container.querySelector("canvas")).toBeNull();
  expect(screen.queryByRole("img")).toBeNull();
});
