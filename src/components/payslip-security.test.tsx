// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PayslipSummary } from "@/components/payslip-summary";
import { PayslipUploadButton, PayslipUploadProvider } from "@/components/payslip-upload";
import { SecurityModeProvider } from "@/components/security-mode-provider";
import { createSeed } from "@/lib/seed";
import { getSecuritySnapshot, setSecurityMode } from "@/lib/security-mode";

const pdf = vi.hoisted(() => ({
  parse: vi.fn(),
  PasswordError: class extends Error {},
}));
const update = vi.fn((updater: (state: ReturnType<typeof createSeed>) => ReturnType<typeof createSeed>) => updater(createSeed()));
vi.mock("@/lib/import/payslip", () => ({ parsePayslipPdf: pdf.parse, PayslipPasswordError: pdf.PasswordError }));
vi.mock("@/components/finance-provider", () => ({
  useFinance: () => ({ state: createSeed(), update, storageError: null }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  act(() => setSecurityMode(false));
  pdf.parse.mockResolvedValue({ drafts: [{
    year: 2026, month: 1, employer: "Musterbetrieb GmbH",
    regularGross: 3000, specialGross: 0, monthlyPayroll: true,
  }], issues: [] });
});
afterEach(cleanup);

it("keeps automatic payslip analysis open through the native Explorer focus cycle", async () => {
  render(<SecurityModeProvider>
    <PayslipUploadProvider onImported={vi.fn()}>
      <PayslipUploadButton />
      <PayslipSummary />
    </PayslipUploadProvider>
  </SecurityModeProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Abrechnungen hochladen" }));
  fireEvent(window, new Event("blur"));
  expect(getSecuritySnapshot().locked).toBe(false);

  const file = new File(["%PDF-synthetic"], "example.pdf", { type: "application/pdf" });
  const buffer = new ArrayBuffer(12);
  Object.defineProperty(file, "arrayBuffer", { value: async () => buffer });
  fireEvent.change(screen.getByLabelText("Lohnabrechnungen als PDF auswählen"), { target: { files: [file] } });
  fireEvent(window, new Event("focus"));

  expect(await screen.findByText(/automatisch übernommen/)).toBeTruthy();
  expect(pdf.parse).toHaveBeenCalledWith(buffer);
  expect(getSecuritySnapshot().locked).toBe(false);
  expect(update).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("spinbutton")).toBeNull();
  fireEvent(window, new Event("blur"));
  expect(getSecuritySnapshot().locked).toBe(true);
});
