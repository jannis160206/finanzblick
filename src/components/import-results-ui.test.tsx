// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "./finance-provider";
import { StatementImport } from "./statement-import";
import { UploadStatus } from "./upload-status";
import { createEmptyAccountState } from "@/lib/account-state";
import { parseStatementFile, type StatementResult } from "@/lib/import/statements";
import { type ImportResult } from "@/lib/import/results";
import { automationEventSchema, automationJobSchema } from "@/lib/automation/schema";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/import/statements", async (original) => ({
  ...(await original<typeof import("@/lib/import/statements")>()), parseStatementFile: vi.fn(),
}));
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

const uploadId = "f63e92d7-640c-4b87-9f22-fb6f39180c32";
const outcome = (patch: Partial<ImportResult> = {}): ImportResult => ({
  uploadId, name: "same.csv", completedAt: Date.now(), status: "imported",
  inserted: 0, updated: 0, duplicates: 2, review: 0, skipped: 0, issues: [], ...patch,
});

it("explains a zero-insert duplicate-only result without inventing legacy result counts", () => {
  const result = outcome();
  render(<UploadStatus activities={[]} results={[result]} reviewCount={0} error={null} jobs={[
    { id: "legacy", kind: "statement", name: "legacy.csv", status: "COMPLETED", progress: 100,
      attempts: 0, cursor: 0, total: 0, error: null, updatedAt: Date.now() - 1 },
  ]} />);
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  const current = within(screen.getByRole("article", { name: "Verarbeitung: same.csv" }));
  expect(current.getByText("Keine neuen Buchungen: Alle erkannten Buchungen waren bereits vorhanden.")).toBeTruthy();
  expect(current.getByLabelText("Importergebnis").textContent).toContain("Duplikate2");
  const legacy = within(screen.getByRole("article", { name: "Verarbeitung: legacy.csv" }));
  expect(legacy.queryByLabelText("Importergebnis")).toBeNull();
  expect(legacy.getByText(/Ergebniszahlen für diesen älteren Import sind nicht verfügbar/)).toBeTruthy();
});

it("separates unsupported technical completion and links an actionable reupload", () => {
  const reupload = vi.fn();
  render(<UploadStatus activities={[]} jobs={[]} results={[outcome({ status: "unsupported", duplicates: 0,
    skipped: 1, issues: [{ id: "issue", message: "PDF-Anbieter nicht erkannt.", action: "reupload" }] })]}
    reviewCount={0} error={null} onReupload={reupload} />);
  expect(document.querySelector("[data-upload-badge]")?.textContent).toBe("!");
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getByText("Nicht unterstützt")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Auszug erneut auswählen" }));
  expect(reupload).toHaveBeenCalledOnce();
  expect(screen.queryByRole("dialog", { name: "Uploadstatus" })).toBeNull();
});

it("validates upload result UUID association while preserving old queue payloads", () => {
  const job = { id: uploadId, kind: "statement", name: "same.csv", status: "COMPLETED",
    progress: 100, attempts: 0, cursor: 0, total: 0, error: null, updatedAt: Date.now() };
  expect(automationJobSchema.parse(job).result).toBeNull();
  expect(automationJobSchema.parse(job).errorCode).toBeNull();
  expect(automationJobSchema.safeParse({ ...job, result: outcome() }).success).toBe(true);
  expect(automationEventSchema.safeParse({ revision: 1, jobs: [{ ...job, result: outcome({ uploadId: crypto.randomUUID() }) }] }).success).toBe(false);
});

