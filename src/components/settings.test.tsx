// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Settings } from "./settings";
import { InteractionSoundsProvider } from "./interaction-sounds";
import { useFinance } from "./finance-provider";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import type { AppState } from "@/lib/types";

const seasonal = vi.hoisted(() => ({ setPreview: vi.fn(), setTestTheme: vi.fn() }));
vi.mock("./finance-provider", () => ({ useFinance: vi.fn(), useFinanceRestoration: () => vi.fn() }));
vi.mock("./seasonal-theme-provider", () => ({ useSeasonalTheme: () => ({ ...seasonal, testTheme: null }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount() {
  const initial = createEmptyAccountState();
  initial.settings.asOf = "2026-10-07";
  let current = initial;
  function Harness() {
    const [state, setState] = useState(initial);
    current = state;
    vi.mocked(useFinance).mockReturnValue({
      state, dashboard: calculateDashboard(state), update: setState, replace: setState,
      ready: true, saved: true, storageError: null, openReviewCount: 0,
      retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
    });
    return <InteractionSoundsProvider><Settings /></InteractionSoundsProvider>;
  }
  render(<Harness />);
  return (): AppState => current;
}

it("keeps each redesigned setting grouped under its accessible heading and preserves the anchors", () => {
  mount();
  for (const [title, id] of [["Erscheinungsbild", "jahreszeit"], ["Sparziele", "sparziele"], ["Trade Republic", "tr-zinsen"], ["Sicherung", "sicherung"]]) {
    expect(screen.getByRole("region", { name: title }).id).toBe(id);
  }
  expect(screen.getByRole("radiogroup", { name: "Akzentfarben" }).querySelectorAll("input")).toHaveLength(6);
  expect(screen.getByLabelText("Eigene Akzentfarbe")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Exportieren" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Wiederherstellen" })).toBeTruthy();
});

it("previews and discards appearance changes without changing the saved financial state", () => {
  const read = mount();
  const before = structuredClone(read());
  fireEvent.click(screen.getByRole("radio", { name: "Blau" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Bewegung reduzieren" }));
  expect(seasonal.setPreview).toHaveBeenLastCalledWith(expect.objectContaining({ accentColor: "#60a5fa", reduceMotion: true }));
  expect(read()).toEqual(before);
  fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
  expect((screen.getByRole("radio", { name: "Mint" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("checkbox", { name: "Bewegung reduzieren" }) as HTMLInputElement).checked).toBe(false);
  expect(seasonal.setPreview).toHaveBeenLastCalledWith(null);
  expect(read()).toEqual(before);
});

it("persists only the confirmed appearance preferences", () => {
  const read = mount();
  const before = structuredClone(read());
  fireEvent.click(screen.getByRole("radio", { name: "Violett" }));
  fireEvent.click(screen.getByRole("button", { name: "Einstellungen speichern" }));
  expect(read()).toEqual({ ...before, seasonalTheme: { mode: "auto", theme: "default", accentColor: "#a78bfa" } });
  expect(screen.queryByRole("button", { name: "Einstellungen speichern" })).toBeNull();
});

it("discards a Trade Republic draft and only persists an explicitly confirmed balance and rate", () => {
  const read = mount();
  const before = structuredClone(read());
  const tr = within(screen.getByRole("region", { name: "Trade Republic" }));
  fireEvent.change(tr.getByLabelText("TR Kontostand"), { target: { value: "1250" } });
  expect(read()).toEqual(before);
  fireEvent.click(tr.getByRole("button", { name: "Abbrechen" }));
  expect((tr.getByLabelText("TR Kontostand") as HTMLInputElement).value).toBe("0");
  fireEvent.change(tr.getByLabelText("TR Kontostand"), { target: { value: "1250" } });
  fireEvent.change(tr.getByLabelText("Zinssatz p.a."), { target: { value: "2.5" } });
  fireEvent.click(tr.getByRole("button", { name: "Trade Republic speichern" }));
  expect(read().trBalances).toEqual([{ date: "2026-10-07", balance: 1250 }]);
  expect(read().settings.interestRates).toContainEqual({ date: "2026-10-07", rate: 0.025 });
  expect(read().settings.balances).toEqual(before.settings.balances);
  expect(read().financeRows).toEqual(before.financeRows);
  expect(read().savingsGoals).toEqual(before.savingsGoals);
});

it("keeps invalid or future-dated Trade Republic drafts unsaved", () => {
  const read = mount();
  const before = structuredClone(read());
  const tr = within(screen.getByRole("region", { name: "Trade Republic" }));
  fireEvent.change(tr.getByLabelText("TR Standdatum"), { target: { value: "2026-10-08" } });
  expect((tr.getByRole("button", { name: "Trade Republic speichern" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(tr.getByLabelText("TR Standdatum"), { target: { value: "2026-10-07" } });
  fireEvent.change(tr.getByLabelText("Zinssatz p.a."), { target: { value: "101" } });
  expect((tr.getByRole("button", { name: "Trade Republic speichern" }) as HTMLButtonElement).disabled).toBe(true);
  expect(read()).toEqual(before);
});

it("keeps seasonal preview temporary and clears it when the preview closes", () => {
  const read = mount();
  const before = structuredClone(read());
  fireEvent.change(screen.getByLabelText("Saisonvorschau"), { target: { value: "christmas" } });
  expect(seasonal.setTestTheme).toHaveBeenLastCalledWith("christmas");
  const details = screen.getByText("Saisonvorschau").closest("details")!;
  details.open = false;
  fireEvent(details, new Event("toggle"));
  expect(seasonal.setTestTheme).toHaveBeenLastCalledWith(null);
  expect(read()).toEqual(before);
});
