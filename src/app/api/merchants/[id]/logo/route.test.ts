import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  accountMode: vi.fn(),
  runtime: vi.fn(),
  getMerchant: vi.fn(),
  readLogo: vi.fn(),
  authorizedLogo: vi.fn(),
  currentUser: vi.fn(),
}));
vi.mock("@/lib/server/auth", () => ({
  authorizeApi: mocks.authorize,
  isAccountMode: mocks.accountMode,
}));
vi.mock("@/lib/server/runtime", () => ({ getAccountRuntime: mocks.runtime }));
vi.mock("@/lib/automation/store", () => ({
  AutomationStore: class {
    getMerchant = mocks.getMerchant;
    authorizedLogo = mocks.authorizedLogo;
  },
}));
vi.mock("@/lib/automation/merchant-logo", () => ({
  readPrivateMerchantLogo: mocks.readLogo,
}));
import { GET } from "./route";
import { merchantLogoVersion } from "@/lib/automation/merchant-logo-version";

const request = new Request("http://localhost/api/merchants/test/logo");
const context = (id = "test") => ({ params: Promise.resolve({ id }) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(null);
  mocks.accountMode.mockReturnValue(true);
  mocks.currentUser.mockReturnValue({ id: "synthetic-account" });
  mocks.runtime.mockResolvedValue({
    database: { path: "private.sqlite", currentUser: mocks.currentUser },
  });
});

describe("private merchant logo route", () => {
  it("caches only the matching image-and-attribution version privately", async () => {
    const logo = {
      file: `${"a".repeat(64)}.png`,
      license: "CC0-1.0" as const,
      attribution: "Artist v1",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.png",
    };
    mocks.getMerchant.mockReturnValue({ logo });
    mocks.readLogo.mockResolvedValue(Buffer.from([137, 80, 78, 71]));
    const version = merchantLogoVersion(logo);
    const image = new Request(`${request.url}?v=${version}`);
    const response = await GET(image, context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "private, max-age=86400, immutable",
    );
    expect(response.headers.get("Vary")).toBe("Cookie");
    mocks.getMerchant.mockReturnValue({
      logo: { ...logo, attribution: "Artist v2" },
    });
    mocks.readLogo.mockClear();
    expect((await GET(image, context())).status).toBe(404);
    expect(mocks.readLogo).not.toHaveBeenCalled();
    expect(
      (await GET(new Request(`${request.url}?v=invalid`), context())).status,
    ).toBe(404);
  });
  it("denies unauthenticated users before any store or file access", async () => {
    mocks.authorize.mockResolvedValue(
      new Response("Please sign in", { status: 401 }),
    );
    expect((await GET(request, context())).status).toBe(401);
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.readLogo).not.toHaveBeenCalled();
  });

  it("has no account database in non-account development mode", async () => {
    mocks.accountMode.mockReturnValue(false);
    expect((await GET(request, context())).status).toBe(404);
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it("returns 404 for missing metadata/files and oversized ids", async () => {
    mocks.getMerchant.mockReturnValue(null);
    mocks.readLogo.mockResolvedValue(null);
    expect((await GET(request, context())).status).toBe(404);
    expect((await GET(request, context("x".repeat(81)))).status).toBe(404);
  });

  it("serves only stored private bytes with licensing and anti-sniff/cache headers", async () => {
    const logo = {
      file: `${"a".repeat(64)}.png`,
      license: "CC-BY-4.0",
      attribution: "© Artist; resized to PNG",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Example.png",
    };
    mocks.getMerchant.mockReturnValue({ logo });
    mocks.readLogo.mockResolvedValue(Buffer.from([137, 80, 78, 71]));
    const response = await GET(request, context("../../accounts.sqlite"));
    expect(mocks.getMerchant).toHaveBeenCalledWith("../../accounts.sqlite");
    expect(mocks.readLogo).toHaveBeenCalledWith("private.sqlite", logo);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("X-Merchant-Logo-License")).toBe("CC-BY-4.0");
    expect(
      decodeURIComponent(response.headers.get("X-Merchant-Logo-Attribution")!),
    ).toBe(logo.attribution);
    expect(response.headers.get("X-Merchant-Logo-Source")).toBe(logo.sourceUrl);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
  });
});