it("restores a failed local result as failed, without claiming a technically completed parser", () => {
  const reupload = vi.fn();
  render(<UploadStatus activities={[]} jobs={[]} reviewCount={0} error={null} onReupload={reupload}
    results={[outcome({ status: "failed", errorCode: "PARSE_DAMAGED", duplicates: 0,
      issues: [{ id: "failure", message: "Datei beschädigt.", action: "reupload" }] })]} />);
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getByText("Import fehlgeschlagen")).toBeTruthy();
  expect(screen.queryByLabelText("Importergebnis")).toBeNull();
  expect(screen.queryByText(/Technisch abgeschlossen/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Auszug erneut auswählen" }));
  expect(reupload).toHaveBeenCalledOnce();
});

function mount() {
  let current: ReturnType<typeof useFinance>;
  function Observer() {
    const finance = useFinance();
    useEffect(() => { current = finance; }, [finance]);
    return null;
  }
  const view = render(<FinanceProvider initialState={createEmptyAccountState()}><Observer /><StatementImport /></FinanceProvider>);
  return { ...view, read: () => current };
}
const repairResult = (foreign = false): StatementResult => ({
  source: "Raiffeisen", file: "repair.csv", rows: [], skipped: 1,
  issues: [{ file: "repair.csv", line: 2, message: foreign ? "Fremdwährung USD: nicht als Euro importiert." : "Datum und Betrag fehlen.",
    ...(foreign ? { action: "reupload" as const, reason: "foreign-currency" as const } : {}),
    draft: { id: "source", date: "", bank: "Raiffeisen", pocket: foreign ? "Raiffeisen Giro (USD)" : "Raiffeisen Giro",
      description: "SPAR", amount: null, category: "Lebensmittel", includeInPlan: false } }],
});

it("persists a repairable CSV issue, requires source confirmation, and updates only its UUID result", async () => {
  vi.mocked(parseStatementFile).mockResolvedValueOnce(repairResult());
  const view = mount();
  await waitFor(() => expect(view.read().ready).toBe(true));
  fireEvent.change(screen.getByLabelText("Kontoauszüge auswählen"), { target: { files: [new File(["synthetic"], "repair.csv")] } });
  await waitFor(() => expect(view.read().state.importResults).toHaveLength(1));
  const upload = view.read().state.importResults![0].uploadId;
  expect(view.read().state.importResults![0]).toMatchObject({ review: 1, inserted: 0, skipped: 0 });
  const dialog = within(screen.getByRole("dialog", { name: "Kontoauszüge prüfen" }));
  const save = dialog.getByRole<HTMLButtonElement>("button", { name: "Zuordnung übernehmen" });
  fireEvent.change(dialog.getByLabelText("Datum"), { target: { value: "2026-10-05" } });
  fireEvent.change(dialog.getByLabelText("Betrag"), { target: { value: "-12,00" } });
  expect(save.disabled).toBe(true);
  expect(view.read().state.transactions).toHaveLength(0);
  fireEvent.click(dialog.getByRole("checkbox", { name: "Datum, Text und EUR-Betrag anhand des Originalbelegs geprüft" }));
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await waitFor(() => expect(view.read().state.transactions).toHaveLength(1));
  expect(view.read().state.importResults).toMatchObject([{ uploadId: upload, inserted: 1, review: 0, issues: [] }]);
  expect(JSON.parse(localStorage.getItem("finanzdashboard.v1")!).importResults).toMatchObject([{ uploadId: upload, inserted: 1 }]);
});

it("retains foreign currency evidence only in status, never in an editable EUR repair queue", async () => {
  vi.mocked(parseStatementFile).mockResolvedValueOnce(repairResult(true));
  const view = mount();
  await waitFor(() => expect(view.read().ready).toBe(true));
  fireEvent.change(screen.getByLabelText("Kontoauszüge auswählen"), { target: { files: [new File(["synthetic"], "repair.csv")] } });
  await waitFor(() => expect(view.read().state.importResults).toHaveLength(1));
  expect(view.read().state.reviewQueue ?? []).toEqual([]);
  expect(screen.queryByRole("dialog", { name: "Kontoauszüge prüfen" })).toBeNull();
  expect(screen.queryByLabelText("Betrag")).toBeNull();
  expect(view.read().state.importResults).toMatchObject([{ inserted: 0, review: 0, skipped: 1,
    issues: [{ action: "reupload", reason: "foreign-currency", evidence: expect.stringContaining("USD") }] }]);
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.queryByRole("button", { name: "Buchungen korrigieren" })).toBeNull();
  expect(screen.getByRole("button", { name: "Auszug erneut auswählen" })).toBeTruthy();
  expect(screen.getByText(/Quellbeleg:.*USD/)).toBeTruthy();
  expect(view.read().state.transactions).toEqual([]);
});

it("keeps a valid browser booking and a reupload-only oversized issue instead of rejecting the whole state update", async () => {
  const repair = repairResult();
  vi.mocked(parseStatementFile).mockResolvedValueOnce({ ...repair,
    rows: [{ ...repair.issues[0].draft!, id: "valid", date: "2026-10-05", amount: -12,
      category: "Lebensmittel", includeInPlan: true }],
    issues: [{ ...repair.issues[0], draft: { ...repair.issues[0].draft!, description: "X".repeat(1001) } }],
  });
  const view = mount();
  await waitFor(() => expect(view.read().ready).toBe(true));
  fireEvent.change(screen.getByLabelText("Kontoauszüge auswählen"), { target: { files: [new File(["synthetic"], "repair.csv")] } });
  await waitFor(() => expect(view.read().state.importResults).toHaveLength(1));
  expect(view.read().state.transactions).toHaveLength(1);
  expect(view.read().state.reviewQueue ?? []).toEqual([]);
  expect(view.read().state.importResults).toMatchObject([{ inserted: 1, review: 0, skipped: 1,
    issues: [{ action: "reupload", reason: "invalid-repair-draft" }] }]);
  expect(screen.queryByRole("dialog", { name: "Kontoauszüge prüfen" })).toBeNull();
  expect(JSON.parse(localStorage.getItem("finanzdashboard.v1")!).transactions).toHaveLength(1);
});
