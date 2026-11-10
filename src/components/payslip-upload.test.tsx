// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountWorkspaceContext, type AccountWorkspace } from "@/components/account-context";
import { PayslipUploadButton, PayslipUploadProvider, usePayslipUpload, type PayslipBatchResult } from "@/components/payslip-upload";
import { toast } from "sonner";
import { createSeed } from "@/lib/seed";
import type { Payslip } from "@/lib/payslip-schema";
import type { AppState } from "@/lib/types";

const fixture = vi.hoisted(() => {
  class PasswordError extends Error {}
  return { parse: vi.fn(), PasswordError, state: undefined as unknown as AppState };
});
vi.mock("@/lib/import/payslip", () => ({ parsePayslipPdf: fixture.parse, PayslipPasswordError: fixture.PasswordError }));
vi.mock("@/components/finance-provider", () => ({
  useFinance: () => ({ state: fixture.state, update: (updater: (state: AppState) => AppState) => { fixture.state = updater(fixture.state); }, storageError: null }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const january: Payslip = { year: 2026, month: 1, employer: "Musterbetrieb GmbH", regularGross: 3000, specialGross: 0, monthlyPayroll: true };
const workspace: AccountWorkspace = { user: { id: "own-account", username: "synthetic", role: "admin" }, loadServer: async () => {} };
let storedPassword: string | null;
const puts: unknown[] = [];

beforeEach(() => {
  fixture.state = createSeed();
  fixture.parse.mockReset();
  storedPassword = null;
  puts.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    if (init.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { password: string };
      puts.push(body);
      storedPassword = body.password;
    }
    if (url.includes("reveal=1")) return Response.json(storedPassword ? { stored: true, password: storedPassword } : { stored: false });
    return Response.json(storedPassword ? { stored: true, updatedAt: 1 } : { stored: false });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness() {
  const [imported, setImported] = useState<Payslip | null>(null);
  return (
    <AccountWorkspaceContext value={workspace}>
      <PayslipUploadProvider onImported={setImported}>
        <PayslipUploadButton />
        {imported && <p>Importiert: {imported.month}/{imported.year}</p>}
      </PayslipUploadProvider>
    </AccountWorkspaceContext>
  );
}

function pdf(name: string) {
  const file = new File(["%PDF-synthetic"], name, { type: "application/pdf" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(8) });
  return file;
}

function select(name = "januar.pdf") {
  fireEvent.change(screen.getByLabelText("Lohnabrechnungen als PDF auswählen"), { target: { files: [pdf(name)] } });
}

function DriveReader({ names, onSettled }: { names: string[]; onSettled: (result: PayslipBatchResult) => void }) {
  const { readFiles } = usePayslipUpload();
  return <button type="button" onClick={() => readFiles(names.map(pdf), { source: "Google Drive", background: true, onSettled })}>Drive lesen</button>;
}

function DriveHarness({ names, onSettled }: { names: string[]; onSettled: (result: PayslipBatchResult) => void }) {
  return (
    <AccountWorkspaceContext value={workspace}>
      <PayslipUploadProvider><DriveReader names={names} onSettled={onSettled} /></PayslipUploadProvider>
    </AccountWorkspaceContext>
  );
}

it("opens a protected PDF with the stored password without asking", async () => {
  storedPassword = "gespeichert-123";
  fixture.parse.mockRejectedValueOnce(new fixture.PasswordError("locked")).mockResolvedValueOnce({ drafts: [january], issues: [] });
  render(<Harness />);
  select();
  expect(await screen.findByText("Importiert: 1/2026")).toBeTruthy();
  expect(fixture.parse).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), "gespeichert-123");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fixture.state.payslips).toEqual([january]);
});

it("does not fetch a stored password for unprotected PDFs", async () => {
  storedPassword = "gespeichert-123";
  fixture.parse.mockResolvedValueOnce({ drafts: [january], issues: [] });
  render(<Harness />);
  select();
  expect(await screen.findByText("Importiert: 1/2026")).toBeTruthy();
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("reveal"))).toBe(false);
});

it("asks when the stored password does not fit and stores the new one only on request", async () => {
  storedPassword = "alt-123";
  fixture.parse.mockRejectedValueOnce(new fixture.PasswordError("locked")).mockRejectedValueOnce(new fixture.PasswordError("wrong"))
    .mockResolvedValueOnce({ drafts: [january], issues: [] });
  render(<Harness />);
  select();
  const dialog = within(await screen.findByRole("dialog", { name: "Geschützte Abrechnung" }));
  expect(dialog.getByText("Das gespeicherte PDF-Passwort passt nicht zu dieser Datei.")).toBeTruthy();
  const remember = dialog.getByRole("switch", { name: "Passwort sicher speichern" });
  expect(remember.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(remember);
  fireEvent.change(dialog.getByLabelText("PDF-Passwort"), { target: { value: "neu-456" } });
  fireEvent.click(dialog.getByRole("button", { name: "Öffnen" }));
  expect(await screen.findByText("Importiert: 1/2026")).toBeTruthy();
  await waitFor(() => expect(puts).toEqual([{ password: "neu-456" }]));
  expect(JSON.stringify(fixture.state)).not.toContain("neu-456");
});

it("reports every file of an automatic read and names its source", async () => {
  fixture.parse.mockResolvedValueOnce({ drafts: [january], issues: [] })
    .mockResolvedValueOnce({ drafts: [], issues: ["Keine Lohnabrechnung"] })
    .mockRejectedValueOnce(new fixture.PasswordError("locked"));
  const settled = vi.fn();
  render(<DriveHarness names={["januar.pdf", "steuerbescheid.pdf", "februar.pdf"]} onSettled={settled} />);
  fireEvent.click(screen.getByRole("button", { name: "Drive lesen" }));
  const dialog = within(await screen.findByRole("dialog", { name: "Geschützte Abrechnung" }));
  expect(dialog.getByText(/^Neu aus Google Drive\. Gib das PDF-Passwort ein/)).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Überspringen" }));
  await waitFor(() => expect(settled).toHaveBeenCalledOnce());
  expect(settled.mock.calls[0][0]).toMatchObject({
    files: [{ outcome: "imported" }, { outcome: "skipped", note: "Keine Lohnabrechnung erkannt." }, { outcome: "skipped", note: "Passwort fehlt." }],
  });
  expect(vi.mocked(toast.success)).toHaveBeenLastCalledWith(expect.stringMatching(/^Google Drive: 1 Abrechnung\(en\) automatisch übernommen\./));
  expect(fixture.state.payslips).toEqual([january]);
});

it("lets automatic reads wait while a manual upload is still open", async () => {
  fixture.parse.mockRejectedValueOnce(new fixture.PasswordError("locked"));
  const settled = vi.fn();
  render(<DriveHarness names={["februar.pdf"]} onSettled={settled} />);
  select();
  await screen.findByRole("dialog", { name: "Geschützte Abrechnung" });
  fireEvent.click(screen.getByRole("button", { name: "Drive lesen", hidden: true }));
  expect(settled).toHaveBeenCalledWith({ files: [], busy: true, message: "Ein Import läuft bereits." });
  expect(fixture.parse).toHaveBeenCalledOnce();
});

it("keeps an automatic read for later when a manual upload replaces it", async () => {
  fixture.parse.mockRejectedValueOnce(new fixture.PasswordError("locked")).mockResolvedValueOnce({ drafts: [january], issues: [] });
  const settled = vi.fn();
  render(<DriveHarness names={["februar.pdf"]} onSettled={settled} />);
  fireEvent.click(screen.getByRole("button", { name: "Drive lesen" }));
  await screen.findByRole("dialog", { name: "Geschützte Abrechnung" });
  select();
  expect(settled).toHaveBeenCalledWith({ files: [], busy: true, message: "Durch einen neuen Import ersetzt." });
  await waitFor(() => expect(fixture.state.payslips).toEqual([january]));
});
