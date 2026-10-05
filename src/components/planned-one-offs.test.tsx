// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlannedOneOffLines, PlannedOneOffs } from "@/components/planned-one-offs";
import { useFinance } from "@/components/finance-provider";
import { calculateDashboard, calculateMonthTotals } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { initializePlannedOneOffs } from "@/lib/planned-one-offs";
import { plannedOneOffSchema, type AppState } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function fixture(): AppState {
  const state = createSeed();
  state.settings.asOf = "2026-10-05";
  state.plannedOneOffs = [];
  const variable = calculateMonthTotals(state, "2026-10", { currentMonth: "2026-10" }).variablePlan;
  state.financeRows = [{ id: "salary", label: "Gehalt", kind: "income", values: { "2026-10": variable + 780 } }];
  return state;
}
function mount(initial = fixture()) {
  let current = initial;
  function Harness() {
    const [state, setState] = useState(initial);
    current = state;
    vi.mocked(useFinance).mockReturnValue({
      state, dashboard: calculateDashboard(state), update: setState, replace: setState,
      openReviewCount: 0, ready: true, saved: true, storageError: null, retrySave: vi.fn(), appendStatements: vi.fn(),
    });
    return <><PlannedOneOffs /><PlannedOneOffLines /></>;
  }
  render(<Harness />);
  return () => current;
}
const open = () => fireEvent.click(screen.getByRole("button", { name: "Geplante Ausgaben" }));
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("planned one-offs UI", () => {
  it("shows quiet seed halves and no unnecessary second line", () => {
    mount(initializePlannedOneOffs(fixture()));
    const lines = screen.getByLabelText("Geplante Ausgaben");
    expect(lines.textContent).toBe("Monitor-Rate 55 € · Schrank 200 € · Teppich 90 € · Vorhänge 200 € · Führerschein 780 €");
    expect(lines.querySelectorAll("p")).toHaveLength(1);
  });
  it("shows next-month items only inside 30 days and hides matched bookings", () => {
    const state = fixture();
    state.plannedOneOffs = [
      plannedOneOffSchema.parse({ id: "next", name: "Führerschein", date: "2026-11-04", amount: 780 }),
      plannedOneOffSchema.parse({ id: "later", name: "Später", date: "2026-11-05", amount: 100 }),
      plannedOneOffSchema.parse({ id: "done", name: "Bezahlt", date: "2026-10-03", amount: 20 }),
    ];
    state.transactions = [{ id: "paid", description: "Shop", date: "2026-10-04", amount: -20, bank: "Amex", pocket: "Amex", category: "Shopping", includeInPlan: false }];
    mount(state);
    expect(screen.getByLabelText("Geplante Ausgaben").textContent).toBe("Nov · Führerschein 780 €");
    expect(screen.getByLabelText("Geplante Ausgaben").textContent).not.toMatch(/Später|Bezahlt/);
    open();
    expect(screen.getByRole("button", { name: "Bearbeiten: Bezahlt" }).parentElement?.textContent).toContain("Gebucht");
  });
  it("previews while typing using the half, saves only on confirmation, then supports editing and deleting", () => {
    const read = mount();
    open();
    type("Name", "Schrank"); type("Betrag (€)", "200");
    expect(screen.getByRole("status").textContent).toBe("Danach 580 €");
    type("Betrag (€)", "900");
    expect(screen.getByRole("status").textContent).toBe("Fehlen 120 €");
    type("Betrag (€)", "400");
    fireEvent.click(screen.getByLabelText("Mit Raphael teilen"));
    expect(screen.getByRole("status").textContent).toBe("Danach 580 €");
    expect(read().plannedOneOffs).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(read().plannedOneOffs).toEqual([]);
    open(); type("Name", "Schrank"); type("Betrag (€)", "400");
    fireEvent.click(screen.getByLabelText("Mit Raphael teilen"));
    fireEvent.click(screen.getByRole("button", { name: "Ausgabe speichern" }));
    expect(read().plannedOneOffs).toHaveLength(1);
    expect(read().plannedOneOffs?.[0]).toMatchObject({ name: "Schrank", amount: 400, sharedWithRaphael: true, installments: 1, pocket: "Giro" });
    fireEvent.click(screen.getByRole("button", { name: "Bearbeiten: Schrank" }));
    expect(screen.getByRole("status").textContent).toBe("Danach 580 €");
    type("Betrag (€)", "600");
    expect(screen.getByRole("status").textContent).toBe("Danach 480 €");
    expect(read().plannedOneOffs?.[0].amount).toBe(400);
    fireEvent.click(screen.getByRole("button", { name: "Änderung speichern" }));
    expect(read().plannedOneOffs?.[0].amount).toBe(600);
    fireEvent.click(screen.getByRole("button", { name: "Löschen: Schrank" }));
    expect(read().plannedOneOffs).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Löschen bestätigen" }));
    expect(read().plannedOneOffs).toEqual([]);
  });
  it("marks only saved occurrence days in the compact grid and retains a single recurring row", () => {
    const read = mount(initializePlannedOneOffs(fixture()));
    open();
    expect(screen.getAllByRole("button", { name: / · Geplante Ausgabe$/ })).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "Bearbeiten: Monitor-Rate" }));
    expect((screen.getByLabelText("N × ab Datum") as HTMLInputElement).value).toBe("12");
    expect((screen.getByLabelText("Gesamt (€), optional") as HTMLInputElement).value).toBe("664");
    fireEvent.click(screen.getByRole("button", { name: "Änderung speichern" }));
    expect(read().plannedOneOffs).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "Nächster Monat" }));
    expect(screen.getAllByRole("button", { name: / · Geplante Ausgabe$/ })).toHaveLength(1);
  });
});
