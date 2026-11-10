// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import SavingsGoalWizard from "./savings-goal-wizard";
import { calculateDashboard, monthsForYear } from "@/lib/calc";
import { GOAL_SURPLUS } from "@/lib/goals";
import { createSeed } from "@/lib/seed";
import { emptyPockets, type AppState, type SavingsGoal } from "@/lib/types";
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

function open(state = fixture()) {
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

  it("keeps the reserve and the savings rate out of the plan and stores both when they change", async () => {
    const { onSave, dialog } = open();
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Reise" } });
    fireEvent.change(dialog.getByLabelText("Zielbetrag"), { target: { value: "2000" } });
    fireEvent.click(dialog.getByRole("switch", { name: /So schnell wie möglich/ }));
    for (const step of ["Startkapital", "Konten", "Verteilung"]) {
      fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
      await screen.findByRole("group", { name: step });
    }
    const plan = screen.getByRole("group", { name: "Verteilung" });
    const november = () => (within(plan).getByLabelText("Betrag November 2026, Girokonto") as HTMLInputElement).value;
    expect((within(plan).getByLabelText("Reserve") as HTMLSelectElement).value).toBe("15");
    expect((within(plan).getByLabelText("Sparanteil") as HTMLSelectElement).value).toBe("10");
    expect(november()).toBe("697,00");
    fireEvent.change(within(plan).getByLabelText("Reserve"), { target: { value: "0" } });
    expect(november()).toBe("820,00");
    fireEvent.change(within(plan).getByLabelText("Sparanteil"), { target: { value: "50" } });
    expect(november()).toBe("500,00");
    expect(screen.getByText(/Ziel erreicht voraussichtlich im/).textContent).toContain("Februar 2027");
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
    await screen.findByRole("group", { name: "Übersicht" });
    fireEvent.click(dialog.getByRole("button", { name: "Sparziel anlegen" }));
    expect(onSave.mock.calls[0][0]).toMatchObject({ goal: { asap: true, date: "2027-02-28" }, settings: { asapReserve: 0, savingsRate: 0.5 } });
  });

  it("offers the Sparkonto and Trade Republic once above the keep amount and uses Trade Republic last and as late as possible", async () => {
    const state = fixture();
    state.trBalances = [{ date: "2026-11-01", balance: 5000 }];
    state.settings.emergencyTarget = 1000;
    const { onSave, dialog } = open(state);
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Auto" } });
    fireEvent.change(dialog.getByLabelText("Zielbetrag"), { target: { value: "9000" } });
    fireEvent.change(dialog.getByLabelText("Zieldatum"), { target: { value: "2027-03-31" } });
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
    await screen.findByRole("group", { name: "Startkapital" });
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
    const sources = await screen.findByRole("group", { name: "Konten" });
    expect(within(sources).queryByText(/Kontoregel/)).toBeNull();
    expect(within(sources).queryByRole("switch")).toBeNull();
    expect(within(sources).getAllByRole("checkbox").map((box) => box.closest("li")?.textContent?.match(/Girokonto|Sparkonto|Trade Republic/)?.[0]))
      .toEqual(["Girokonto", "Sparkonto", "Trade Republic"]);
    expect(within(sources).queryByLabelText(/Behalten auf Girokonto/)).toBeNull();
    expect((within(sources).getByLabelText("Behalten auf Sparkonto") as HTMLInputElement).value).toBe("0,00");
    const tr = within(within(sources).getByText("Trade Republic · Notgroschen").closest("li") as HTMLElement);
    const keep = tr.getByLabelText("Behalten auf Trade Republic · Notgroschen") as HTMLInputElement;
    expect(keep.value).toBe("1.000,00");
    expect(tr.getByText(/^Saldo 5\.000,00\s€$/)).toBeTruthy();
    expect(tr.getByText(/^4\.000,00\s€$/)).toBeTruthy();
    fireEvent.change(keep, { target: { value: "1500" } });
    expect(tr.getByText(/^3\.500,00\s€$/)).toBeTruthy();
    fireEvent.click(tr.getByRole("checkbox"));
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));

    const plan = await screen.findByRole("group", { name: "Verteilung" });
    expect(within(plan).queryByLabelText("Reserve")).toBeNull();
    expect((within(plan).getByLabelText("Betrag März 2027, Trade Republic") as HTMLInputElement).value).toBe("3.500,00");
    expect(within(plan).getByText(/bis dahin laufen die Zinsen weiter/)).toBeTruthy();
    fireEvent.change(within(plan).getByLabelText("Monat Trade Republic"), { target: { value: "2027-01" } });
    expect(within(plan).getByText(/weniger Zinsen als zum Zieltermin/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
    const overview = await screen.findByRole("group", { name: "Übersicht" });
    expect(within(overview).getByText(/^Trade Republic/)).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Sparziel anlegen" }));

    const { goal, settings } = onSave.mock.calls[0][0];
    expect(goal.funding.exceptions).toEqual([{ account: "Notgroschen" }]);
    expect(goal.funding.plan).toContainEqual({ month: "2027-01", account: "Notgroschen", amount: 3500, locked: true });
    expect(goal.funding.excluded.accounts).toEqual(["Sparkonto"]);
    expect(settings).toEqual({ accountKeep: { Notgroschen: 1500 } });
  });

  it("leaves Trade Republic and the Sparkonto out unless they are chosen", async () => {
    const state = fixture();
    state.trBalances = [{ date: "2026-11-01", balance: 5000 }];
    const { onSave, dialog } = open(state);
    fireEvent.change(dialog.getByLabelText("Name"), { target: { value: "Auto" } });
    fireEvent.change(dialog.getByLabelText("Zielbetrag"), { target: { value: "9000" } });
    fireEvent.change(dialog.getByLabelText("Zieldatum"), { target: { value: "2027-03-31" } });
    for (const step of ["Startkapital", "Konten", "Verteilung", "Übersicht"]) {
      fireEvent.click(dialog.getByRole("button", { name: "Weiter" }));
      await screen.findByRole("group", { name: step });
    }
    fireEvent.click(dialog.getByRole("button", { name: "Sparziel anlegen" }));
    const { goal, settings } = onSave.mock.calls[0][0];
    expect(goal.funding.exceptions).toBeUndefined();
    expect(goal.funding.excluded.accounts).toEqual(["Sparkonto", "Notgroschen"]);
    expect(goal.funding.plan.some((row: { account: string }) => row.account !== GOAL_SURPLUS)).toBe(false);
    expect(settings).toBeUndefined();
  });

  it("keeps Trade Republic chosen for a goal saved with the earlier exception and its minimum as keep amount", async () => {
    const state = fixture();
    state.trBalances = [{ date: "2026-11-01", balance: 5000 }];
    const goal: SavingsGoal = {
      id: "auto", name: "Auto", pocket: "Auto", target: 9000, date: "2027-03-31",
      funding: { monthly: 820, extras: {}, auto: true, window: { from: "2026-11", to: "2027-03" },
        plan: [{ month: "2026-11", account: GOAL_SURPLUS, amount: 820 }], exceptions: [{ account: "Notgroschen", keep: 2500 }] },
    };
    const onSave = vi.fn();
    render(<SavingsGoalWizard open isNew={false} goal={goal} goals={[goal]} state={state} dashboard={calculateDashboard(state)}
      disabled={false} storageError={null} onClose={vi.fn()} onSave={onSave} />);
    const dialog = within(screen.getByRole("dialog", { name: "Sparziel bearbeiten" }));
    fireEvent.click(dialog.getByRole("button", { name: /3\. Konten/ }));
    const sources = await screen.findByRole("group", { name: "Konten" });
    const tr = within(within(sources).getByText("Trade Republic · Notgroschen").closest("li") as HTMLElement);
    expect((tr.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect((tr.getByLabelText("Behalten auf Trade Republic · Notgroschen") as HTMLInputElement).value).toBe("2.500,00");
    expect((within(sources).getByRole("checkbox", { name: /Sparkonto/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(dialog.getByRole("button", { name: "Speichern" }));
    expect(onSave.mock.calls[0][0].settings).toEqual({ accountKeep: { Notgroschen: 2500 } });
    expect(onSave.mock.calls[0][0].goal.funding.exceptions).toEqual([{ account: "Notgroschen" }]);
  });
});