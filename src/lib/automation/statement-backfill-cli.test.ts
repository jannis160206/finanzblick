import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  args: vi.fn(),
  config: vi.fn(),
  enqueue: vi.fn(),
  close: vi.fn(),
}));
vi.mock("node:util", async (original) => ({
  ...(await original<typeof import("node:util")>()),
  parseArgs: mocks.args,
}));
vi.mock("@/lib/server/config", () => ({ readAccountConfig: mocks.config }));
vi.mock("@/lib/server/database", () => ({
  AccountDatabase: class {
    close = mocks.close;
  },
}));
vi.mock("@/lib/automation/store", () => ({
  AutomationStore: class {
    enqueueAllBackfills = mocks.enqueue;
  },
}));
beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.config.mockReturnValue({ databasePath: "test.sqlite" });
  mocks.enqueue.mockReturnValue(1);
  vi.spyOn(console, "info").mockImplementation(() => {});
});
it("passes a stable operator-selected version without requesting a reset", async () => {
  mocks.args.mockReturnValue({
    values: {
      rerun: false,
      "merchant-upgrade": false,
      "once-version": "manual-recheck-v1",
    },
  });
  await import("../../../scripts/statement-backfill");
  expect(mocks.enqueue).toHaveBeenCalledWith({
    rerun: false,
    onceVersion: "manual-recheck-v1",
  });
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
it("rejects two competing once-only modes before accessing the database", async () => {
  mocks.args.mockReturnValue({
    values: { "merchant-upgrade": true, "once-version": "manual-recheck-v1" },
  });
  await expect(import("../../../scripts/statement-backfill")).rejects.toThrow(
    "either",
  );
  expect(mocks.config).not.toHaveBeenCalled();
});
it("closes the database when enqueueing fails instead of reporting success", async () => {
  mocks.args.mockReturnValue({
    values: { "once-version": "manual-recheck-v1" },
  });
  mocks.enqueue.mockImplementation(() => {
    throw new Error("Active backfill");
  });
  await expect(import("../../../scripts/statement-backfill")).rejects.toThrow(
    "Active backfill",
  );
  expect(mocks.close).toHaveBeenCalledTimes(1);
  expect(console.info).not.toHaveBeenCalled();
});
it.each(["", "bad version", "UPPERCASE", "x".repeat(81)])(
  "rejects an invalid version before database access: %s",
  async (version) => {
    mocks.args.mockReturnValue({ values: { "once-version": version } });
    await expect(import("../../../scripts/statement-backfill")).rejects.toThrow(
      "identifier",
    );
    expect(mocks.config).not.toHaveBeenCalled();
  },
);
it("rejects resetting a named pass before database access", async () => {
  mocks.args.mockReturnValue({
    values: { "once-version": "manual-recheck", rerun: true },
  });
  await expect(import("../../../scripts/statement-backfill")).rejects.toThrow(
    "--rerun",
  );
  expect(mocks.config).not.toHaveBeenCalled();
});
