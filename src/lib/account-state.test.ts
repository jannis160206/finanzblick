import { expect, it } from "vitest";
import { createEmptyAccountState } from "./account-state";
import { appStateSchema } from "./types";
import { initializePlannedOneOffs } from "./planned-one-offs";
import { initializeMotorcycleGoal } from "./goals";
import { bikeCountdown } from "./calc";

it("new accounts have no administrator balances, personal goals or seeded purchases", () => {
  const state = appStateSchema.parse(createEmptyAccountState());
  expect(Object.values(state.settings.balances)).toEqual([0, 0, 0, 0]);
  expect(state.transactions).toEqual([]);
  expect(state.financeRows).toEqual([]);
  expect(initializePlannedOneOffs(state).plannedOneOffs).toEqual([]);
  expect(initializeMotorcycleGoal(state, 0).savingsGoals).toEqual([]);
  expect(state.settings.bikeTarget).toBe(0);
  expect(bikeCountdown(0, 0, state.settings).progress).toBe(0);
});
