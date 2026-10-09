import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  accountMode: vi.fn(),
  runtime: vi.fn(),
  getMerchant: vi.fn(),
  archived: vi.fn(),
}));
vi.mock("@/lib/server/auth", () => ({
  authorizeApi: mocks.authorize,
  isAccountMode: mocks.accountMode,
}));
vi.mock("@/lib/server/runtime", () => ({ getAccountRuntime: mocks.runtime }));
vi.mock("@/lib/automation/store", () => ({
  AutomationStore: class {
    getMerchant = mocks.getMerchant;
    logoAttribution = mocks.archived;
  },
}));
import { GET } from "./route";

const request = new Request("http://localhost/api/merchants/test/attribution");
const context = (id = "test") => ({ params: Promise.resolve({ id }) });
const merchant = {
  canonicalName: "Example <Shop>",
  source: "osm",
  city: null,
  license: "ODbL-1.0",
  attribution: "© OpenStreetMap contributors",
  logo: {
    file: `${"a".repeat(64)}.png`,
    license: "CC-BY-4.0",
    attribution: '© Artist <script>alert("unsafe")</script>; resized to PNG',
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.png",
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(null);
  mocks.accountMode.mockReturnValue(true);
  mocks.runtime.mockResolvedValue({ database: { path: "private.sqlite" } });
  mocks.getMerchant.mockReturnValue(merchant);
});

describe("visible private logo attribution", () => {
  it("shows the exact archived image credits after refresh or removal, not the current version", async () => {
    const version = "a".repeat(64);
    const logo = {
      ...merchant.logo,
      attribution: "Original artist; original version",
    };
    mocks.getMerchant.mockReturnValue({
      ...merchant,
      canonicalName: "Renamed brand",
      logo: null,
    });
    mocks.archived.mockReturnValue({ canonicalName: "Original brand", logo });
    const response = await GET(
      new Request(`${request.url}?v=${version}`),
      context(),
    );
    expect(response.status).toBe(200);
    expect(mocks.archived).toHaveBeenCalledWith("test", version);
    expect(await response.text()).toContain(
      "Original artist; original version",
    );
    mocks.archived.mockReturnValue(null);
    expect(
      (await GET(new Request(`${request.url}?v=${version}`), context())).status,
    ).toBe(404);
    expect(
      (await GET(new Request(`${request.url}?v=bad`), context())).status,
    ).toBe(404);
  });
  it("requires authorization before accessing metadata", async () => {
    mocks.authorize.mockResolvedValue(
      new Response("Please sign in", { status: 401 }),
    );
    expect((await GET(request, context())).status).toBe(401);
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.getMerchant).not.toHaveBeenCalled();
  });

  it("has no server attribution in non-account mode", async () => {
    mocks.accountMode.mockReturnValue(false);
    expect((await GET(request, context())).status).toBe(404);
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("rejects missing, invalid or unlicensed metadata without arbitrary source links", async () => {
    for (const input of [
      null,
      { ...merchant, logo: { ...merchant.logo, license: "Unlicensed" } },
      {
        ...merchant,
        logo: { ...merchant.logo, sourceUrl: "javascript:alert(1)" },
      },
      {
        ...merchant,
        logo: { ...merchant.logo, sourceUrl: "https://evil.example/image" },
      },
    ]) {
      mocks.getMerchant.mockReturnValue(input);
      const response = await GET(request, context());
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect((await GET(request, context("x".repeat(81)))).status).toBe(404);
  });

  it("serves data provenance and logo credits as plain text, never executable HTML", async () => {
    const response = await GET(request, context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    const text = await response.text();
    expect(text).toContain("Händler: Example <Shop>");
    expect(text).toContain("Datenquelle: osm");
    expect(text).toContain("Datenlizenz: ODbL-1.0");
    expect(text).toContain("Daten-Quellenangabe: © OpenStreetMap contributors");
    expect(text).toContain("Logo-Lizenz: CC-BY-4.0");
    expect(text).toContain('© Artist <script>alert("unsafe")</script>');
    expect(text).not.toContain("<!doctype");
    expect(text).not.toContain("<a href=");
    expect(text).toContain(
      "Logo-Originalquelle: https://commons.wikimedia.org/wiki/File:Example.png",
    );
  });

  it("shows nullable data metadata explicitly when no logo is available", async () => {
    mocks.getMerchant.mockReturnValue({
      ...merchant,
      license: null,
      attribution: null,
      logo: null,
    });
    const response = await GET(request, context());
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Datenlizenz: Nicht angegeben");
    expect(text).toContain("Daten-Quellenangabe: Nicht angegeben");
    expect(text).toContain("Logo: Nicht verfügbar.");
  });
});
