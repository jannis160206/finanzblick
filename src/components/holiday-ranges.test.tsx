// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HolidayRanges } from "./holiday-ranges";
import { useFinance } from "./finance-provider";
import { createSeed } from "@/lib/seed";
import type { AppState } from "@/lib/types";

vi.mock("./finance-provider", () => ({ useFinance: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("shows saved dates only inside the holiday popup without changing their storage or controls", () => {
  const initial: AppState = { ...createSeed(), holidayRanges: [
    { from: "2026-09-24", to: "2026-10-01" },
    { from: "2026-04-18", to: "2026-04-29" },
    { from: "2026-07-03", to: "2026-07-11" },
  ] };
  let current = initial;
  function Harness() {
    const [state, update] = useState(initial);
    current = state;
    vi.mocked(useFinance).mockReturnValue({
      state, update, storageError: null,
    } as ReturnType<typeof useFinance>);
    return <HolidayRanges />;
  }
  render(<Harness />);
  expect(screen.queryByLabelText("Aktive Urlaubszeiträume")).toBeNull();
  expect(screen.queryByText("24.9.2026–1.10.2026")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Urlaub" }));
  let dialog = within(screen.getByRole("dialog"));
  for (const text of ["24.9.2026–1.10.2026", "18.4.2026–29.4.2026", "3.7.2026–11.7.2026"])
    expect(dialog.getByText(text)).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Fertig" }));
  expect(screen.queryByLabelText("Aktive Urlaubszeiträume")).toBeNull();
  expect(current.holidayRanges).toEqual(initial.holidayRanges);
  fireEvent.click(screen.getByRole("button", { name: "Urlaub" }));
  dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Urlaub löschen: 2026-07-03 bis 2026-07-11" }));
  expect(current.holidayRanges).toHaveLength(2);
  fireEvent.change(dialog.getByLabelText("Von"), { target: { value: "2027-03-01" } });
  fireEvent.change(dialog.getByLabelText("Bis"), { target: { value: "2027-03-05" } });
  fireEvent.click(dialog.getByRole("button", { name: "Zeitraum speichern" }));
  expect(current.holidayRanges?.at(-1)).toEqual({ from: "2027-03-01", to: "2027-03-05" });
  fireEvent.click(dialog.getByRole("button", { name: "Fertig" }));
  expect(screen.queryByLabelText("Aktive Urlaubszeiträume")).toBeNull();
  expect(screen.queryByText("1.3.2027–5.3.2027")).toBeNull();
});
