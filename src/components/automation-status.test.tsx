// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FinanceProvider } from "./finance-provider";
import { AccountWorkspaceContext } from "./account-context";
import { AutomationContext } from "./automation-context";
import { AutomationStatus } from "./automation-status";
import { StatementImport } from "./statement-import";
import { createEmptyAccountState } from "@/lib/account-state";
import { parseStatementFile } from "@/lib/import/statements";
import type { ReactNode } from "react";

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("sonner", () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/import/statements", async (original) => ({
  ...(await original<typeof import("@/lib/import/statements")>()),
  parseStatementFile: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

it("uploads the original file in account mode without executing the browser parser", async () => {
  const request = vi.fn<
    (url: string, options: RequestInit) => Promise<Response>
  >(async () => Response.json({ id: "job-id" }, { status: 202 }));
  vi.stubGlobal("fetch", request);
  const view = render(
    <FinanceProvider initialState={createEmptyAccountState()}>
      <AccountWorkspaceContext.Provider
        value={{
          user: { id: "alice", username: "alice", role: "user" },
          loadServer: vi.fn(),
        }}
      >
        <StatementImport />
      </AccountWorkspaceContext.Provider>
    </FinanceProvider>,
  );
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Dateien auswählen",
      }).disabled,
    ).toBe(false),
  );
  const file = new File(["original CSV"], "statement.csv", {
    type: "text/csv",
  });
  fireEvent.change(view.getByLabelText("Kontoauszüge auswählen"), {
    target: { files: [file] },
  });
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(request.mock.calls[0]).toEqual([
    "/api/statements?name=statement.csv",
    expect.objectContaining({
      method: "POST",
      body: file,
      headers: expect.objectContaining({
        "X-Finanzblick-Account": "alice",
        "X-Upload-Size": String(file.size),
      }),
    }),
  ]);
  expect(parseStatementFile).not.toHaveBeenCalled();
});

it("shows accessible live progress, retry errors and persisted completion", () => {
  render(
    <AutomationContext.Provider
      value={{
        error: null,
        jobs: [
          {
            id: "job",
            name: "Kontoauszug.csv",
            kind: "statement",
            status: "RETRYING",
            progress: 40,
            attempts: 1,
            cursor: 0,
            total: 0,
            error: "Erneuter Versuch",
            updatedAt: 1,
          },
        ],
      }}
    >
      <AutomationStatus />
    </AutomationContext.Provider>,
  );
  expect(screen.getByText("Erneuter Versuch geplant · 40%")).toBeTruthy();
  expect(
    screen
      .getByRole("progressbar", { name: "Fortschritt: Kontoauszug.csv" })
      .getAttribute("value"),
  ).toBe("40");
  expect(screen.getByText("Erneuter Versuch")).toBeTruthy();
});
