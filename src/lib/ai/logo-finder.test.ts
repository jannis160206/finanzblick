import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearIndustryCache } from "./industry";
import { findMerchantLogo, logoPngFromImage, pageLogoCandidates } from "./logo-finder";

type Route = (url: URL) => Response | undefined;

const png = (size: number) => sharp({
  create: { width: size, height: size, channels: 4, background: { r: 200, g: 20, b: 40, alpha: 1 } },
}).png().toBuffer();

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const json = (body: unknown) => Response.json(body);
const image = (bytes: Buffer, type = "image/png") => new Response(new Uint8Array(bytes), { headers: { "content-type": type } });

function fetcher(...routes: Route[]) {
  const calls: string[] = [];
  const run = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.href);
    for (const route of routes) {
      const response = route(url);
      if (response) return response;
    }
    throw new Error("getaddrinfo ENOTFOUND");
  }) as typeof fetch;
  return Object.assign(run, { calls });
}

const wikidata = (entities: Record<string, { label: string; logo?: string; website?: string; description?: string }>): Route =>
  (url) => {
    if (url.hostname !== "www.wikidata.org") return undefined;
    if (url.searchParams.get("action") === "wbsearchentities")
      return json({ search: Object.keys(entities).map((id) => ({ id })) });
    return json({
      entities: Object.fromEntries(Object.entries(entities).map(([id, entity]) => [id, {
        id,
        labels: { de: { value: entity.label } },
        descriptions: { de: { value: entity.description ?? "Unternehmen" } },
        claims: {
          ...(entity.logo ? { P154: [{ mainsnak: { datavalue: { value: entity.logo } }, rank: "normal" }] } : {}),
          ...(entity.website ? { P856: [{ mainsnak: { datavalue: { value: entity.website } }, rank: "normal" }] } : {}),
        },
      }])),
    });
  };

