// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AmexStatementCard, AmexStatementView } from "./amex-statement-card";
import { useFinance } from "@/components/finance-provider";
import { createEmptyAccountState } from "@/lib/account-state";
import type { AmexStatement } from "@/lib/amex-statement";
import { calculateDashboard } from "@/lib/calc";
import type { Transaction } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
afterEach(cleanup);

const plain = (node: HTMLElement) => node.textContent!.replace(/\u00a0/g, " ");
const booking = (id: string, amount: number, patch: Partial<Transaction> = {}): Transaction => ({
  id, date: "2026-11-08", bank: "Amex", pocket: "AMEX Jannis", description: id, amount, category: "Shopping", includeInPlan: true, ...patch,
});

function statement(patch: Partial<AmexStatement> = {}): AmexStatement {
  return {
    cycle: { start: "2026-10-11", closing: "2026-11-10" }, status: "due", total: 3578.56, booked: 1151.43, missing: 2427.13,
    snapshotDate: "2026-11-05", partner: 280.43, hasPocket: true, pocketName: "Amex Rückzahlung", pocketBalance: 2801.35,
    nextReserved: 102.89, fromPocket: 2698.46, additional: 880.1, transferred: 0, toTransfer: 2698.46,
    expectedDebit: "2026-11-17", deadline: "2026-11-16", daysLeft: 3,
    schedule: { offsetDays: 7, basedOn: 6, recent: ["2026-09-17", "2026-10-19"] },
    rows: [
      { booking: booking("Billa", -10.83, { date: "2026-11-10" }), amount: 10.83, partner: false, reserved: true },
      { booking: booking("Kino", -15, { pocket: "AMEX Raphael" }), amount: 15, partner: true, reserved: false },
    ],
    lastDebit: { date: "2026-10-19", amount: 1446.65 },
    ...patch,
  };
}

it("shows pocket share, additional payment and the transfer deadline, with the bookings on demand", () => {
  render(<AmexStatementView statement={statement()} />);
  const card = screen.getByRole("region", { name: "Amex-Abrechnung" });
  expect(card.getAttribute("data-status")).toBe("due");
  expect(plain(card)).toContain("Buchungen 11.10.–10.11. · Abbuchung ca. Di., 17. Nov.");
  const figures = within(card).getAllByRole("definition");
  expect(within(card).getByText("Aus Amex-Rückzahlung nehmen")).toBeTruthy();
  expect(plain(figures[0])).toBe("2.698,46 €");
  expect(within(card).getByText("Zusätzlich noch zahlen")).toBeTruthy();
  expect(figures.map(plain)).toContain("880,10 €");
  expect(plain(card)).toContain("Bis Mo., 16. Nov. 2.698,46 € von Revolut „Amex Rückzahlung“ aufs Giro überweisen · in 3 Tagen");
  const toggle = within(card).getByRole("button", { name: "Details und Buchungen (2)" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(within(card).queryByText("Billa")).toBeNull();
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
  expect(plain(details)).toContain("2.427,13 € laut Amex-Saldo vom 5.11.");
  expect(plain(details)).toContain("102,89 € im Pocket gehören zu Buchungen ab dem 11.11.");
  expect(plain(details)).toContain("Amex bucht meist 7 Tage nach dem 10. ab (zuletzt 17.9. und 19.10.)");
  expect(plain(details)).toContain("1 von 2 Buchungen schon im Pocket zurückgelegt");
  const rows = within(details).getAllByRole("listitem").filter((item) => item.textContent?.includes("€") && item.querySelector("span"));
  expect(rows.some((row) => plain(row).includes("Billa") && plain(row).includes("im Pocket zurückgelegt"))).toBe(true);
  expect(rows.some((row) => plain(row).includes("Kino") && plain(row).includes("Raphael"))).toBe(true);
});

it("calms down once the pocket share is on the giro and while the statement is still running", () => {
  const { rerender } = render(<AmexStatementView statement={statement({ status: "transferred", transferred: 2698.46, transferredOn: "2026-11-12", toTransfer: 0 })} />);
  let card = screen.getByRole("region", { name: "Amex-Abrechnung" });
  expect(plain(card)).toContain("2.698,46 € am 12.11. vom Pocket aufs Giro überwiesen · 880,10 € kommen zusätzlich vom Giro.");
  rerender(<AmexStatementView statement={statement({ status: "open", cycle: { start: "2026-11-11", closing: "2026-12-10" },
    deadline: "2026-12-16", expectedDebit: "2026-12-17", daysLeft: 27 })} />);
  card = screen.getByRole("region", { name: "Amex-Abrechnung" });
  expect(card.getAttribute("data-status")).toBe("open");
  expect(plain(card)).toContain("Läuft bis 10. Dezember · Buchungen ab 11.11.");
  expect(plain(card)).toContain("Schließt am 10. Dezember – dann bis ca. Mi., 16. Dez. aufs Giro überweisen.");
});

it("asks to keep the bill on the giro when the pocket is empty and flags a missed deadline", () => {
  render(<AmexStatementView statement={statement({ fromPocket: 0, additional: 3578.56, toTransfer: 0, daysLeft: -2 })} />);
  expect(plain(screen.getByRole("region", { name: "Amex-Abrechnung" })))
    .toContain("Bis Mo., 16. Nov. 3.578,56 € auf dem Giro bereithalten · seit 2 Tagen fällig");
});

it("renders nothing without Amex data", () => {
  const state = createEmptyAccountState();
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), update: vi.fn(), replace: vi.fn(), ready: true, saved: true,
    storageError: null, openReviewCount: 0, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  const { container } = render(<AmexStatementCard />);
  expect(container.innerHTML).toBe("");
});
