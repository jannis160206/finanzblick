// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { PayrollFocusCard } from "@/components/payroll-focus";
import { PayrollTaxes } from "@/components/payroll-taxes";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import { currency } from "@/lib/format";
import type { Payslip } from "@/lib/payslip-schema";
import type { AppState } from "@/lib/types";

vi.mock("@/lib/import/payslip", () => ({ parsePayslipPdf: vi.fn(), PayslipPasswordError: class extends Error {} }));
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(cleanup);
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const july: Payslip = {
  year: 2026, month: 7, employer: "Musterbetrieb GmbH", regularGross: 4000, specialGross: 0,
  regularSv: 720, regularTax: 500, netPay: 2700, baseSalary: 3000, monthlyPayroll: true,
};
const money = (value: number) => currency(value).replace(/\s/g, " ");
const segments = (region: HTMLElement) =>
  [...region.querySelectorAll<HTMLElement>("[data-segment]")].map((node) => [node.dataset.segment, node.style.width]);

it("shows net prominently, the gross split with shares and a labelled four-part bar", () => {
  render(<PayrollFocusCard entry={july} payslips={[july]} />);
  const region = screen.getByRole("region", { name: "Gehalt Juli 2026" });
  const card = within(region);
  expect(card.getByText(money(2700))).toBeTruthy();
  for (const [label, amount, share] of [["Brutto", 4000, undefined], ["Lohnsteuer", 500, /^12,5\s%$/], ["Sozialversicherung", 720, /^18\s%$/]] as const) {
    const figure = card.getByText(label, { selector: "dt, dt > span" }).closest("dt")!.parentElement!;
    expect(within(figure).getByText(money(amount))).toBeTruthy();
    if (share) expect(within(figure).getByText(share)).toBeTruthy();
  }
  expect(segments(region)).toEqual([["net", "67.5%"], ["tax", "12.5%"], ["sv", "18%"], ["other", "2%"]]);
  const bar = region.querySelector<HTMLElement>("[data-payroll-bar]")!;
  expect(bar.className).toContain("origin-left");
  expect(bar.className).toContain("motion-safe:animate-bar-grow");
  expect(bar.closest("[aria-hidden='true']")).toBeTruthy();
  const legend = within(card.getByRole("list", { name: "Aufteilung des Bruttos" }));
  expect(legend.getAllByRole("listitem").map((item) => item.textContent?.replace(/\s/g, " "))).toEqual([
    "Netto67,5 %", "Lohnsteuer12,5 %", "Sozialversicherung18 %", `Sonstige Abzüge${money(80)} · 2 %`,
  ]);
  expect(card.getByRole("button", { name: "Info: Sonstige Abzüge" })).toBeTruthy();
  expect(card.queryByRole("list", { name: "Vergleich" })).toBeNull();
});

it("shows missing payslip values as such instead of zero and omits other deductions", () => {
  render(<PayrollFocusCard entry={{ ...july, netPay: undefined, regularTax: undefined }} payslips={[]} />);
  const region = screen.getByRole("region", { name: "Gehalt Juli 2026" });
  const card = within(region);
  expect(card.getAllByText("nicht auf der Abrechnung")).toHaveLength(4);
  expect(card.queryByText(money(0))).toBeNull();
  expect(card.queryByText("Sonstige Abzüge")).toBeNull();
  expect(segments(region)).toEqual([["sv", "18%"]]);
  const legend = within(card.getByRole("list", { name: "Aufteilung des Bruttos" }));
  expect(legend.getAllByRole("listitem")).toHaveLength(3);
  expect(legend.getByText("Netto").parentElement?.textContent).toBe("Nettonicht auf der Abrechnung");
});

it("compares with the previous available month and the same month of the previous year", () => {
  const june = { ...july, month: 6, netPay: 2648 };
  const { unmount } = render(<PayrollFocusCard entry={july} payslips={[june, july]} />);
  const chips = within(screen.getByRole("list", { name: "Vergleich" }));
  expect(chips.getByText(`+${money(52)} zum Vormonat`)).toBeTruthy();
  expect(chips.queryByText(/Vorjahresmonat/)).toBeNull();
  unmount();

  const may = { ...july, month: 5, netPay: 2750 };
  const july2027 = { ...july, year: 2027 as const };
  const { unmount: unmountGap } = render(<PayrollFocusCard entry={july} payslips={[may, july]} />);
  expect(screen.getByText(`−${money(50)} zu Mai 2026`)).toBeTruthy();
  unmountGap();

  render(<PayrollFocusCard entry={july2027} payslips={[july, july2027]} />);
  const yearChips = within(screen.getByRole("list", { name: "Vergleich" }));
  expect(yearChips.getAllByRole("listitem")).toHaveLength(1);
  expect(yearChips.getByText("unverändert zum Vorjahresmonat")).toBeTruthy();
});

