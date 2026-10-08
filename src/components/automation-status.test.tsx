// @vitest-environment jsdom
import {
  act,
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
import { StrictMode, type ReactNode } from "react";
import type { AutomationJob } from "@/lib/automation/schema";

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
  vi.useRealTimers();
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

it("shows accessible custom progress and retry errors", () => {
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
  expect(screen.getByText("Erneuter Versuch geplant")).toBeTruthy();
  expect(screen.getByText("40%").className).toContain("tabular-nums");
  expect(
    screen
      .getByRole("progressbar", { name: "Fortschritt: Kontoauszug.csv" })
      .getAttribute("aria-valuenow"),
  ).toBe("40");
  expect(screen.getByText("Erneuter Versuch")).toBeTruthy();
  expect(document.querySelector("progress")).toBeNull();
});

function makeJob(overrides: Partial<AutomationJob> = {}): AutomationJob {
  return {
    id: "job",
    name: "Kontoauszug.csv",
    kind: "statement",
    status: "PROCESSING",
    progress: 45,
    attempts: 0,
    cursor: 0,
    total: 0,
    error: null,
    updatedAt: 1,
    ...overrides,
  };
}

function statusView(jobs: AutomationJob[], error: string | null = null) {
  return (
    <AutomationContext.Provider value={{ jobs, error }}>
      <AutomationStatus />
    </AutomationContext.Provider>
  );
}

it("stacks every active job without the old five-card limit and excludes old completions", () => {
  const jobs = Array.from({ length: 6 }, (_, index) =>
    makeJob({
      id: String(index),
      name: `Auszug ${index}.csv`,
      status: index === 0 ? "QUEUED" : "PROCESSING",
    }),
  );
  render(
    statusView([
      ...jobs,
      makeJob({
        id: "done",
        name: "Alt.csv",
        status: "COMPLETED",
        progress: 100,
      }),
    ]),
  );
  expect(screen.getAllByRole("article")).toHaveLength(6);
  expect(screen.getAllByRole("progressbar")).toHaveLength(6);
  expect(screen.queryByText("Alt.csv")).toBeNull();
  expect(screen.getByText("In der Warteschlange")).toBeTruthy();
});

it("updates the same custom bar smoothly and only shimmers while processing", () => {
  const view = render(statusView([makeJob({ progress: 9 })]));
  const bar = screen.getByRole("progressbar");
  expect(bar.firstElementChild?.getAttribute("style")).toContain("width: 9%");
  expect(bar.firstElementChild?.className).toContain(
    "automation-progress-shimmer",
  );
  expect(bar.firstElementChild?.className).toContain("duration-500");
  expect(bar.firstElementChild?.className).toContain("overflow-hidden");
  view.rerender(statusView([makeJob({ progress: 10 })]));
  expect(screen.getByRole("progressbar")).toBe(bar);
  expect(bar.getAttribute("aria-valuenow")).toBe("10");
  expect(bar.firstElementChild?.getAttribute("style")).toContain("width: 10%");
  view.rerender(
    statusView([
      makeJob({ status: "FAILED", progress: 10, error: "Datei beschädigt" }),
    ]),
  );
  expect(bar.firstElementChild?.className).not.toContain(
    "automation-progress-shimmer",
  );
  expect(bar.firstElementChild?.className).toContain("bg-rose-500");
  expect(screen.getByRole("alert").textContent).toBe("Datei beschädigt");
  expect(bar.getAttribute("aria-describedby")).toBe(
    screen.getByRole("alert").id,
  );
});

it.each(["COMPLETED", "removed"] as const)(
  "fades out and removes a job when it becomes %s",
  (status) => {
    vi.useFakeTimers();
    const view = render(statusView([makeJob()]));
    const card = screen.getByRole("article");
    view.rerender(
      statusView(
        status === "removed" ? [] : [makeJob({ status, progress: 100 })],
      ),
    );
    expect(card.className).toContain("opacity-0");
    expect(card.getAttribute("aria-hidden")).toBe("true");
    expect(document.body.contains(card)).toBe(true);
    act(() => vi.advanceTimersByTime(350));
    expect(document.body.contains(card)).toBe(false);
    expect(
      screen.queryByRole("region", { name: "Hintergrundverarbeitung" }),
    ).toBeNull();
    view.rerender(
      statusView([makeJob({ status: "COMPLETED", progress: 100 })]),
    );
    expect(screen.queryByRole("article")).toBeNull();
  },
);

it("does not let an old exit timer remove a job that reappeared or exits again", () => {
  vi.useFakeTimers();
  const view = render(statusView([makeJob()]));
  view.rerender(statusView([]));
  act(() => vi.advanceTimersByTime(200));
  view.rerender(statusView([makeJob({ status: "RETRYING" })]));
  act(() => vi.advanceTimersByTime(150));
  expect(screen.getByRole("article")).toBeTruthy();
  view.rerender(statusView([]));
  act(() => vi.advanceTimersByTime(200));
  expect(document.querySelector("article")).not.toBeNull();
  act(() => vi.advanceTimersByTime(150));
  expect(document.querySelector("article")).toBeNull();
});

it("cleans exit timers on unmount in StrictMode and preserves stream errors without jobs", () => {
  vi.useFakeTimers();
  const view = render(<StrictMode>{statusView([makeJob()])}</StrictMode>);
  view.rerender(<StrictMode>{statusView([])}</StrictMode>);
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  render(statusView([], "Echtzeit-Verbindung unterbrochen"));
  expect(screen.getByRole("alert").textContent).toContain(
    "Echtzeit-Verbindung",
  );
});

it.each([
  { progress: -10, percentage: "0" },
  { progress: 145, percentage: "100" },
])(
  "clamps progress $progress to accessible percentage $percentage",
  ({ progress, percentage }) => {
    render(statusView([makeJob({ progress })]));
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      percentage,
    );
    expect(
      screen.getByRole("progressbar").firstElementChild?.getAttribute("style"),
    ).toContain(`width: ${percentage}%`);
  },
);

it("renders upload, queue and retry animations without the processing shimmer", () => {
  render(
    statusView(
      (["UPLOADING", "QUEUED", "RETRYING"] as const).map((status, index) =>
        makeJob({ id: String(index), status }),
      ),
    ),
  );
  expect(document.querySelectorAll("svg.animate-spin")).toHaveLength(1);
  expect(document.querySelectorAll("svg.animate-pulse")).toHaveLength(2);
  expect(document.querySelector(".automation-progress-shimmer")).toBeNull();
});
