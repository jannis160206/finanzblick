// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PayslipLogSettings } from "@/components/payslip-log-settings";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import type { PayslipLogEntry } from "@/lib/payslip-log";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const at = (iso: string) => new Date(iso).getTime();
const entries: PayslipLogEntry[] = [
  {
    at: at("2026-11-10T18:30:00"), source: "upload", message: "1 Abrechnung(en) automatisch übernommen.",
    files: [{ name: "Oktober.pdf", outcome: "imported" }],
    income: [{ payroll: "2026-10", month: "2026-11", net: 2500, special: 300 }],
    validation: [{ period: "2026-10", employer: "Musterbetrieb GmbH", consistent: false, held: true, checks: [] }],
  },
  {
    at: at("2026-11-11T09:56:00"), source: "budget", message: "Budget aus Abrechnungen aktualisiert · 3 Werte (Dez. 2026 – März 2027).",
    budget: { applied: 1, changes: [{ row: "Gehalt", month: "2027-03", from: 2400, to: 2500, reason: "Prognose" }] },
  },
  {
    at: at("2026-11-11T10:44:00"), source: "drive-background",
    message: "Google Drive im Hintergrund: 3 übernommen, 0 warten, 0 übersprungen, 1 fehlgeschlagen.",
    files: [
      { name: "Abrechnung 1.pdf", outcome: "imported", note: "Als Referenz übernommen – nicht im Budget." },
      { name: "Abrechnung 2.pdf", outcome: "imported" },
      { name: "Abrechnung 3.pdf", outcome: "failed", note: "Nicht vollständig erkannt." },
      { name: "Abrechnung 4.pdf", outcome: "imported" },
    ],
  },
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T12:00:00"));
  localStorage.setItem("finanzblick.payslip-log", JSON.stringify(entries));
  vi.mocked(useFinance).mockReturnValue({
    state: createSeed(), dashboard: undefined as never, update: vi.fn(), replace: vi.fn(), openReviewCount: 0, ready: true,
    saved: true, storageError: null, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

it("groups runs by day with a plain summary and one clear status, files folded away", async () => {
  render(<PayslipLogSettings />);
  const today = within(await screen.findByRole("region", { name: "Heute" }));
  const [drive, budget] = today.getAllByRole("listitem").filter((item) => item.parentElement?.parentElement?.tagName === "SECTION");
  expect(within(drive).getByText("Google Drive · automatisch")).toBeTruthy();
  expect(drive.textContent).toContain("10:44 · 3 übernommen · 1 fehlgeschlagen");
  expect(within(drive).getByText("Teilweise")).toBeTruthy();
  const details = drive.querySelector("details")!;
  expect(details.open).toBe(false);
  expect(within(drive).getByText("4 Dateien")).toBeTruthy();
  // The failed file comes first, with what went wrong.
  expect(details.querySelector("ul li")?.textContent).toBe("Abrechnung 3.pdffehlgeschlagen: Nicht vollständig erkannt.");
  expect(budget.textContent).toContain("09:56 · 3 Werte übernommen (Dez. 2026 – März 2027).");
  expect(within(budget).getByText("Aktualisiert")).toBeTruthy();
  const yesterday = within(screen.getByRole("region", { name: "Gestern" }));
  expect(yesterday.getByText(/1 übernommen · 1 zur Prüfung/)).toBeTruthy();
  expect(yesterday.getByText("Zur Prüfung")).toBeTruthy();
  // Amounts and months only inside the folded details.
  expect(yesterday.getByText("Details")).toBeTruthy();
  expect(yesterday.getByText("Abrechnung Okt. 2026 → Nov. 2026").nextElementSibling?.textContent).toMatch(/^2\.500,00\s€ · davon Sonderzahlung 300,00\s€$/);
  expect(within(budget).getByText("Gehalt · März 2027")).toBeTruthy();
  expect(screen.queryByText(/im Hintergrund: 3 übernommen, 0 warten/)).toBeNull();
  expect(screen.getByRole("switch", { name: "Unbekannte Begriffe online nachschlagen" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /JSON herunterladen/ })).toBeTruthy();
});
