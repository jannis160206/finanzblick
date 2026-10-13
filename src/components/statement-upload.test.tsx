// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { FinanceProvider } from "./finance-provider";
import { AccountWorkspaceContext } from "./account-context";
import { AutomationContext } from "./automation-context";
import { StatementImport } from "./statement-import";
import { createEmptyAccountState } from "@/lib/account-state";
import { parseStatementFile, type StatementResult } from "@/lib/import/statements";
import type { AutomationJob } from "@/lib/automation/schema";
import { automationFailure } from "@/lib/automation/errors";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/import/statements", async (original) => ({
  ...(await original<typeof import("@/lib/import/statements")>()), parseStatementFile: vi.fn(),
}));
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); localStorage.clear();
});

function mount(account: string | null = "alice") {
  const state = createEmptyAccountState();
  const content = (jobs: AutomationJob[], currentAccount = account) => (
    <FinanceProvider initialState={state}>
      <AccountWorkspaceContext.Provider value={currentAccount ? {
        user: { id: currentAccount, username: currentAccount, role: "user" }, loadServer: vi.fn(),
      } : null}>
        <AutomationContext.Provider value={{ jobs, error: null }}><StatementImport /></AutomationContext.Provider>
      </AccountWorkspaceContext.Provider>
    </FinanceProvider>
  );
  const view = render(content([]));
  return { ...view, jobs: (jobs: AutomationJob[]) => view.rerender(content(jobs)),
    account: (account: string) => view.rerender(content([], account)) };
}
async function choose(files: File[]) {
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Dateien auswählen" }).disabled).toBe(false));
  fireEvent.change(screen.getByLabelText("Kontoauszüge auswählen"), { target: { files } });
}
const file = (name = "gleich.pdf") => new File(["statement"], name);
const badge = () => document.querySelector("[data-upload-badge]")?.textContent;
function job(id: string, status: AutomationJob["status"]): AutomationJob {
  return { id, status, name: "gleich.pdf", kind: "statement", progress: status === "COMPLETED" ? 100 : 30,
    attempts: 0, cursor: 0, total: 0, error: null, updatedAt: 1 };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("counts identical filenames separately and hands off by UUID even when SSE precedes the upload response", async () => {
  const first = deferred<Response>(), second = deferred<Response>();
  const request = vi.fn<(url: string, options: RequestInit) => Promise<Response>>()
    .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  vi.stubGlobal("fetch", request);
  const view = mount();
  await choose([file(), file()]);
  expect(badge()).toBe("2");
  const firstId = new Headers(request.mock.calls[0][1].headers).get("X-Upload-Id")!;
  view.jobs([job(firstId, "UPLOADING")]);
  expect(badge()).toBe("2");
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getAllByRole("article")).toHaveLength(2);
  expect(screen.getByText("Wird hochgeladen")).toBeTruthy();
  await act(async () => first.resolve(Response.json({ id: firstId }, { status: 202 })));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const secondId = new Headers(request.mock.calls[1][1].headers).get("X-Upload-Id")!;
  expect(secondId).not.toBe(firstId);
  view.jobs([job(firstId, "COMPLETED"), job(secondId, "UPLOADING")]);
  expect(badge()).toBe("1");
  await act(async () => second.resolve(Response.json({ id: secondId }, { status: 202 })));
  view.jobs([job(firstId, "COMPLETED"), job(secondId, "COMPLETED")]);
  await waitFor(() => expect(badge()).toBeUndefined());
  expect(screen.getAllByText("Abgeschlossen")).toHaveLength(2);
  view.jobs([]);
  await waitFor(() => expect(badge()).toBeUndefined());
  expect(parseStatementFile).not.toHaveBeenCalled();
});

it("continues a partial batch and keeps its explicit upload failure inside the reopenable panel", async () => {
  const request = vi.fn<(url: string, options: RequestInit) => Promise<Response>>()
    .mockRejectedValueOnce(new Error("Netzwerk nicht erreichbar"))
    .mockImplementationOnce(async (_url, options) => Response.json({
      id: new Headers(options.headers).get("X-Upload-Id"),
    }, { status: 202 }));
  vi.stubGlobal("fetch", request);
  const view = mount();
  await choose([file("fehler.pdf"), file("gut.pdf")]);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  const id = new Headers(request.mock.calls[1][1].headers).get("X-Upload-Id")!;
  view.jobs([job(id, "COMPLETED")]);
  await waitFor(() => expect(badge()).toBe("!"));
  expect(screen.queryByText("Netzwerk nicht erreichbar")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getByRole("alert").textContent).toBe("Netzwerk nicht erreichbar");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Schließen" }));
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getByRole("alert").textContent).toBe("Netzwerk nicht erreichbar");
});

