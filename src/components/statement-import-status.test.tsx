// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { StatementImportStatus } from "@/components/statement-import-status";

afterEach(cleanup);
const screenshotIssue =
  "WhatsApp Image 2026-10-06 at 09.43.24 (5).jpeg, Zeile 5: Amex-Screenshot: Betrag prüfen.";

it("keeps counts separate and discloses the unchanged screenshot details only on demand", () => {
  const issues = [screenshotIssue];
  render(
    <StatementImportStatus imported={351} reviewCount={370} issues={issues} />,
  );
  const region = within(screen.getByRole("region", { name: "Importstatus" }));
  expect(region.getByText("351")).toBeTruthy();
  expect(region.getByText("370")).toBeTruthy();
  const toggle = region.getByRole("button", { name: "Importhinweise" });
  expect(toggle.textContent).toContain("1 Hinweis");
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(region.queryByRole("list")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const hints = region.getByRole("list", { name: "Importhinweise" });
  expect(toggle.getAttribute("aria-controls")).toBe(hints.id);
  expect(within(hints).getByText("Betrag prüfen.")).toBeTruthy();
  expect(within(hints).getByText("Amex-Screenshot")).toBeTruthy();
  expect(within(hints).getByText("Zeile 5")).toBeTruthy();
  expect(
    within(hints).getByText("WhatsApp Image 2026-10-06 at 09.43.24 (5).jpeg"),
  ).toBeTruthy();
  fireEvent.click(toggle);
  expect(region.queryByRole("list")).toBeNull();
  expect(issues).toEqual([screenshotIssue]);
});

it("shows every duplicate and unfamiliar warning without losing text or punctuation", () => {
  const issues = [
    "Report: 2026, revised.PDF, Zeile 42: Spalten fehlen: Datum, Betrag.",
    "Ältere Meldung ohne Dateiformat: nichts entfernen.",
    screenshotIssue,
    screenshotIssue,
  ];
  render(
    <StatementImportStatus imported={0} reviewCount={1234} issues={issues} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Importhinweise" }));
  const hints = within(screen.getByRole("list", { name: "Importhinweise" }));
  expect(hints.getAllByRole("listitem")).toHaveLength(4);
  expect(hints.getByText("Report: 2026, revised.PDF")).toBeTruthy();
  expect(hints.getByText("Spalten fehlen: Datum, Betrag.")).toBeTruthy();
  expect(hints.getByText("Zeile 42")).toBeTruthy();
  expect(hints.getByText(issues[1])).toBeTruthy();
  expect(hints.getAllByText("Betrag prüfen.")).toHaveLength(2);
  expect(
    screen.getByRole("button", { name: "Importhinweise" }).textContent,
  ).toContain("4 Hinweise");
});

it("omits the disclosure when there are no hints without hiding import or review counts", () => {
  const view = render(
    <StatementImportStatus imported={0} reviewCount={0} issues={[]} />,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getAllByText("0")).toHaveLength(2);
  view.rerender(
    <StatementImportStatus
      imported={2}
      reviewCount={3}
      issues={[screenshotIssue]}
    />,
  );
  expect(
    screen
      .getByRole("button", { name: "Importhinweise" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(screen.queryByRole("list")).toBeNull();
});
