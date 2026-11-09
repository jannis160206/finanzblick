// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoryDonut } from "@/components/category-donut";
import { ChartDataTable } from "@/components/chart-data-table";
import { groupSpending, shareLabel } from "@/lib/spending-groups";

vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
vi.mock("recharts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("recharts")>()),
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
afterEach(cleanup);

const names = ["Lebensmittel", "Miete", "Auto", "Freizeit", "Shopping", "Gesundheit", "Haustier", "Kaffee"];
const rows = names.map((name, index) => ({ name, value: (names.length - index) * 10 }));

describe("groupSpending", () => {
  it("keeps the largest categories and bundles the rest with shares that add up", () => {
    const groups = groupSpending(rows, 5);
    expect(groups.top.map((slice) => slice.name)).toEqual(names.slice(0, 5));
    expect(groups.rest.map((slice) => slice.name)).toEqual(names.slice(5));
    expect(groups.restValue).toBe(60);
    expect(groups.total).toBe(360);
    expect(groups.top.reduce((sum, slice) => sum + slice.share, 0) + groups.restShare).toBeCloseTo(1, 10);
  });
  it("does not hide a single leftover category behind 'Sonstige'", () => {
    expect(groupSpending(rows.slice(0, 6), 5).rest).toEqual([]);
    expect(groupSpending(rows.slice(0, 6), 5).top).toHaveLength(6);
  });
  it("ignores refunds and handles empty input", () => {
    expect(groupSpending([{ name: "Erstattung", value: -5 }]).total).toBe(0);
    expect(groupSpending([]).top).toEqual([]);
  });
  it("formats shares", () => {
    expect(shareLabel(0.456)).toBe("46 %");
    expect(shareLabel(0.004)).toBe("< 1 %");
    expect(shareLabel(0)).toBe("0 %");
  });
});

describe("CategoryDonut", () => {
  it("shows five categories plus an expandable 'Sonstige'", () => {
    render(<CategoryDonut spending={rows} />);
    const legend = screen.getByRole("list", { name: "Kategorien mit Anteil" });
    expect(within(legend).getAllByRole("listitem")).toHaveLength(6);
    expect(within(legend).getByText("Sonstige")).toBeTruthy();
    expect(within(legend).queryByText("Haustier")).toBeNull();
    const toggle = screen.getByRole("button", { name: /Sonstige anzeigen \(3\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Kaffee")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("omits the disclosure when everything fits", () => {
    render(<CategoryDonut spending={rows.slice(0, 3)} />);
    expect(screen.queryByRole("button", { name: /Sonstige/ })).toBeNull();
  });
});

describe("ChartDataTable", () => {
  it("renders a collapsed, labelled table", () => {
    const { container } = render(<ChartDataTable caption="Test" columns={["Monat", "Wert"]} rows={[{ key: "a", cells: ["Jan", "1 €"] }]} />);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(screen.getByRole("columnheader", { name: "Wert" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "Jan" })).toBeTruthy();
  });
});
