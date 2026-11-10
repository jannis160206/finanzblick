// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { calculateDashboard } from "@/lib/calc";
import { computeDashboardExtras } from "@/lib/dashboard-extras";
import { prepareLoadedState } from "@/lib/finance-hydrate";
import { runFinanceTask, type FinanceWorkerResponse } from "@/lib/finance-worker";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";

const posted: FinanceWorkerResponse[] = [];
const charge = (id: string, date: string): Transaction => ({
  id, date, bank: "Raiffeisen", pocket: "Girokonto", description: "Streamflix Abo", amount: -12.99, category: "Abonnements", includeInPlan: true,
});
function loaded(): AppState {
  const seed = createSeed();
  return appStateSchema.parse({
    ...seed, settings: { ...seed.settings, asOf: "2026-09-12", baselineDate: "2026-09-01" },
    transactions: ["06", "07", "08", "09"].map((month) => charge(`flix-${month}`, `2026-${month}-03`)),
  });
}
const send = (request: Record<string, unknown>) => {
  posted.length = 0;
  window.onmessage!(new MessageEvent("message", { data: request }));
  return posted[0];
};

beforeAll(async () => {
  vi.spyOn(window, "postMessage").mockImplementation((message: unknown) => { posted.push(message as FinanceWorkerResponse); });
  await import("./finance-compute.worker");
});

describe("finance worker", () => {
  it("runs on the main thread when workers are unavailable", () => {
    expect(runFinanceTask({ kind: "settle", state: loaded() })).toBeNull();
  });

  it("prepares loaded data like the provider and reports when nothing changed", () => {
    const raw = loaded();
    const prepared = prepareLoadedState(raw);
    const first = send({ id: 1, kind: "prepare", data: raw });
    expect(first).toMatchObject({ id: 1, ok: true });
    const result = (first as { result: { unchanged: boolean; state?: AppState; dashboard: unknown } }).result;
    expect(result.unchanged ? raw : result.state).toEqual(prepared);
    expect(result.dashboard).toEqual(calculateDashboard(prepared));
    expect(send({ id: 2, kind: "prepare", data: prepared })).toMatchObject({ id: 2, ok: true, result: { unchanged: true } });
  });

  it("computes the dashboard extras and leaves states without open reviews untouched", () => {
    const state = prepareLoadedState(loaded());
    expect(send({ id: 3, kind: "extras", state })).toEqual({ id: 3, ok: true, result: computeDashboardExtras(state) });
    expect(send({ id: 4, kind: "settle", state: { ...state, reviewQueue: [] } })).toEqual({ id: 4, ok: true, result: { changed: false } });
    expect(send({ id: 5, kind: "autoAssign", state: { ...state, reviewQueue: [] } })).toMatchObject({ id: 5, ok: true, result: { changed: false } });
  });

  it("answers failures with an error instead of throwing", () => {
    const response = send({ id: 6, kind: "prepare", data: { invalid: true } });
    expect(response).toMatchObject({ id: 6, ok: false });
    expect((response as { message: string }).message.length).toBeGreaterThan(0);
  });
});
