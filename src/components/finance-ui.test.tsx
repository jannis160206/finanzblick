// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PageHeading } from "./finance-ui";

afterEach(cleanup);

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