it.each([
  { response: () => Response.json({ id: "not-a-uuid" }, { status: 202 }), text: "Uploadbestätigung ist ungültig" },
  { response: () => Response.json({ id: "2f64c74b-e4dd-4da4-950e-db1aa629c638" }, { status: 202 }), text: "Uploadbestätigung ist ungültig" },
  { response: () => new Response("not json", { status: 202 }), text: "ungültige Uploadantwort" },
  { response: () => Response.json({ error: "Warteschlange voll" }, { status: 429 }), text: "Warteschlange voll" },
])("does not claim acceptance of an invalid or failed response: $text", async ({ response, text }) => {
  vi.stubGlobal("fetch", vi.fn().mockImplementation(response));
  mount();
  await choose([file()]);
  await waitFor(() => expect(badge()).toBe("!"));
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getByRole("alert").textContent).toContain(text);
});

it("reports selection limits and empty files without leaving phantom active entries", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  mount();
  await choose(Array.from({ length: 6 }, () => file()));
  expect(badge()).toBe("!");
  await choose([new File([], "leer.pdf")]);
  await waitFor(() => expect(badge()).toBe("!"));
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getByText("Bitte höchstens fünf Auszüge gleichzeitig auswählen.")).toBeTruthy();
  expect(screen.getByText(/muss Daten enthalten/)).toBeTruthy();
});

it("aborts an old account's transfer and never exposes its files in the next account", async () => {
  const pending = deferred<Response>();
  const request = vi.fn<(url: string, options: RequestInit) => Promise<Response>>().mockReturnValue(pending.promise);
  vi.stubGlobal("fetch", request);
  const view = mount();
  await choose([file("privat-alice.pdf"), file("nicht-versenden.pdf")]);
  const options = request.mock.calls[0][1];
  view.account("bob");
  expect(options.signal?.aborted).toBe(true);
  await act(async () => pending.resolve(Response.json({
    id: new Headers(options.headers).get("X-Upload-Id"),
  }, { status: 202 })));
  expect(request).toHaveBeenCalledOnce();
  expect(badge()).toBeUndefined();
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getByText("Noch keine Uploads")).toBeTruthy();
  expect(screen.queryByText("privat-alice.pdf")).toBeNull();
});

it("tracks local parsing until persisted completion and places parser failures and warnings only in the panel", async () => {
  const parsed = deferred<StatementResult>();
  vi.mocked(parseStatementFile).mockReturnValueOnce(parsed.promise).mockRejectedValueOnce(new Error("PDF nicht lesbar"));
  mount(null);
  await choose([file("lokal.csv"), file("kaputt.pdf")]);
  expect(badge()).toBe("2");
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getByText("Datei wird geprüft")).toBeTruthy();
  await act(async () => parsed.resolve({ file: "lokal.csv", source: null, rows: [], skipped: 0, issues: [] }));
  await waitFor(() => expect(badge()).toBe("!"));
  expect(screen.getByText("Nicht unterstützt")).toBeTruthy();
  expect(screen.getByText("Import fehlgeschlagen")).toBeTruthy();
  expect(screen.queryByText("Abgeschlossen")).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe(automationFailure("PARSE_DAMAGED").message);
  expect(screen.queryByRole("region", { name: "Importstatus" })).toBeNull();
  const unsupported = within(screen.getByRole("article", { name: "Verarbeitung: lokal.csv" }));
  expect(unsupported.getByText("Keine neuen Buchungen: Dieses Dateiformat wurde nicht unterstützt.")).toBeTruthy();
  expect(unsupported.getByLabelText("Importergebnis").textContent).toContain("Neu0");
  const failed = within(screen.getByRole("article", { name: "Verarbeitung: kaputt.pdf" }));
  expect(failed.queryByLabelText("Importergebnis")).toBeNull();
  expect(failed.getByRole("alert").textContent).toBe(automationFailure("PARSE_DAMAGED").message);
  expect(screen.queryByText("PDF nicht lesbar")).toBeNull();
});

it("never marks a parsed local file completed when persisting its bookings fails", async () => {
  const parsed = deferred<StatementResult>();
  vi.mocked(parseStatementFile).mockReturnValueOnce(parsed.promise);
  mount(null);
  await choose([file("speichern.csv")]);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage full", "QuotaExceededError");
  });
  await act(async () => parsed.resolve({
    file: "speichern.csv", source: "Revolut", skipped: 0, issues: [],
    rows: [{ id: "save-failure", date: "2026-10-01", description: "SPAR", amount: -10,
      bank: "Revolut", pocket: null, category: "Lebensmittel", includeInPlan: true }],
  }));
  await waitFor(() => expect(badge()).toBe("!"));
  const review = screen.queryByRole("dialog", { name: "Kontoauszüge prüfen" });
  if (review) fireEvent.click(within(review).getByRole("button", { name: "Prüfung schließen" }));
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  const dialog = within(screen.getByRole("dialog", { name: "Uploadstatus" }));
  expect(dialog.queryByText("Abgeschlossen")).toBeNull();
  expect(dialog.getByText("Import fehlgeschlagen")).toBeTruthy();
  expect(dialog.getByRole("alert").textContent).toContain("Browserspeicher voll oder gesperrt");
});
