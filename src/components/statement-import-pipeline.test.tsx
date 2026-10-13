// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { StatementImport } from "./statement-import";
import { createSeed } from "@/lib/seed";
import { parseAmexText } from "@/lib/import/amex-pdf";
import type { AppState } from "@/lib/types";
import type { ScreenshotLine } from "@/lib/import/amex-screenshot";

const ocr = vi.hoisted(() => ({ createWorker: vi.fn() }));
vi.mock("tesseract.js", () => ({ createWorker: ocr.createWorker, OEM: { LSTM_ONLY: 1 } }));
vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T10:00:00"));
  vi.stubGlobal("createImageBitmap", vi.fn().mockResolvedValue({ width: 1000, height: 2000, close: vi.fn() }));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

const line = (text: string, y: number, x = 40): ScreenshotLine =>
  ({ text, confidence: 95, bbox: { x0: x, x1: x + (x > 400 ? 130 : 280), y0: y, y1: y + 20 } });
const booking = (merchant: string, y: number, amount = "€ 12,30", date = "2 Okt 2026") =>
  [line(merchant, y), ...(date ? [line(date, y + 30)] : []), line(amount, y + 15, 500)];
function pixelWorker(bookings: ScreenshotLine[]) {
  const lines = [line("11.09.2026 - Aktuell", 50), line("Kartennummer -61002", 80), ...bookings];
  return {
    setParameters: vi.fn(), terminate: vi.fn(), reinitialize: vi.fn(),
    recognize: vi.fn(async (_image, options: { rectangle?: { top: number; left: number } }) => {
      if (!options.rectangle) return { data: { blocks: [{ paragraphs: [{ lines: structuredClone(lines) }] }] } };
      const found = lines.find((item) => item.bbox.y0 - 12 === options.rectangle!.top && item.bbox.x0 - 12 === options.rectangle!.left)!;
      return { data: { text: found.text, confidence: found.confidence } };
    }),
  };
}
function jpeg(name: string) {
  const bytes = new Uint8Array([255, 216, 255, 224]);
  const file = new File([bytes], name, { type: "image/jpeg" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes.buffer });
  return file;
}
function mount() {
  const state: AppState = { ...createSeed(), transactions: [], financeRows: [], fixedReceipts: [], reviewQueue: [],
    plannedOneOffs: [], plannedOneOffsSeeded: true };
  let current: ReturnType<typeof useFinance>;
  function Observer() {
    const value = useFinance();
    useEffect(() => { current = value; }, [value]);
    return null;
  }
  const view = render(<FinanceProvider initialState={state}><Observer /><StatementImport /></FinanceProvider>);
  return { ...view, read: () => current };
}
const persisted = (): AppState => JSON.parse(localStorage.getItem("finanzdashboard.v1")!);
async function drop(view: ReturnType<typeof mount>, bookings: ScreenshotLine[], name = "screen.jpeg") {
  await waitFor(() => expect(view.read().ready).toBe(true));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Dateien auswählen" }).disabled).toBe(false));
  const worker = pixelWorker(bookings);
  ocr.createWorker.mockResolvedValueOnce(worker);
  const previous = view.read().statementImport?.requestId;
  fireEvent.drop(screen.getByRole("region", { name: "Kontoauszüge importieren" }), { dataTransfer: { files: [jpeg(name)] } });
  await waitFor(() => {
    expect(view.read().statementImport?.requestId).toBeTruthy();
    expect(view.read().statementImport?.requestId).not.toBe(previous);
    expect(view.read().statementImport?.error).toBeUndefined();
  });
  expect(worker.terminate).toHaveBeenCalledOnce();
  return worker;
}

it("drops real JPEG Files through the provider, persists known merchants once and ignores overlap/repeat", async () => {
  const view = mount();
  const rows = [...booking("McDonalds 42 McDonalds Villach", 140), ...booking("Spar Fil. 6345 Spar Fil St. Kanzian", 260, "€ 2,48")];
  await drop(view, rows);
  const pdf = parseAmexText(["05.10.2026\nUmsatz vom Buchung am Betrag in EUR\nNeue Belastungen für HERRN JANNIS BRUEHL\n02.10 02.10 McDonalds 42 McDonalds Villach 12,30\n02.10 02.10 Spar Fil. 6345 Spar Fil St. Kanzian 2,48"]);
  expect(view.read().state.transactions.map((row) => [row.description, row.category])).toEqual(pdf.rows.map((row) => [row.description, row.category]));
  expect(view.read().state.transactions.map((row) => row.category)).toEqual(["Restaurants", "Lebensmittel"]);
  expect(view.read().openReviewCount).toBe(0);
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(persisted().transactions).toHaveLength(2));
  const ids = persisted().transactions.map((row) => row.id);
  await drop(view, [...booking("Spar Fil. 6345 Spar Fil St. Kanzian", 140, "€ 2,48"), ...booking("DM DROGERIE", 260, "€ 8,99")], "scroll.jpeg");
  await drop(view, rows, "copy.jpeg");
  await waitFor(() => expect(persisted().transactions).toHaveLength(3));
  expect(persisted().transactions.slice(0, 2).map((row) => row.id)).toEqual(ids);
  expect(view.read().statementImport?.duplicates).toBe(2);
  expect(view.read().openReviewCount).toBe(0);
});

