// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SavingsGoalWizard from "./savings-goal-wizard";
import { calculateDashboard, monthsForYear } from "@/lib/calc";
import { GOAL_SURPLUS } from "@/lib/goals";
import { createSeed } from "@/lib/seed";
import { emptyPockets, type AppState } from "@/lib/types";
import { monthlyVariableBudget } from "@/lib/variable-budgets";

vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function fixture(): AppState {
  const state = createSeed();
  state.settings = { ...state.settings, baselineDate: "2026-11-01", asOf: "2026-11-05", balances: { ...emptyPockets(), Sparkonto: 2000 } };
  state.financeRows = [{ id: "income", label: "Gehalt", kind: "income", values: Object.fromEntries([...monthsForYear(2026), ...monthsForYear(2027)].map((month) => [month, 1000 + monthlyVariableBudget(month).total])) }];
  state.transactions = [];
  state.months = {};
  state.savingsGoals = [];
  return state;
}

function open() {
  const state = fixture();
  const onSave = vi.fn();
  render(<SavingsGoalWizard open isNew goal={{ id: "new-goal", name: "", pocket: "", target: 0, date: state.settings.asOf }} goals={[]}
    state={state} dashboard={calculateDashboard(state)} disabled={false} storageError={null} onClose={vi.fn()} onSave={onSave} />);
  return { onSave, dialog: within(screen.getByRole("dialog", { name: "Sparziel hinzufügen" })) };
}

describe("savings goal wizard", () => {
  it("plans start capital from the Sparkonto and the rest evenly, with an override and an excluded month", async () => {
    const { onSave, dialog } = open();
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Kamera" } });
    fireEvent.change(dialog.getByLabelText("Zielbetrag"), { target: { value: "1200" } });
    fireEvent.change(dialog.getByLabelText("Zieldatum"), { target: { value: "2027-04-30" } });
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));

    const start = await screen.findByRole("group", { name: "Startkapital" });
    fireEvent.change(within(start).getByLabelText(/^Startkapital/), { target: { value: "300" } });
    fireEvent.click(within(start).getByRole("radio", { name: /Vom Sparkonto/ }));
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));

    const sources = await screen.findByRole("group", { name: "Konten" });
    expect((within(sources).getByRole("checkbox", { name: /Girokonto/ }) as HTMLInputElement).checked).toBe(true);
    expect((within(sources).getByRole("checkbox", { name: /Sparkonto/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));

    const plan = await screen.findByRole("group", { name: "Verteilung" });
    expect(within(plan).getByRole("switch", { name: /Automatisch planen/ }).getAttribute("aria-checked")).toBe("true");
    expect((within(plan).getByLabelText("Betrag November 2026, Sparkonto") as HTMLInputElement).value).toBe("300,00");
    expect((within(plan).getByLabelText("Betrag Jänner 2027, Girokonto") as HTMLInputElement).value).toBe("150,00");
    const december = within(plan).getByLabelText("Betrag Dezember 2026, Girokonto");
    fireEvent.change(december, { target: { value: "0" } });
    fireEvent.blur(december);
    expect((within(plan).getByLabelText("Betrag Jänner 2027, Girokonto") as HTMLInputElement).value).toBe("180,00");
    fireEvent.click(within(plan).getByRole("button", { name: "Februar 2027 ausschließen" }));
    expect((within(plan).getByLabelText("Betrag Jänner 2027, Girokonto") as HTMLInputElement).value).toBe("225,00");
    expect(within(plan).getByRole("button", { name: "Februar 2027 wieder einplanen" })).toBeTruthy();
    expect(within(plan).getByText(/Ziel erreicht im/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));

    const overview = await screen.findByRole("group", { name: "Übersicht" });
    expect(within(overview).getByRole("img", { name: /1\.200,00\s€ von 1\.200,00\s€/ })).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Sparziel anlegen" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const { goal, opening } = onSave.mock.calls[0][0];
    expect(opening).toBe(0);
    expect(goal).toMatchObject({
      name: "Kamera", pocket: "Kamera", target: 1200, date: "2027-04-30", start: { amount: 300, account: "Sparkonto", date: "2026-11-05" },
      funding: { monthly: 225, auto: true, window: { from: "2026-11", to: "2027-04" }, excluded: { months: ["2027-02"] } },
    });
    expect(goal.funding.plan).toEqual([
      { month: "2026-11", account: GOAL_SURPLUS, amount: 225 },
      { month: "2026-11", account: "Sparkonto", amount: 300, locked: true },
      { month: "2026-12", account: GOAL_SURPLUS, amount: 0, locked: true },
      { month: "2027-01", account: GOAL_SURPLUS, amount: 225 },
      { month: "2027-03", account: GOAL_SURPLUS, amount: 225 },
      { month: "2027-04", account: GOAL_SURPLUS, amount: 225 },
    ]);
  });

  it("computes the date for as soon as possible", async () => {
    const { onSave, dialog } = open();
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Reise" } });
    fireEvent.change(dialog.getByLabelText("Zielbetrag"), { target: { value: "2000" } });
    fireEvent.click(dialog.getByRole("switch", { name: /So schnell wie möglich/ }));
    expect(dialog.queryByLabelText("Zieldatum")).toBeNull();
    for (const step of ["Startkapital", "Konten", "Verteilung"]) {
      fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
      await screen.findByRole("group", { name: step });
    }
    expect(screen.getByText(/Ziel erreicht voraussichtlich im/).textContent).toContain("Jänner 2027");
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
    await screen.findByRole("group", { name: "Übersicht" });
    fireEvent.click(dialog.getByRole("button", { name: "Sparziel anlegen" }));
    expect(onSave.mock.calls[0][0].goal).toMatchObject({ asap: true, date: "2027-01-31", funding: { window: { from: "2026-11", to: "2027-01" } } });
  });

  it("asks for a unique name, an amount and a date before moving on", async () => {
    const { onSave, dialog } = open();
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Sparkonto" } });
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
    expect(await dialog.findByText(/eindeutigen Zielnamen/)).toBeTruthy();
    expect(dialog.getByText(/Betrag größer als 0/)).toBeTruthy();
    expect(dialog.getByText(/gültiges Zieldatum/)).toBeTruthy();
    expect(screen.getByRole("group", { name: "Ziel" })).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });
});