it("falls back to a gross comparison when a month has no printed net", () => {
  render(<PayrollFocusCard entry={july} payslips={[{ ...july, month: 6, regularGross: 3900, netPay: undefined }, july]} />);
  expect(screen.getByText(`+${money(100)} Brutto zum Vormonat`)).toBeTruthy();
});

it("splits a special-payment month into running and special parts", () => {
  const june: Payslip = { ...july, month: 6, specialGross: 3000, specialSv: 512.1, netPay: 5100 };
  render(<PayrollFocusCard entry={june} payslips={[june]} />);
  const parts = within(screen.getByRole("list", { name: "Laufend und Sonderzahlung" }));
  const [regular, special] = parts.getAllByRole("listitem");
  expect(regular.textContent?.replace(/\s/g, " ")).toBe(`LaufendBrutto ${money(4000)}Lohnsteuer ${money(500)}SV ${money(720)}`);
  expect(special.textContent?.replace(/\s/g, " ")).toBe(`SonderzahlungBrutto ${money(3000)}Lohnsteuer nicht auf der AbrechnungSV ${money(512.1)}`);
  expect(screen.getByText(/· ohne Sonderzahlung$/)).toBeTruthy();
  expect(screen.queryByText("Sonstige Abzüge")).toBeNull();
});

function Fixture({ payslips }: { payslips: Payslip[] }) {
  const [state] = useState<AppState>(() => {
    const seed = createSeed();
    seed.settings.asOf = "2026-09-18";
    return { ...seed, payslips };
  });
  vi.mocked(useFinance).mockReturnValue({
    state, get dashboard(): never { throw new Error("Payroll must not use dashboard data"); },
    update: vi.fn(), replace: vi.fn(), openReviewCount: 0, ready: true, saved: true, storageError: null,
    retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return <PayrollTaxes />;
}

it("defaults to the latest payslip and switches the focus month with buttons and the month select", () => {
  const payslips = [3, 6, 7].map((month) => ({ ...july, month, netPay: 2600 + month * 10 }));
  render(<Fixture payslips={[...payslips, { ...july, year: 2027, month: 2 }]} />);
  const select = screen.getByLabelText("Monat");
  expect(screen.getByRole("region", { name: "Gehalt Juli 2026" })).toBeTruthy();
  expect(select.textContent).toBe("Juli, zur Prüfung");
  fireEvent.click(select);
  const imported = screen.getAllByRole("option").filter((option) => option.getAttribute("aria-disabled") !== "true");
  expect(imported.map((option) => option.textContent)).toEqual(["März, zur Prüfung", "Juni, zur Prüfung", "Juli, zur Prüfung"]);
  fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Nächster Monat" }).disabled).toBe(true);
  expect(screen.getByText(`+${money(10)} zum Vormonat`)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Vorheriger Monat" }));
  expect(screen.getByRole("region", { name: "Gehalt Juni 2026" })).toBeTruthy();
  expect(screen.getByText(`+${money(30)} zu März 2026`)).toBeTruthy();

  fireEvent.click(screen.getByLabelText("Monat"));
  fireEvent.click(screen.getByRole("option", { name: "März, zur Prüfung" }));
  expect(screen.getByRole("region", { name: "Gehalt März 2026" })).toBeTruthy();
  expect(screen.getByLabelText("Monat").textContent).toBe("März, zur Prüfung");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Vorheriger Monat" }).disabled).toBe(true);
  expect(screen.queryByRole("list", { name: "Vergleich" })).toBeNull();

  fireEvent.change(screen.getByLabelText("Steuerjahr"), { target: { value: "2027" } });
  expect(screen.getByRole("region", { name: "Gehalt Februar 2027" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Steuerjahr"), { target: { value: "2026" } });
  expect(screen.getByRole("region", { name: "Gehalt Juli 2026" })).toBeTruthy();
});

it("keeps the coverage details reachable behind a compact chip", async () => {
  render(<Fixture payslips={[3, 6, 7].map((month) => ({ ...july, month }))} />);
  const status = screen.getByRole("status");
  const chip = within(status).getByRole("button", { name: /4 Monate fehlen/ });
  expect(status.textContent).toContain("Fehlende Abrechnung: Jänner 2026, Februar 2026, April 2026, Mai 2026.");
  fireEvent.click(chip);
  const popover = await screen.findByRole("dialog");
  expect(popover.textContent).toContain("Fehlende Abrechnung: Jänner 2026, Februar 2026, April 2026, Mai 2026.");
});
