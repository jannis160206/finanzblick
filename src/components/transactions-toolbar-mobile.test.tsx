// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TransactionToolbar } from "./transaction-workspace";
import { categoryTone } from "./category-tone";

vi.mock("./security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
afterEach(cleanup);

it("collapses the basic filters behind a mobile toggle that reports active filters", () => {
  const remove = vi.fn();
  render(<TransactionToolbar
    search={<input aria-label="Suche" />}
    filters={<select aria-label="Monat filtern"><option>Sep. 2026</option></select>}
    actions={<button type="button">Prüfen</button>}
    chips={[{ id: "query", label: "Suche: Billa", remove }]}
  />);
  const toggle = screen.getByRole("button", { expanded: false });
  const region = document.getElementById(toggle.getAttribute("aria-controls")!)!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.textContent).toContain("1");
  expect(region.className).toContain("max-md:hidden");
  expect(within(region).getByLabelText("Monat filtern")).toBeTruthy();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(region.className).not.toContain("max-md:hidden");
  fireEvent.click(screen.getByRole("button", { name: "Filter entfernen: Suche: Billa" }));
  expect(remove).toHaveBeenCalledOnce();
});

it("colours categories by their group, including legacy aliases", () => {
  expect(categoryTone("Lebensmittel")).toBe("bg-chart-2");
  expect(categoryTone("Gehalt")).toBe("bg-success");
  expect(categoryTone("Spotify")).toBe(categoryTone("Abonnements"));
  expect(categoryTone("Prüfen")).toBe("bg-muted-foreground/60");
});
