import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BANK_LOGO_MISS_RETRY_MS, MAX_BANK_LOGO_FILES, bankLogoDirectory, clearBankLogoCaches, isProviderLogoUrl,
  resolveBankLogo, type BankLogoDeps, type ProviderBank,
} from "./logo";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const NORD = "https://enablebanking.com/brands/AT/Testbank%20Nord/";
const root = join(process.cwd(), ".local-data", "bank-logo-tests");
const T0 = Date.UTC(2026, 10, 1);

let directory: string;
let square: Buffer;
let wide: Buffer;

const svg = (width: number, height: number, shape: string) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>${shape}</svg>`,
);
const image = (bytes: Buffer, type = "image/png") =>
  new Response(new Uint8Array(bytes), { headers: { "Content-Type": type } });
const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const notFound = () => new Response("missing", { status: 404, headers: { "Content-Type": "text/html" } });

function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    calls.push(url);
    return (routes[url] ?? notFound)();
  });
  return { fetcher, calls };
}

const dimensions = (png: Buffer) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

beforeAll(async () => {
  await mkdir(root, { recursive: true });
  square = await sharp(svg(128, 128, `<circle cx="64" cy="64" r="50" fill="#c00"/>`)).png().toBuffer();
  wide = await sharp(svg(512, 128, `<rect x="16" y="32" width="480" height="64" fill="#036"/>`)).png().toBuffer();
});

beforeEach(async () => {
  clearBankLogoCaches();
  directory = await mkdtemp(join(root, "case-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveBankLogo", () => {
  it("stores the logo from Enable Banking's own bank list as PNG and serves it from disk", async () => {
    const { fetcher, calls } = fakeFetch({ [NORD]: () => image(square) });
    const providerBanks = vi.fn(async (): Promise<ProviderBank[]> => [{ name: "Testbank Nord", logo: NORD }]);
    const deps: BankLogoDeps = { directory, fetcher, providerBanks, now: () => T0 };
    const logo = await resolveBankLogo({ name: "Testbank Nord", country: "AT" }, deps);
    expect(logo?.png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(logo?.version).toMatch(/^[a-f0-9]{16}$/);
    expect(calls).toEqual([NORD]);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: "manual", cache: "no-store" });
    expect(await readdir(directory)).toEqual(["eb-testbank-nord-at.png"]);

    clearBankLogoCaches();
    const again = await resolveBankLogo({ name: "TESTBANK NORD", country: "AT" }, deps);
    expect(again?.version).toBe(logo?.version);
    expect(calls).toHaveLength(1);
  });

  it("falls back to the icon on the registry's official domain and skips other hosts", async () => {
    const page = `<html><head>
      <link rel="apple-touch-icon" sizes="512x512" href="https://cdn.example.net/touch.png">
      <link rel="icon" type="image/svg+xml" href="/static/icon.svg">
    </head></html>`;
    const { fetcher, calls } = fakeFetch({
      "https://www.raiffeisen.at/": () => html(page),
      "https://www.raiffeisen.at/static/icon.svg": () =>
        image(svg(96, 96, `<circle cx="48" cy="48" r="40" fill="#fe0"/>`), "image/svg+xml"),
    });
    const logo = await resolveBankLogo(
      { name: "Raiffeisenbank Kärnten", country: "AT" },
      { directory, fetcher, providerBanks: async () => undefined },
    );
    expect(logo?.png.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect(calls).toEqual(["https://www.raiffeisen.at/", "https://www.raiffeisen.at/static/icon.svg"]);
    expect(await readdir(directory)).toEqual(["raiffeisen.png"]);
  });

  it("prefers a square site icon over a wide provider wordmark, but keeps the wordmark as last resort", async () => {
    const revolut = "https://enablebanking.com/brands/AT/Revolut/";
    const n26 = "https://enablebanking.com/brands/AT/N26/";
    const { fetcher } = fakeFetch({
      [revolut]: () => image(wide),
      [n26]: () => image(wide),
      "https://www.revolut.com/": () => html(`<link rel="apple-touch-icon" href="/touch.png">`),
      "https://www.revolut.com/touch.png": () => image(square),
    });
    const deps: BankLogoDeps = {
      directory, fetcher,
      providerBanks: async () => [{ name: "Revolut", logo: revolut }, { name: "N26", logo: n26 }],
    };
    const squareLogo = await resolveBankLogo({ name: "Revolut", country: "AT" }, deps);
    const { width, height } = dimensions(squareLogo!.png);
    expect(width).toBeLessThanOrEqual(height * 2);
    const wordmark = await resolveBankLogo({ name: "N26", country: "AT" }, deps);
    expect(dimensions(wordmark!.png).width).toBeGreaterThan(dimensions(wordmark!.png).height * 2);
  });

  it("remembers misses and retries them only after seven days", async () => {
    const { fetcher, calls } = fakeFetch({});
    let now = T0;
    const deps: BankLogoDeps = { directory, fetcher, providerBanks: async () => undefined, now: () => now };
    expect(await resolveBankLogo({ name: "N26" }, deps)).toBeUndefined();
    const tried = calls.length;
    expect(tried).toBeGreaterThan(0);
    expect(await readdir(directory)).toEqual(["n26.miss"]);

    clearBankLogoCaches();
    now = T0 + BANK_LOGO_MISS_RETRY_MS - 1;
    expect(await resolveBankLogo({ name: "N26" }, deps)).toBeUndefined();
    expect(calls).toHaveLength(tried);

    clearBankLogoCaches();
    now = T0 + BANK_LOGO_MISS_RETRY_MS + 1;
    await resolveBankLogo({ name: "N26" }, deps);
    expect(calls.length).toBeGreaterThan(tried);
  });

  it("retries unreachable sources after an hour", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("fetch failed");
    });
    let now = T0;
    const deps: BankLogoDeps = { directory, fetcher, providerBanks: async () => undefined, now: () => now };
    expect(await resolveBankLogo({ name: "Wise" }, deps)).toBeUndefined();
    const tried = fetcher.mock.calls.length;
    now = T0 + 30 * 60_000;
    await resolveBankLogo({ name: "Wise" }, deps);
    expect(fetcher).toHaveBeenCalledTimes(tried);
    now = T0 + 61 * 60_000;
    await resolveBankLogo({ name: "Wise" }, deps);
    expect(fetcher.mock.calls.length).toBeGreaterThan(tried);
  });

  it("never fetches logo URLs outside Enable Banking's host or redirects away from it", async () => {
    const { fetcher, calls } = fakeFetch({
      [NORD]: () => new Response(null, { status: 302, headers: { Location: "https://169.254.169.254/latest/meta-data" } }),
      "https://enablebanking.com/brands/AT/West/": () =>
        new Response(null, { status: 301, headers: { Location: "https://evil.example.com/logo.png" } }),
    });
    const providerBanks = async (): Promise<ProviderBank[]> => [
      { name: "Testbank Süd", logo: "https://evil.example.com/logo.png" },
      { name: "Testbank Ost", logo: "https://enablebanking.com.evil.example/logo.png" },
      { name: "Testbank Mitte", logo: "http://enablebanking.com/brands/AT/Mitte/" },
      { name: "Testbank Nord", logo: NORD },
      { name: "Testbank West", logo: "https://enablebanking.com/brands/AT/West/" },
    ];
    for (const name of ["Testbank Süd", "Testbank Ost", "Testbank Mitte", "Testbank Nord", "Testbank West"])
      expect(await resolveBankLogo({ name }, { directory, fetcher, providerBanks })).toBeUndefined();
    expect(calls).toEqual([NORD, "https://enablebanking.com/brands/AT/West/"]);
    expect(isProviderLogoUrl("https://enablebanking.com/brands/FI/Nordea/")).toBe(true);
    expect(isProviderLogoUrl("https://cdn.enablebanking.com/brands/FI/Nordea/")).toBe(true);
    expect(isProviderLogoUrl("https://enablebanking.com:8443/brands/FI/Nordea/")).toBe(false);
    expect(isProviderLogoUrl("https://user@enablebanking.com/brands/FI/Nordea/")).toBe(false);
    expect(isProviderLogoUrl("https://notenablebanking.com/brands/FI/Nordea/")).toBe(false);
    expect(isProviderLogoUrl(null)).toBe(false);
  });

  it("rejects responses that are not images or exceed the size limit", async () => {
    const logos = {
      html: "https://enablebanking.com/brands/AT/Html/",
      fake: "https://enablebanking.com/brands/AT/Fake/",
      huge: "https://enablebanking.com/brands/AT/Huge/",
    };
    const { fetcher, calls } = fakeFetch({
      [logos.html]: () => html("<html><body>Logo</body></html>"),
      [logos.fake]: () => image(Buffer.from("this is not an image")),
      [logos.huge]: () => new Response(new Uint8Array(16), {
        headers: { "Content-Type": "image/png", "Content-Length": String(3 * 1024 * 1024) },
      }),
    });
    const providerBanks = async (): Promise<ProviderBank[]> => [
      { name: "Html Bank", logo: logos.html },
      { name: "Fake Bank", logo: logos.fake },
      { name: "Huge Bank", logo: logos.huge },
    ];
    for (const name of ["Html Bank", "Fake Bank", "Huge Bank"])
      expect(await resolveBankLogo({ name }, { directory, fetcher, providerBanks })).toBeUndefined();
    expect(calls).toHaveLength(3);
    expect((await readdir(directory)).sort()).toEqual(["eb-fake-bank-at.miss", "eb-html-bank-at.miss", "eb-huge-bank-at.miss"]);
  });

  it("does no network work for names that neither the registry nor the provider list knows", async () => {
    const { fetcher, calls } = fakeFetch({});
    const beforeLookup = vi.fn();
    const logo = await resolveBankLogo(
      { name: "Andere Bank" },
      { directory, fetcher, beforeLookup, providerBanks: async () => [{ name: "Testbank Nord", logo: NORD }] },
    );
    expect(logo).toBeUndefined();
    expect(calls).toEqual([]);
    expect(beforeLookup).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it("deduplicates concurrent lookups, caches the provider list and rate-limits only real lookups", async () => {
    const { fetcher, calls } = fakeFetch({ [NORD]: () => image(square) });
    const providerBanks = vi.fn(async (): Promise<ProviderBank[]> => [{ name: "Testbank Nord", logo: NORD }]);
    const beforeLookup = vi.fn();
    const deps: BankLogoDeps = { directory, fetcher, providerBanks, beforeLookup };
    const [first, second] = await Promise.all([
      resolveBankLogo({ name: "Testbank Nord" }, deps),
      resolveBankLogo({ name: "Testbank Nord" }, deps),
    ]);
    expect(first?.version).toBe(second?.version);
    await resolveBankLogo({ name: "Testbank Nord" }, deps);
    expect(calls).toEqual([NORD]);
    expect(beforeLookup).toHaveBeenCalledTimes(1);
    expect(providerBanks).toHaveBeenCalledTimes(1);

    clearBankLogoCaches();
    const refused = { ...deps, directory: join(directory, "other"), beforeLookup: () => { throw new Error("Zu viele Versuche"); } };
    await expect(resolveBankLogo({ name: "Testbank Nord" }, refused)).rejects.toThrow("Zu viele Versuche");
    expect(calls).toHaveLength(1);
  });

  it("caps the cache folder by dropping the oldest misses first", async () => {
    await Promise.all(Array.from({ length: MAX_BANK_LOGO_FILES }, async (_, index) => {
      const file = join(directory, `old-${index}.miss`);
      await writeFile(file, JSON.stringify({ at: T0 }));
      const at = new Date(T0 - (MAX_BANK_LOGO_FILES - index) * 60_000);
      await utimes(file, at, at);
    }));
    const { fetcher } = fakeFetch({ [NORD]: () => image(square) });
    await resolveBankLogo({ name: "Testbank Nord" }, {
      directory, fetcher, providerBanks: async () => [{ name: "Testbank Nord", logo: NORD }],
    });
    const files = await readdir(directory);
    expect(files).toHaveLength(MAX_BANK_LOGO_FILES);
    expect(files).toContain("eb-testbank-nord-at.png");
    expect(files).not.toContain("old-0.miss");
    expect(files).toContain(`old-${MAX_BANK_LOGO_FILES - 1}.miss`);
  });
});

describe("bankLogoDirectory", () => {
  it("lives next to the private merchant logos beside the account database", () => {
    expect(bankLogoDirectory(join(root, "data", "finanzblick.sqlite"))).toBe(join(root, "data", "bank-logos"));
  });
});
