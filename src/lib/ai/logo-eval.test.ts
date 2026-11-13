import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importSuppliedLocalLogos } from "@/lib/automation/merchant-local-logos";
import { AutomationStore } from "@/lib/automation/store";
import { AccountDatabase } from "@/lib/server/database";
import { blankTestState } from "@/lib/server/test-support";
import { transactionSchema, type Transaction } from "@/lib/types";
import { cachedPoliteFetch, compareLogoRuns, evaluateLogos, logoPicture, summarizeLogos } from "./logo-eval";

const userId = "logo-eval-account";
let directory: string;
let accounts: AccountDatabase;
let store: AutomationStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "logo-eval-"));
  await mkdir(join(directory, "Logo"));
  vi.stubEnv("FINANZBLICK_LOGO_DIR", join(directory, "Logo"));
  accounts = new AccountDatabase(join(directory, "accounts.sqlite"));
  store = new AutomationStore(accounts);
  accounts.transaction((db) => {
    db.prepare("INSERT INTO users VALUES (?, ?, 'user', 'fixture', 1)").run(userId, userId);
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  accounts.close();
  await rm(directory, { recursive: true, force: true });
});

const square = (background: string) => sharp({ create: { width: 120, height: 120, channels: 4, background } }).png().toBuffer();
async function mark(accent = "#f0c000") {
  const ink = await sharp({ create: { width: 60, height: 60, channels: 4, background: "#000000" } }).png().toBuffer();
  const hole = await sharp({ create: { width: 20, height: 20, channels: 4, background: accent } }).png().toBuffer();
  return sharp({ create: { width: 120, height: 120, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: ink, left: 30, top: 30 }, { input: hole, left: 50, top: 50 }]).png().toBuffer();
}

const row = (id: string, overrides: Partial<Transaction>) => transactionSchema.parse({
  id, date: "2026-10-01", bank: "Raiffeisen", pocket: null, description: "", amount: -12, category: "Lebensmittel",
  categoryOverride: true, includeInPlan: true, ...overrides,
});
const card = (id: string, text: string) => row(id, {
  description: text, rawDescription: `Verwendungszweck: ${text} Zahlungsreferenz: POS 12,00 AT D1 01.10. 10:00 K1 001`,
});

describe("logoPicture", () => {
  it("finds blank squares, not dark logos on clear ground, and recognizes re-encoded copies", async () => {
    expect((await logoPicture(await square("#ffffff")))?.blank).toBe(true);
    const logo = await mark();
    const picture = await logoPicture(logo);
    expect(picture?.blank).toBe(false);
    expect((await logoPicture(await sharp(logo).webp({ quality: 90 }).png().toBuffer()))?.fingerprint).toBe(picture?.fingerprint);
  });
});

describe("evaluateLogos", () => {
  it("lists every merchant with the logo the app shows, its source, unused files and kind", async () => {
    await writeFile(join(directory, "Logo", "Nordlicht.png"), await mark());
    await writeFile(join(directory, "Logo", "Westwind Kiosk.png"), await mark("#2040c0"));
    await writeFile(join(directory, "Logo", "Bäckerei.png"), await mark("#20a040"));
    await importSuppliedLocalLogos(store, { userId, rightsReference: "Test", directory: join(directory, "Logo") });
    const transactions = [
      card("n1", "NORDLICHT VILLACH 9500"), card("n2", "NORDLICHT VILLACH 9500"),
      card("bakery", "BÄCKEREI VILLACH 9500"),
      card("ostwind", "OSTWIND VILLACH 9500"),
      row("atm", { description: "BANKOMAT 00092293", amount: -50, category: "Sonstiges" }),
      row("gift", { description: "Auftraggeber: Max Muster", rawDescription: "Auftraggeber: Max Muster IBAN Auftraggeber: AT00",
        merchantAlias: "Max Muster", category: "Geschenke & Spenden", amount: 40 }),
    ];
    accounts.putFinance(userId, { ...blankTestState(), transactions }, 0);
    const state = accounts.getFinance(userId).state!;
    const { records } = await evaluateLogos(store, userId, state, {
      verdicts: { nordlicht: { verdict: "ok", version: null } }, folderFiles: ["Nordlicht.png", "Westwind Kiosk.png", "Bäckerei.png"],
    });
    const byKey = new Map(records.map((record) => [record.key, record]));
    expect(byKey.get("nordlicht")).toMatchObject({ kind: "merchant", bookings: 2, withLogo: 2, status: "unchecked",
      logo: { source: "Logo-Ordner", name: "Nordlicht", flags: [] } });
    expect(byKey.get("ostwind")).toMatchObject({ status: "missing", logo: null, queries: ["Ostwind"] });
    const bakery = records.find((record) => record.samples[0]?.id === "bakery");
    expect(bakery).toMatchObject({ status: "generic", logo: { flags: ["Branchenwort als Name"] } });
    expect(records.find((record) => record.kind === "atm")).toMatchObject({ bookings: 1 });
    expect(records.find((record) => record.kind === "person")).toMatchObject({ samples: [{ id: "gift" }] });
    expect(summarizeLogos(records).merchant).toMatchObject({ merchants: 3, withLogo: 2, missing: 1, generic: 1, unchecked: 1 });

    const version = byKey.get("nordlicht")!.logo!.version;
    const checked = await evaluateLogos(store, userId, state, { verdicts: { nordlicht: { verdict: "ok", version } } });
    expect(checked.records.find((record) => record.key === "nordlicht")?.status).toBe("correct");
  });
});

describe("compareLogoRuns", () => {
  it("reports gained, lost and changed logos and worse or better statuses per merchant", () => {
    const logo = (version: string) => ({ merchantId: "private-a", version, source: "Logo-Ordner" as const, name: "A", flags: [] });
    const before = [
      { key: "a", logo: null, status: "missing" as const },
      { key: "b", logo: logo("1"), status: "correct" as const },
      { key: "c", logo: logo("1"), status: "unchecked" as const },
    ];
    const after = [
      { key: "a", logo: logo("1"), status: "unchecked" as const },
      { key: "b", logo: null, status: "missing" as const },
      { key: "c", logo: logo("2"), status: "unchecked" as const },
    ];
    expect(compareLogoRuns(before, after)).toEqual({ gained: ["a"], lost: ["b"], changed: ["c"], worse: ["b"], better: ["a"] });
  });
});

describe("cachedPoliteFetch", () => {
  it("answers repeated lookups from the cache, never caches rate limits and remembers unreachable hosts", async () => {
    let calls = 0;
    const network = (async (input: RequestInfo | URL) => {
      calls++;
      const url = String(input);
      if (url.includes("limited")) return new Response("", { status: 429 });
      if (url.includes("gone")) throw new TypeError("getaddrinfo ENOTFOUND");
      return new Response("ok", { headers: { "content-type": "text/plain" } });
    }) as typeof fetch;
    const fetch = cachedPoliteFetch(join(directory, "cache"), { fetcher: network, intervalMs: () => 0 });
    expect(await (await fetch("https://shop.example/")).text()).toBe("ok");
    expect(await (await fetch("https://shop.example/")).text()).toBe("ok");
    expect((await fetch("https://limited.example/")).status).toBe(429);
    expect((await fetch("https://limited.example/")).status).toBe(429);
    await expect(fetch("https://gone.example/")).rejects.toThrow("ENOTFOUND");
    await expect(fetch("https://gone.example/")).rejects.toThrow("ENOTFOUND");
    expect(calls).toBe(4);
  });
});
