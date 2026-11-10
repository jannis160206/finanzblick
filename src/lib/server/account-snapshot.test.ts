import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { serverFinanceSnapshot } from "./account-snapshot";

const user = { id: "alice", username: "alice", role: "user" as const };

describe("server finance snapshot", () => {
  it("returns the stored state with its revision for the first render", async () => {
    const state = createEmptyAccountState();
    expect(await serverFinanceSnapshot(user, () => ({ state, revision: 7 }))).toEqual({ state, revision: 7 });
  });

  it("lets the client load as before when there is nothing to inline", async () => {
    expect(await serverFinanceSnapshot(user, () => ({ state: null, revision: 0 }))).toBeUndefined();
    expect(await serverFinanceSnapshot(user, () => { throw new Error("database busy"); })).toBeUndefined();
  });

  it("does not inline very large ledgers into the HTML", async () => {
    const state = createEmptyAccountState();
    state.transactions = Array.from({ length: 6_000 }, (_, index) => ({
      id: `row-${index}`, date: "2026-09-01", bank: "Raiffeisen", pocket: "Girokonto",
      description: "Synthetic booking with a fairly long description text".repeat(4), amount: -1, category: "Shopping", includeInPlan: true,
    }));
    expect(await serverFinanceSnapshot(user, () => ({ state, revision: 1 }))).toBeUndefined();
  });
});
