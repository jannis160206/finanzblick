import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { readLocalAmexBalanceRecovery } from "./amex-local-recovery";

const example = path.join(process.cwd(), "import-example", "WhatsApp Image 2026-10-05 at 09.43.39.jpeg");

it.skipIf(!existsSync(example))("recovers the actual ignored Amex screenshot header entirely locally", async () => {
  const fetchMock = vi.fn(() => { throw new Error("External OCR is forbidden"); });
  vi.stubGlobal("fetch", fetchMock);
  try {
    const recoveries = await readLocalAmexBalanceRecovery();
    const recovery = recoveries.find((item) => item.snapshot.date === "2026-10-05");
    expect(recovery?.snapshot).toEqual({ periodStart: "2026-09-11", date: "2026-10-05", balance: 1619.19 });
    expect(new Set(recovery?.bookingKeys).size).toBeGreaterThanOrEqual(2);
    expect(recovery?.bookingKeys.length).toBe(new Set(recovery?.bookingKeys).size);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readLocalAmexBalanceRecovery()).toEqual(recoveries);
  } finally {
    vi.unstubAllGlobals();
  }
}, 120_000);
