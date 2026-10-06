import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { appStateSchema } from "@/lib/types";

export function createTestDirectory(): string {
  const directory = join(process.cwd(), ".local-data");
  mkdirSync(directory, { recursive: true });
  return mkdtempSync(join(directory, "account-test-"));
}

export function blankTestState() {
  return appStateSchema.parse({
    version: 1,
    transactions: [],
    financeRows: [],
    months: {},
    settings: {
      asOf: "2026-10-01",
      baselineDate: "2026-10-01",
      balances: { Notgroschen: 0, Urlaub: 0, Sparkonto: 0, Motorrad: 0 },
      emergencyTarget: 1,
      vacationTarget: 1,
      savingsTarget: 1,
      bikeTarget: 1,
      bikePurchaseDate: "2027-01-01",
      allocationStart: "2026-10-01",
      bikeShare: 0,
      afterBikeSavingsShare: 0,
      oldRate: 0,
      newRate: 0,
      rateChangeDate: "2026-10-01",
      taxRate: 0,
      interestStart: "2026-10-01",
    },
  });
}