let directory: string;
beforeEach(async () => {
  clearIndustryCache();
  directory = await mkdtemp(join(tmpdir(), "logo-finder-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const options = (fetch: typeof globalThis.fetch, extra = {}) => ({ directory, fetcher: fetch, ai: false as const, throttleMs: 0, ...extra });

describe("pageLogoCandidates", () => {
  it("prefers the app icon, then vector and large icons, then header logos, never tiny favicons first", () => {
    const urls = pageLogoCandidates(`
      <link rel="icon" href="/favicon-16.png" sizes="16x16">
      <img src="/img/header-logo.png" alt="Shop">
      <link rel="icon" type="image/svg+xml" href="/icon.svg">
      <link rel="apple-touch-icon" sizes="180x180" href="/apple.png">
      <link rel="icon" sizes="192x192" href="/icon-192.png">
      <meta property="og:image" content="https://cdn.shop.at/brand-logo.png">
      <link rel="mask-icon" href="/mask.svg">
    `, new URL("https://www.shop.at/"));
    expect(urls.map((url) => url.href)).toEqual([
      "https://www.shop.at/apple.png",
      "https://www.shop.at/icon.svg",
      "https://www.shop.at/icon-192.png",
      "https://www.shop.at/img/header-logo.png",
      "https://cdn.shop.at/brand-logo.png",
      "https://www.shop.at/apple-touch-icon.png",
      "https://www.shop.at/favicon-16.png",
    ]);
  });
});

describe("logoPngFromImage", () => {
  it("renders safe SVG logos and rejects scripts, external references and tiny icons", async () => {
    const safe = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>');
    expect(await logoPngFromImage(safe, "image/svg+xml")).toBeInstanceOf(Buffer);
    const script = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>');
    expect(await logoPngFromImage(script, "image/svg+xml")).toBeUndefined();
    const external = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="url(https://x.test/a)"/></svg>');
    expect(await logoPngFromImage(external, "image/svg+xml")).toBeUndefined();
    expect(await logoPngFromImage(await png(32))).toBeUndefined();
    expect(await logoPngFromImage(await png(128))).toBeInstanceOf(Buffer);
  });
});

describe("findMerchantLogo", () => {
  it("stores the Wikidata logo from Wikimedia Commons", async () => {
    const logo = await png(256);
    const fetch = fetcher(
      wikidata({ Q1: { label: "Billa", logo: "Billa Logo.svg" } }),
      (url) => url.hostname === "commons.wikimedia.org"
        ? json({ query: { pages: { 1: { imageinfo: [{ url: "https://upload.wikimedia.org/billa.png" }] } } } }) : undefined,
      (url) => url.hostname === "upload.wikimedia.org" ? image(logo) : undefined,
    );
    const outcome = await findMerchantLogo("Billa", undefined, options(fetch));
    expect(outcome).toMatchObject({ status: "saved", file: "Billa.png", entity: "Q1" });
    expect(await readdir(directory)).toEqual(["Billa.png"]);
  });

  it("takes the icon of the official website when Wikidata has no logo", async () => {
    const logo = await png(180);
    const fetch = fetcher(
      wikidata({ Q2: { label: "Kukowitsch", website: "http://www.kukowitsch.at" } }),
      (url) => url.href === "https://www.kukowitsch.at/"
        ? html('<title>Kukowitsch</title><link rel="apple-touch-icon" href="/touch.png">') : undefined,
      (url) => url.href === "https://www.kukowitsch.at/touch.png" ? image(logo) : undefined,
    );
    const outcome = await findMerchantLogo("Kukowitsch", undefined, options(fetch));
    expect(outcome).toMatchObject({ status: "saved", file: "Kukowitsch.png", source: "https://www.kukowitsch.at/touch.png" });
  });

  it("guesses the brand domain only when the page presents that brand", async () => {
    const logo = await png(192);
    const fetch = fetcher(
      (url) => url.hostname === "www.wikidata.org" ? json({ search: [] }) : undefined,
      (url) => url.href === "https://www.myelite.at/"
        ? html('<title>Domain zu verkaufen</title><link rel="icon" sizes="192x192" href="/i.png">') : undefined,
      (url) => url.href === "https://www.myelite.de/"
        ? html('<meta property="og:site_name" content="MyElite"><link rel="icon" sizes="192x192" href="/i.png">') : undefined,
      (url) => url.href === "https://www.myelite.de/i.png" ? image(logo) : undefined,
    );
    const outcome = await findMerchantLogo("Myelite", undefined, options(fetch));
    expect(outcome).toMatchObject({ status: "saved", file: "Myelite.png", source: "https://www.myelite.de/i.png" });
    expect(fetch.calls).not.toContain("https://www.myelite.at/i.png");

    const other = fetcher(
      (url) => url.hostname === "www.wikidata.org" ? json({ search: [] }) : undefined,
      (url) => url.hostname.startsWith("www.kebabhaus.")
        ? html('<title>Ganz andere Firma</title><link rel="icon" sizes="192x192" href="/i.png">') : undefined,
      (url) => url.pathname === "/i.png" ? image(logo) : undefined,
    );
    expect(await findMerchantLogo("Kebabhaus", undefined, options(other))).toMatchObject({ status: "not-found" });
    expect(await findMerchantLogo("Kebabhaus", undefined, options(other, { guessWebsite: false }))).toMatchObject({ status: "not-found" });
  });

  it("reports a rate-limited registry as transient and never reaches local hosts", async () => {
    const fetch = fetcher(
      (url) => url.hostname === "www.wikidata.org" ? new Response("", { status: 429, headers: { "retry-after": "60" } }) : undefined,
      (url) => url.href === "https://www.lokal.at/"
        ? new Response("", { status: 302, headers: { location: "https://127.0.0.1/" } }) : undefined,
    );
    const outcome = await findMerchantLogo("Lokal", undefined, options(fetch));
    expect(outcome).toMatchObject({ status: "not-found", transient: true });
    expect(fetch.calls.some((call) => call.includes("127.0.0.1"))).toBe(false);
  });

  it("finds a local shop's website through OpenStreetMap at the place the card was used", async () => {
    const logo = await png(180);
    const place = (name: string, address: string, website?: string) => ({
      category: "shop", type: "bakery", name, display_name: address, ...(website ? { extratags: { website } } : {}),
    });
    const fetch = fetcher(
      (url) => url.hostname === "www.wikidata.org" ? json({ search: [] }) : undefined,
      (url) => url.hostname === "nominatim.openstreetmap.org" && url.searchParams.get("extratags") === "1"
        ? json([
          place("Atriovil", "Hauptplatz 1, 9500 Villach, Österreich", "atriovil.at"),
          place("Atriovil", "Ring 2, 1010 Wien, Österreich", "https://andere.at"),
        ]) : undefined,
      (url) => url.href === "https://atriovil.at/" ? html('<link rel="apple-touch-icon" href="/a.png">') : undefined,
      (url) => url.href === "https://atriovil.at/a.png" ? image(logo) : undefined,
    );
    const outcome = await findMerchantLogo("Atriovil", undefined, options(fetch, { place: { city: "Villach", postcode: "9500" }, guessWebsite: false }));
    expect(outcome).toMatchObject({ status: "saved", file: "Atriovil.png", source: "https://atriovil.at/a.png" });

    clearIndustryCache();
    const other = await findMerchantLogo("Atriovil", undefined, options(fetch, {
      directory: join(directory, "other"), place: { city: "Graz", postcode: "8010" }, guessWebsite: false,
    }));
    expect(other).toMatchObject({ status: "not-found" });
  });

  it("takes the brand logo OpenStreetMap links for the branch, even when the name search is ambiguous", async () => {
    const logo = await png(256);
    const entities = wikidata({ Q9: { label: "Burger King", logo: "BK.svg" } });
    const fetch = fetcher(
      (url) => url.hostname === "www.wikidata.org" && url.searchParams.get("action") === "wbsearchentities"
        ? json({ search: [] }) : entities(url),
      (url) => url.hostname === "nominatim.openstreetmap.org" ? json([{
        category: "amenity", type: "fast_food", name: "Burger King",
        display_name: "Burger King, B83, 9212 Techelsberg, Österreich", extratags: { "brand:wikidata": "Q9" },
      }]) : undefined,
      (url) => url.hostname === "commons.wikimedia.org"
        ? json({ query: { pages: { 1: { imageinfo: [{ url: "https://upload.wikimedia.org/bk.png" }] } } } }) : undefined,
      (url) => url.hostname === "upload.wikimedia.org" ? image(logo) : undefined,
    );
    const outcome = await findMerchantLogo("Burger King", undefined, options(fetch, { place: { postcode: "9212", city: "Techelsberg" } }));
    expect(outcome).toMatchObject({ status: "saved", file: "Burger King.png", entity: "Q9" });
  });

  it("keeps the alias as file name and reuses an existing logo", async () => {
    await writeFile(join(directory, "OBI.png"), await png(128));
    const fetch = fetcher();
    expect(await findMerchantLogo("OBI", undefined, options(fetch))).toEqual({ status: "exists", file: "OBI.png" });
    expect(fetch.calls).toEqual([]);
    const logo = await png(256);
    const saving = fetcher(
      wikidata({ Q3: { label: "Hornbach", logo: "Hornbach.svg" } }),
      (url) => url.hostname === "commons.wikimedia.org"
        ? json({ query: { pages: { 1: { imageinfo: [{ url: "https://upload.wikimedia.org/h.png" }] } } } }) : undefined,
      (url) => url.hostname === "upload.wikimedia.org" ? image(logo) : undefined,
    );
    const outcome = await findMerchantLogo("Hornbach", undefined, options(saving, { saveAs: "Hornbach Baumarkt" }));
    expect(outcome).toMatchObject({ status: "saved", file: "Hornbach Baumarkt.png" });
    expect((await readFile(join(directory, "Hornbach Baumarkt.png"))).subarray(1, 4).toString()).toBe("PNG");
  });
});
