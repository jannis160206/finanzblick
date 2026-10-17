import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  merchantMarksRequestSchema,
  merchantMarksResponseSchema,
} from "@/lib/automation/merchant-presentation-schema";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  accountMode: vi.fn(),
  runtime: vi.fn(),
  constructStore: vi.fn(),
  presentations: vi.fn(),
  namedPresentations: vi.fn(),
  bookingPresentations: vi.fn(),
}));
vi.mock("@/lib/server/auth", () => ({
  authorizeApi: mocks.authorize,
  isAccountMode: mocks.accountMode,
}));
vi.mock("@/lib/server/runtime", () => ({ getAccountRuntime: mocks.runtime }));
vi.mock("@/lib/automation/store", () => ({
  AutomationStore: class {
    constructor(database: unknown) {
      mocks.constructStore(database);
    }
  },
}));
vi.mock("@/lib/automation/merchant-logo-presentations", () => ({
  accountMerchantPresentations: mocks.presentations,
  accountMerchantNamePresentations: mocks.namedPresentations,
}));
vi.mock("@/lib/automation/merchant-booking-presentations", () => ({
  accountMerchantBookingPresentations: mocks.bookingPresentations,
}));
import { POST } from "./route";

const url = "http://localhost/api/merchants/marks";
const database = { path: "synthetic-private.sqlite", currentUser: vi.fn() };
let network: ReturnType<typeof vi.fn<typeof fetch>>;
function request(
  body: unknown = { merchantIds: ["at-example"] },
  headers: HeadersInit = {},
) {
  const merged = new Headers({ "Content-Type": "application/json" });
  new Headers(headers).forEach((value, key) => merged.set(key, value));
  return new Request(url, {
    method: "POST",
    headers: merged,
    body: JSON.stringify(body),
  });
}
function streamedRequest(chunks: Uint8Array[], contentLength?: string) {
  const cancel = vi.fn();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel,
  });
  const headers = new Headers({ "Content-Type": "application/json" });
  if (contentLength !== undefined) headers.set("Content-Length", contentLength);
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body,
    headers,
    duplex: "half",
  };
  return { incoming: new Request(url, init), cancel };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(null);
  mocks.accountMode.mockReturnValue(true);
  mocks.runtime.mockResolvedValue({ database });
  database.currentUser.mockReturnValue({ id: "synthetic-account" });
  mocks.presentations.mockImplementation(async (_store, input) => {
    const { merchantIds } = merchantMarksRequestSchema.parse(input);
    return [...new Set(merchantIds)].map((merchantId) => ({
      merchantId,
      logo: null,
    }));
  });
  mocks.namedPresentations.mockImplementation(async (_store, names: string[]) =>
    names.map((merchantName) => ({ merchantName, logo: null })),
  );
  mocks.bookingPresentations.mockImplementation(async (_store, ids: string[]) =>
    [...new Set(ids)].map((bookingId) => ({ bookingId, logo: null })),
  );
  network = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("Network forbidden"));
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("private batched merchant marks API", () => {
  it("resolves booking references only under the session account within the shared batch cap", async () => {
    const input = {
      merchantIds: ["amazon"],
      merchantNames: ["Audi"],
      bookingIds: ["legacy"],
    };
    const response = await POST(request(input));
    expect(await response.json()).toEqual({
      marks: [{ merchantId: "amazon", logo: null }],
      nameMarks: [{ merchantName: "Audi", logo: null }],
      bookingMarks: [{ bookingId: "legacy", logo: null }],
    });
    expect(mocks.bookingPresentations).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      ["legacy"],
      "synthetic-account",
      expect.any(Object),
    );
    for (const body of [
      { merchantIds: Array(100).fill("amazon"), bookingIds: ["legacy"] },
      { merchantIds: [], bookingIds: ["private\nid"] },
      { merchantIds: [], bookingIds: ["a".repeat(2001)] },
      { ...input, userId: "foreign-account" },
    ])
      expect((await POST(request(body))).status).toBe(400);
    expect(() =>
      merchantMarksResponseSchema.parse({
        marks: Array(100).fill({ merchantId: "amazon", logo: null }),
        bookingMarks: [{ bookingId: "legacy", logo: null }],
      }),
    ).toThrow();
  });
  it("resolves named marks locally under the authenticated account with a combined batch limit", async () => {
    const input = { merchantIds: ["at-shell"], merchantNames: ["Audi"] };
    const response = await POST(request(input));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      marks: [{ merchantId: "at-shell", logo: null }],
      nameMarks: [{ merchantName: "Audi", logo: null }],
    });
    expect(mocks.namedPresentations).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      ["Audi"],
      "synthetic-account",
      expect.any(Object),
    );
    for (const body of [
      { merchantIds: Array(100).fill("at-shell"), merchantNames: ["Audi"] },
      { merchantIds: [], merchantNames: ["Audi\nprivate"] },
    ]) {
      expect((await POST(request(body))).status).toBe(400);
    }
  });
  it("exports only supported Next route fields", async () => {
    const route = await import("./route");
    expect(Object.keys(route).sort()).toEqual(["POST", "runtime"]);
    expect(route.runtime).toBe("nodejs");
  });

  it("returns 401 before mode, body, database, store or helper access", async () => {
    const denied = new Response("Please sign in", { status: 401 });
    mocks.authorize.mockResolvedValue(denied);
    const incoming = request();
    const reader = vi.spyOn(incoming.body!, "getReader");
    expect(await POST(incoming)).toBe(denied);
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith(incoming);
    expect(mocks.accountMode).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.constructStore).not.toHaveBeenCalled();
    expect(mocks.presentations).not.toHaveBeenCalled();
  });

  it("returns an empty list in local mode without requiring JSON or opening a database", async () => {
    mocks.accountMode.mockReturnValue(false);
    const response = await POST(
      new Request(url, { method: "POST", body: "not JSON" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ marks: [] });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.runtime).not.toHaveBeenCalled();
    expect(mocks.constructStore).not.toHaveBeenCalled();
    expect(mocks.presentations).not.toHaveBeenCalled();
  });

  it("returns only public mark IDs and actual asset IDs, with no financial or licensing payload", async () => {
    const marks = [
      {
        merchantId: "at-example",
        logo: { merchantId: "proven-example", version: "a".repeat(64) },
      },
      { merchantId: "unknown", logo: null },
    ];
    mocks.presentations.mockResolvedValue(marks);
    const incoming = request({ merchantIds: ["at-example", "unknown"] });
    const response = await POST(incoming);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await response.json();
    expect(body).toEqual({ marks });
    expect(merchantMarksResponseSchema.parse(body)).toEqual(body);
    expect(JSON.stringify(body)).not.toMatch(
      /finance|accounts|transactions|amount|aliases|attribution|sourceUrl|sqlite/,
    );
    expect(mocks.constructStore).toHaveBeenCalledExactlyOnceWith(database);
    expect(mocks.presentations).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      { merchantIds: ["at-example", "unknown"] },
      "synthetic-account",
      expect.any(Object),
    );
  });

  it.each([
    "text/plain",
    "application/x-www-form-urlencoded",
    "application/jsonp",
    "",
  ])(
    "rejects unsupported Content-Type %s before database access",
    async (contentType) => {
      const response = await POST(
        request(undefined, { "Content-Type": contentType }),
      );
      expect(response.status).toBe(415);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(mocks.runtime).not.toHaveBeenCalled();
      expect(mocks.presentations).not.toHaveBeenCalled();
    },
  );

  it("accepts application/json with a charset", async () => {
    expect(
      (
        await POST(
          request(undefined, {
            "Content-Type": "application/json; charset=utf-8",
          }),
        )
      ).status,
    ).toBe(200);
  });

  it.each(["{", "", '{"merchantIds":'])(
    "rejects malformed JSON as 400 without database access: %j",
    async (body) => {
      const response = await POST(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      );
      expect(response.status).toBe(400);
      expect(mocks.runtime).not.toHaveBeenCalled();
      expect(mocks.presentations).not.toHaveBeenCalled();
    },
  );

  it("rejects an absent body and invalid UTF-8 as 400", async () => {
    for (const body of [undefined, new Uint8Array([0xff])]) {
      const response = await POST(
        new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      );
      expect(response.status).toBe(400);
    }
    expect(mocks.runtime).not.toHaveBeenCalled();
  });

  it.each(["16385", "-1", "NaN"])(
    "rejects oversized or malformed declared lengths: %s",
    async (contentLength) => {
      const response = await POST(
        request(undefined, { "Content-Length": contentLength }),
      );
      expect(response.status).toBe(413);
      expect(mocks.runtime).not.toHaveBeenCalled();
      expect(mocks.presentations).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "1"])(
    "bounds streamed bytes to 16 KiB even with declared length %s",
    async (contentLength) => {
      const { incoming, cancel } = streamedRequest(
        [
          new Uint8Array(8192).fill(32),
          new Uint8Array(8192).fill(32),
          new Uint8Array([32]),
          new Uint8Array([32]),
        ],
        contentLength,
      );
      const response = await POST(incoming);
      expect(response.status).toBe(413);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(mocks.runtime).not.toHaveBeenCalled();
      expect(mocks.presentations).not.toHaveBeenCalled();
    },
  );

  it("accepts exactly 16 KiB of valid streamed JSON", async () => {
    const json = JSON.stringify({ merchantIds: [] });
    const bytes = new TextEncoder().encode(
      json + " ".repeat(16 * 1024 - json.length),
    );
    const { incoming } = streamedRequest([
      bytes.subarray(0, 8192),
      bytes.subarray(8192),
    ]);
    const response = await POST(incoming);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ marks: [] });
  });

  it.each([
    null,
    [],
    {},
    { merchantIds: [123] },
    { merchantIds: ["../../private"] },
    { merchantIds: [""] },
    { merchantIds: ["a".repeat(81)] },
    { merchantIds: Array(101).fill("at-example") },
    { merchantIds: ["at-example"], financialData: "private" },
  ])(
    "returns explicit 400 for invalid public ID requests: %j",
    async (body) => {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(await response.json()).toEqual({ error: expect.any(String) });
    },
  );

  it("passes duplicate and unknown IDs to the helper, returning its bounded result", async () => {
    const response = await POST(
      request({ merchantIds: ["unknown", "unknown"] }),
    );
    expect(await response.json()).toEqual({
      marks: [{ merchantId: "unknown", logo: null }],
    });
    expect(mocks.presentations).toHaveBeenCalledWith(
      expect.any(Object),
      {
        merchantIds: ["unknown", "unknown"],
      },
      "synthetic-account",
      expect.any(Object),
    );
  });

  it("never creates undefined-account grants when the authenticated session disappeared", async () => {
    database.currentUser.mockReturnValue(null);
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mocks.presentations).not.toHaveBeenCalled();
  });

  it.each(["runtime", "store", "helper"])(
    "reports %s backend failures explicitly as private no-store 500 errors",
    async (failure) => {
      const error = new Error("Sensitive synthetic SQL/account details");
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      if (failure === "runtime") mocks.runtime.mockRejectedValue(error);
      if (failure === "store")
        mocks.constructStore.mockImplementation(() => {
          throw error;
        });
      if (failure === "helper") mocks.presentations.mockRejectedValue(error);
      const response = await POST(request());
      expect(response.status).toBe(500);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const body = await response.json();
      expect(body).toEqual({ error: expect.any(String) });
      expect(body).not.toHaveProperty("marks");
      expect(JSON.stringify(body)).not.toContain(error.message);
      expect(log).toHaveBeenCalledWith("Account operation failed:", "Error");
    },
  );
});
