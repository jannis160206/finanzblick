// @vitest-environment jsdom
import { useEffect, type ReactNode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinanceProvider, useFinance } from "@/components/finance-provider";
import { calculateDashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState } from "@/lib/types";

vi.mock("next-themes", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("sonner", () => ({ Toaster: () => null, toast: { success: vi.fn(), error: vi.fn() } }));

class SilentEventSource {
  addEventListener() {}
  close() {}
}
type Finance = ReturnType<typeof useFinance>;
const user = { id: "alice", username: "alice", role: "user" as const };

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("EventSource", SilentEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

function serverState(): AppState {
  const seed = createSeed();
  return appStateSchema.parse({ ...seed, settings: { ...seed.settings, asOf: "2026-09-16", baselineDate: "2026-09-01" } });
}

function Observer({ values }: { values: Finance[] }) {
  const finance = useFinance();
  useEffect(() => { values.push(finance); }, [finance, values]);
  return null;
}

it("shows a server-rendered account state at once and loads it without requesting it again", async () => {
  const state = serverState();
  const dashboard = calculateDashboard(state);
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, options?: RequestInit) => {
    requests.push(`${options?.method ?? "GET"} ${url}`);
    if (url === "/api/finance" && options?.method === "PUT") return Response.json({ state: JSON.parse(String(options.body)).state, revision: 4 });
    return Response.json({});
  }));
  const values: Finance[] = [];
  render(
    <FinanceProvider initialState={state} initialRevision={3} initialDashboard={dashboard} account={user}>
      <Observer values={values} />
    </FinanceProvider>,
  );
  expect(values[0]).toMatchObject({ ready: false, preloaded: true });
  expect(values[0].state).toBe(state);
  expect(values[0].dashboard).toBe(dashboard);
  await waitFor(() => expect(values.at(-1)?.ready).toBe(true));
  expect(requests).not.toContain("GET /api/finance");
});

it("keeps the local behaviour without a server-rendered state", () => {
  const values: Finance[] = [];
  render(<FinanceProvider initialState={serverState()}><Observer values={values} /></FinanceProvider>);
  expect(values[0].preloaded).toBe(false);
});
