// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { StatementImport } from "./statement-import";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { parseStatementFile, type StatementResult } from "@/lib/import/statements";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/import/statements", async (original) => ({ ...await original<object>(), parseStatementFile: vi.fn() }));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

function mount(state: AppState) {
  let current: ReturnType<typeof useFinance> | undefined;
  function Harness() {
    const finance = useFinance();
    useEffect(() => { current = finance; }, [finance]);
    return <StatementImport />;
  }
  const view = render(<FinanceProvider initialState={state}><Harness /></FinanceProvider>);
  return { ...view, read: () => {
    if (!current) throw new Error("Finance provider is not mounted");
    return current;
  } };
}

it("saves new screenshot corrections immediately and preserves them after reload and repeat upload", async () => {
  const seed = createSeed();
  const old: Transaction = { id: "existing-ikea", date: "2026-10-02", bank: "Amex", pocket: "Amex",
    description: "IKEA KLAGENFURT", amount: -200, category: "Shopping", includeInPlan: false,
    rawDetails: ["Amex-Screenshot"], sharedWithRaphael: true, merchantAlias: "Schrank",
    categoryOverride: true, manualCategory: true, reviewed: true, fixedCost: false };
  const state: AppState = { ...seed, transactions: [old], fixedReceipts: [], reviewQueue: [],
    settings: { ...seed.settings, asOf: "2026-10-06" }, plannedOneOffs: [], plannedOneOffsSeeded: true,
    amexBalanceSnapshots: [{ periodStart: "2026-09-11", date: "2026-10-05", balance: 1619.19 }] };
  const result: StatementResult = { source: "Amex", file: "WhatsApp Image 2026-10-06.jpeg", skipped: 0, issues: [],
    rows: [{ ...old, id: "new-ikea", amount: -207.82, amexSource: "screenshot", amexStatus: "posted", amexCapturedAt: "2026-10-06" },
      { ...old, id: "new-pending", date: "2026-10-05", description: "SPAR FINKENSTEIN 6423", amount: -6.56,
        category: "Lebensmittel", merchantAlias: undefined, sharedWithRaphael: false, amexSource: "screenshot",
        amexStatus: "pending", amexCapturedAt: "2026-10-06" }],
    amexScreenshot: { layout: "grouped", capturedAt: "2026-10-06", balance: 1489.69, balanceIncludesPending: false } };
  vi.mocked(parseStatementFile).mockResolvedValue(result);
  let view = mount(state);
  await waitFor(() => expect(view.read().ready).toBe(true));
  const upload = () => fireEvent.change(screen.getByLabelText("Kontoauszüge auswählen"), {
    target: { files: [new File(["pixels"], result.file, { type: "image/jpeg" })] },
  });
  upload();
  await waitFor(() => expect(view.read().state.amexScreenshotValidation).toEqual({ version: 1, date: "2026-10-06" }));
  const saved = view.read().state;
  expect(saved.transactions).toHaveLength(2);
  expect(saved.transactions.find((row) => row.id === old.id)).toMatchObject({ amount: -207.82,
    merchantAlias: "Schrank", sharedWithRaphael: true, manualCategory: true, fixedCost: false });
  expect(saved.amexBalanceSnapshots?.at(-1)).toMatchObject({ balance: 1489.69, pendingBalance: 6.56 });
  expect(appStateSchema.parse(JSON.parse(localStorage.getItem("finanzdashboard.v1")!)).amexScreenshotValidation)
    .toEqual(saved.amexScreenshotValidation);
  view.unmount();
  view = mount(createSeed());
  await waitFor(() => expect(view.read().ready).toBe(true));
  expect(view.read().state.transactions).toEqual(saved.transactions);
  expect(view.read().state.amexBalanceSnapshots).toEqual(saved.amexBalanceSnapshots);
  upload();
  await waitFor(() => expect(parseStatementFile).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(view.read().statementImport?.added).toBe(0));
  expect(view.read().state.transactions).toEqual(saved.transactions);
});
