// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ErrorPage from "./error";

afterEach(cleanup);

it("keeps the error boundary a client component", () => {
  const source = readFileSync(new NodeURL("./error.tsx", import.meta.url), "utf8");
  expect(source.trimStart().startsWith('"use client";')).toBe(true);
});

it("renders the existing recovery message and retries when requested", () => {
  const reset = vi.fn();
  render(<ErrorPage reset={reset} />);

  expect(screen.getByRole("alert").textContent).toContain("Gespeicherte Finanzdaten bleiben erhalten.");
  expect(screen.getByRole("heading").textContent).toBe("Ansicht konnte nicht geladen werden");
  expect(reset).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
  expect(reset).toHaveBeenCalledOnce();
});
