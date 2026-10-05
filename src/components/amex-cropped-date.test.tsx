// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { StatementImport } from "./statement-import";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState } from "@/lib/types";
import { parseAmexScreenshotLines, type ScreenshotLine } from "@/lib/import/amex-screenshot";
import { commitStatementImport, prepareStatementImport } from "@/lib/import/review";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const line = (text: string, y: number, x = 30): ScreenshotLine =>
  ({ text, confidence: 95, bbox: { x0: x, x1: x + 150, y0: y, y1: y + 20 } });
const parsed = () => parseAmexScreenshotLines([
  line("11.09.2026 - Aktuell", 50), line("Kartennummer -12345", 80),
  line("AMZN MKTP DE*TESTORDER9", 140), line("AMZN.COM/BILL", 170), line("€ 100,84", 155, 500),
], "cropped.jpeg");

function mount(initialState: AppState) {
  let current: ReturnType<typeof useFinance>;
  function Harness() {
    const finance = useFinance();
    const [request, setRequest] = useState(0);
    useEffect(() => { current = finance; }, [finance]);
    return <><button onClick={() => setRequest((value) => value + 1)}>Prüfung öffnen</button>
      <StatementImport reviewRequest={request} /></>;
  }
  const view = render(<FinanceProvider initialState={initialState}><Harness /></FinanceProvider>);
  return { ...view, read: () => current };
}

it.each([false, true])("asks only for the missing date, persists confirmation and does not reopen it (legacy message=%s)", async (legacy) => {
  const seed = createSeed();
  const source = parsed();
  const prepared = prepareStatementImport([source], seed);
  const initial = commitStatementImport(seed, prepared.automatic, [], prepared.metadata).state;
  if (legacy) {
    const message = "Amex-Screenshot: Händler, Datum oder Eurobetrag nicht eindeutig lesbar – bitte mit dem Bild abgleichen.";
    initial.reviewQueue = initial.reviewQueue?.map((item) => item.kind === "booking"
      ? { ...item, importIssues: undefined, message } : item);
    initial.importStatus = { imported: 0, issues: [`cropped.jpeg, Zeile 1: ${message}`] };
  }
  const view = mount(initial);
  fireEvent.click(screen.getByRole("button", { name: "Prüfung öffnen" }));
  const section = within(screen.getByRole("region", { name: "Buchung prüfen: AMZN MKTP DE*TESTORDER9 AMZN.COM/BILL" }));
  const date = section.getByLabelText<HTMLInputElement>("Datum");
  const save = section.getByRole<HTMLButtonElement>("button", { name: "Zuordnung übernehmen" });
  expect(section.getByText("Amex-Screenshot: Datum fehlt – bitte ergänzen.")).toBeTruthy();
  expect(date.value).toBe("");
  expect(date.readOnly).toBe(false);
  expect(date.getAttribute("aria-invalid")).toBe("true");
  expect(save.disabled).toBe(true);
  expect(section.getByLabelText<HTMLSelectElement>("Kategorie").value).toBe("Shopping");
  fireEvent.change(date, { target: { value: "2026-09-21" } });
  expect(save.disabled).toBe(false);
  expect(date.getAttribute("aria-invalid")).toBe("false");
  expect(section.queryByText(/Datum fehlt/)).toBeNull();
  expect(view.read().state.transactions).toEqual([]);
  expect(view.read().state.reviewQueue?.[0]).toMatchObject({ draft: { date: "" } });
  fireEvent.click(save);
  await waitFor(() => expect(view.read().state.transactions).toHaveLength(1));
  expect(view.read().state.transactions[0]).toMatchObject({ date: "2026-09-21", amount: -100.84, reviewed: true });
  expect(view.read().state.reviewQueue).toEqual([]);
  expect(view.read().state.importStatus?.issues).toEqual([]);
  await waitFor(() => {
    const stored = appStateSchema.parse(JSON.parse(localStorage.getItem("finanzdashboard.v1")!));
    expect(stored.transactions).toHaveLength(1);
    expect(stored.importStatus?.issues).toEqual([]);
  });
  view.unmount();
  const reloaded = mount(createSeed());
  const again = prepareStatementImport([parsed()], reloaded.read().state);
  expect(again.automatic).toEqual([]);
  expect(again.review).toEqual([]);
  expect(again.issues).toEqual([]);
});
