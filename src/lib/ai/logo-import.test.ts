import { describe, expect, it, vi } from "vitest";
import type { AutomationStore } from "@/lib/automation/store";
import { blankTestState } from "@/lib/server/test-support";
import { ImportLogoSweep } from "./logo-import";
import type { LogoSweepOptions, LogoSweepResult } from "./logo-sweep";

describe("ImportLogoSweep", () => {
  it("sweeps imported accounts one after another beside the queue until no merchant is left", async () => {
    const store = { accounts: { getFinance: () => ({ state: blankTestState(), revision: 1 }) } } as unknown as AutomationStore;
    const left = new Map([["a", 7], ["b", 2]]);
    const calls: string[] = [];
    const sweep = vi.fn(async (_store: AutomationStore, userId: string, _state: unknown, _options: LogoSweepOptions): Promise<LogoSweepResult> => {
      calls.push(userId);
      const remaining = Math.max(0, (left.get(userId) ?? 0) - 5);
      left.set(userId, remaining);
      return { saved: [], checked: 5, remaining, rateLimited: false };
    });
    const logos = new ImportLogoSweep(store, { sweep, pauseMs: 0 });
    const stop = new AbortController();
    logos.imported("a", stop.signal);
    logos.imported("b", stop.signal);
    // The import returns at once; the sweep runs on its own.
    expect(logos.running).toBeInstanceOf(Promise);
    await logos.running;
    expect(calls).toEqual(["a", "a", "b"]);
    expect(sweep.mock.calls.every(([, , , options]) => options.limit === 5 && options.signal === stop.signal)).toBe(true);
  });

  it("stops at once when the worker shuts down", async () => {
    const store = { accounts: { getFinance: () => ({ state: blankTestState(), revision: 1 }) } } as unknown as AutomationStore;
    const stop = new AbortController();
    const sweep = vi.fn(async () => {
      stop.abort();
      throw new Error("aborted");
    });
    const logos = new ImportLogoSweep(store, { sweep });
    logos.imported("a", stop.signal);
    await logos.running;
    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
