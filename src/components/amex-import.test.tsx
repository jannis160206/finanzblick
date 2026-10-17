// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StatementImport } from "./statement-import";
import { useFinance } from "./finance-provider";
import { createSeed } from "@/lib/seed";
import { parseAmexScreenshotLines, type ScreenshotLine } from "@/lib/import/amex-screenshot";
import { prepareStatementImport } from "@/lib/import/review";
import { parseStatementFile } from "@/lib/import/statements";
import { toast } from "sonner";

vi.mock("./finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/import/statements", async (original) => ({ ...await original<object>(), parseStatementFile: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const line = (text: string, y: number, x = 30): ScreenshotLine =>
  ({ text, confidence: 95, bbox: { x0: x, x1: x + 150, y0: y, y1: y + 20 } });
const setup = () => {
  const state = createSeed();
  const appendStatements = vi.fn();
  const finance = { state, ready: true, storageError: null, appendStatements, openReviewCount: 0 };
  vi.mocked(useFinance).mockReturnValue(finance as unknown as ReturnType<typeof useFinance>);
  return { state, finance, appendStatements };
};
it("accepts screenshots through the existing statement input without a second uploader", async () => {
  vi.useFakeTimers();
  const { appendStatements } = setup();
  const parsed = parseAmexScreenshotLines([
    line("01.09.2026 - Aktuell", 50), line("Kartennummer -12345", 80),
    line("SPAR", 140), line("4 Okt 2026", 170), line("€ 14,56", 155, 500),
  ]);
  vi.mocked(parseStatementFile).mockResolvedValueOnce(parsed);
  render(<StatementImport />);
  expect(screen.getByText("CSV, Excel, PDF oder Amex-Screenshot · max. 20 MB")).toBeTruthy();
  const input = screen.getByLabelText<HTMLInputElement>("Kontoauszüge auswählen");
  expect(input.accept).toContain(".jpeg");
  expect(input.accept).toContain(".pdf");
  await act(async () => { fireEvent.change(input, { target: { files: [new File(["pixels"], "Amex.jpeg", { type: "image/jpeg" })] } }); });
  act(() => { vi.advanceTimersByTime(1); });
  expect(appendStatements).toHaveBeenCalledOnce();
  expect(appendStatements.mock.calls[0][0][0]).toMatchObject({ amount: -14.56, bank: "Amex", pocket: "Amex", category: "Lebensmittel" });
});
it("keeps unreadable screenshot facts in the existing popup and allows correction before saving", () => {
  vi.useFakeTimers();
  const { state, finance, appendStatements } = setup();
  const parsed = parseAmexScreenshotLines([
    line("01.09.2026 - Aktuell", 50), line("Kartennummer -12345", 80),
    line("SPAR", 140), line("€ ???", 155, 500),
  ]);
  state.reviewQueue = prepareStatementImport([parsed], state).review;
  finance.openReviewCount = state.reviewQueue.length;
  const view = render(<StatementImport />);
  view.rerender(<StatementImport reviewRequest={1} />);
  const section = screen.getByLabelText("Buchung prüfen: SPAR");
  const save = within(section).getByRole<HTMLButtonElement>("button", { name: "Zuordnung übernehmen" });
  expect(save.disabled).toBe(true);
  expect(within(section).getByLabelText<HTMLInputElement>("Datum").readOnly).toBe(false);
  fireEvent.change(within(section).getByLabelText("Datum"), { target: { value: "2026-10-04" } });
  fireEvent.change(within(section).getByLabelText("Betrag"), { target: { value: "-14,56" } });
  fireEvent.change(within(section).getByLabelText("Kategorie"), { target: { value: "Lebensmittel" } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  act(() => { vi.advanceTimersByTime(1); });
  expect(appendStatements.mock.calls[0][0][0]).toMatchObject({ date: "2026-10-04", amount: -14.56, description: "SPAR" });
});
it("summarizes multiple OCR warnings without hiding their review drafts or details", async () => {
  vi.useFakeTimers();
  const { appendStatements } = setup();
  const parsed = parseAmexScreenshotLines([
    line("01.09.2026 - Aktuell", 50), line("Kartennummer -12345", 80),
    line("SPAR", 140), line("€ ???", 155, 500),
    line("BILLA", 260), line("€ ???", 275, 500),
  ]);
  expect(parsed.issues).toHaveLength(2);
  vi.mocked(parseStatementFile).mockResolvedValueOnce(parsed);
  render(<StatementImport />);
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Kontoauszüge auswählen"), {
      target: { files: [new File(["pixels"], "Amex.jpeg", { type: "image/jpeg" })] },
    });
  });
  expect(toast.error).toHaveBeenCalledWith("2 Importhinweise – Details im Uploadstatus.");
  act(() => { vi.advanceTimersByTime(1); });
  const metadata = appendStatements.mock.calls[0][4];
  expect(metadata.reviewQueue).toHaveLength(2);
  expect(metadata.issues).toHaveLength(2);
});