it("saves sure rows while only the unclear merchant enters the existing persistent review modal", async () => {
  const view = mount();
  await drop(view, [...booking("SPAR", 140, "€ 14,56"), ...booking("UNBEKANNTER HANDEL XYZ", 260, "€ 27,35")]);
  expect(view.read().state.transactions.map((row) => row.description)).toEqual(["SPAR"]);
  expect(view.read().openReviewCount).toBe(1);
  const dialog = within(screen.getByRole("dialog", { name: "Kontoauszüge prüfen" }));
  expect(dialog.getAllByRole("region")).toHaveLength(1);
  expect(dialog.getByRole("region", { name: "Buchung prüfen: UNBEKANNTER HANDEL XYZ" })).toBeTruthy();
  expect(dialog.queryByRole("region", { name: "Buchung prüfen: SPAR" })).toBeNull();
  await waitFor(() => expect(persisted().reviewQueue).toHaveLength(1));
  fireEvent.change(dialog.getByLabelText("Kategorie"), { target: { value: "Shopping" } });
  fireEvent.click(dialog.getByRole("button", { name: "Zuordnung übernehmen" }));
  await waitFor(() => expect(view.read().state.transactions).toHaveLength(2));
  expect(view.read().openReviewCount).toBe(0);
  await waitFor(() => expect(persisted().transactions).toHaveLength(2));
});

it("does not autoaccept a low-confidence known-looking merchant through provider reconciliation", async () => {
  const view = mount();
  const rows = booking("SPAR", 140, "€ 14,56");
  rows[0].confidence = 12;
  await drop(view, rows);
  expect(view.read().state.transactions).toEqual([]);
  expect(view.read().openReviewCount).toBe(1);
  await waitFor(() => expect(persisted().reviewQueue).toHaveLength(1));
  const dialog = within(screen.getByRole("dialog", { name: "Kontoauszüge prüfen" }));
  expect(dialog.getByLabelText<HTMLInputElement>("Text").readOnly).toBe(false);
  fireEvent.click(dialog.getByRole("button", { name: "Zuordnung übernehmen" }));
  await waitFor(() => expect(view.read().state.transactions).toHaveLength(1));
  expect(view.read().state.transactions[0]).toMatchObject({ description: "SPAR", amount: -14.56, reviewed: true });
  expect(view.read().openReviewCount).toBe(0);
});

it.each([false, true])("retains editable invalid OCR facts and commits only after explicit valid confirmation (missing amount: %s)", async (missingAmount) => {
  const view = mount();
  await drop(view, booking("SPAR", 140, missingAmount ? "€ ???" : "€ 14,56", ""));
  expect(view.read().state.transactions).toEqual([]);
  await waitFor(() => expect(persisted().reviewQueue).toHaveLength(1));
  const dialog = within(screen.getByRole("dialog", { name: "Kontoauszüge prüfen" }));
  const save = dialog.getByRole<HTMLButtonElement>("button", { name: "Zuordnung übernehmen" });
  expect(save.disabled).toBe(true);
  expect(dialog.getByLabelText<HTMLInputElement>("Datum").readOnly).toBe(false);
  expect(dialog.getByLabelText<HTMLInputElement>("Text").readOnly).toBe(false);
  fireEvent.change(dialog.getByLabelText("Kategorie"), { target: { value: "Lebensmittel" } });
  expect(save.disabled).toBe(true);
  fireEvent.change(dialog.getByLabelText("Datum"), { target: { value: "2026-10-02" } });
  if (missingAmount) {
    expect(save.disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText("Betrag"), { target: { value: "-14,56" } });
  }
  expect(save.disabled).toBe(false);
  expect(view.read().state.transactions).toEqual([]);
  fireEvent.click(save);
  await waitFor(() => expect(view.read().state.transactions).toHaveLength(1));
  expect(view.read().state.transactions[0]).toMatchObject({ amount: -14.56, date: "2026-10-02", description: "SPAR" });
  expect(view.read().openReviewCount).toBe(0);
  await waitFor(() => expect(persisted().transactions).toHaveLength(1));
});
