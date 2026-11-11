// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PayrollModelSettings } from "@/components/payroll-model-settings";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);

let latest: AppState;
function Fixture() {
  const [state, setState] = useState(() => {
    const seed = createSeed();
    seed.settings.asOf = "2026-11-10";
    return seed;
  });
  useEffect(() => { latest = state; }, [state]);
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: undefined as never, update: (updater) => setState((current) => appStateSchema.parse(updater(current))),
    replace: vi.fn(), openReviewCount: 0, ready: true, saved: true, storageError: null,
    retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return <PayrollModelSettings />;
}

it("keeps the Successbonus at 138,5 % by default, saves a new share and names the tax logic", () => {
  render(<Fixture />);
  const input = screen.getByLabelText<HTMLInputElement>("Successbonus");
  expect(input.value).toBe("138,5");
  expect(screen.getByRole("button", { name: "Speichern" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Lohnsteuertarif AT 2026 · progressiv + Absetzbeträge")).toBeTruthy();
  expect(screen.getByText("Verkehrsabsetzbetrag · 496 € pro Jahr")).toBeTruthy();

  fireEvent.change(input, { target: { value: "abc" } });
  fireEvent.submit(input.closest("form")!);
  expect(screen.getByRole("alert").textContent).toContain("zwischen 0 und 500 %");
  expect(latest.settings.successBonusPercent).toBeUndefined();

  fireEvent.change(input, { target: { value: "120,5" } });
  fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
  expect(latest.settings.successBonusPercent).toBe(120.5);
  expect(input.value).toBe("120,5");

  fireEvent.change(input, { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
  expect(latest.settings.successBonusPercent).toBe(0);
});
