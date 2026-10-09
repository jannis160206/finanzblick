import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountDatabase, hashToken } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { requestSessionToken, sessionCookieName } from "@/lib/server/http";
import { merchantSchema } from "./merchants";
import { AutomationStore } from "./store";
import { authorizedMerchantLogoSchema } from "./merchant-logo-grant-metadata";
import {
  acquireAuthorizedLogoImport,
  authorizedLogoDirectory,
  MAX_ACCOUNT_LOGO_VERSIONS,
  MAX_TOTAL_PRIVATE_LOGO_FILES,
  readAuthorizedMerchantLogo,
} from "./merchant-logo-grants";
import {
  importAuthorizedCommonsLogos,
  importAuthorizedLocalLogos,
  importReviewedCommonsLogos,
  MAX_AUTHORIZED_LOGO_ENTITIES,
} from "./merchant-logo-authorized-import";
import {
  privateMerchantLogoSchema,
  retrieveMerchantLogo,
} from "./merchant-logo";
import {
  normalizeLogoRaster,
  writeStoredLogoPng,
} from "./merchant-logo-raster";
import { merchantLogoVersion } from "./merchant-logo-version";
import { accountMerchantPresentations } from "./merchant-logo-presentations";

const api = vi.hoisted(() => ({ runtime: vi.fn(), authorize: vi.fn() }));
vi.mock("@/lib/server/runtime", () => ({ getAccountRuntime: api.runtime }));
vi.mock("@/lib/server/auth", () => ({
  isAccountMode: () => true,
  authorizeApi: api.authorize,
}));
import { POST as marksApi } from "@/app/api/merchants/marks/route";
import { GET as logoApi } from "@/app/api/merchants/[id]/logo/route";
import { GET as attributionApi } from "@/app/api/merchants/[id]/attribution/route";

let directory: string;
let accounts: AccountDatabase;
let store: AutomationStore;
let alice: string;
let bob: string;
let network: ReturnType<typeof vi.fn<typeof fetch>>;
const rightsReference = "User confirmed private usage rights, 2026-10-09";
const filename = "Synthetic shape.png";
const upload =
  "https://upload.wikimedia.org/wikipedia/commons/a/ab/Synthetic_shape.png";

function merchant(id = "example", wikidataId: string | null = "Q123") {
  return merchantSchema.parse({
    id,
    canonicalName: "Synthetic market",
    aliases: ["Synthetic merchant"],
    regexPatterns: [],
    defaultCategory: null,
    region: "AT",
    source: "local",
    wikidataId,
    updatedAt: 1,
  });
}

async function raster(
  color = 20,
  width = 32,
  height = 24,
  format: "png" | "jpeg" | "webp" = "png",
) {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: color, g: 40, b: 60, alpha: 1 },
    },
  })
    .toFormat(format)
    .toBuffer();
}

async function manifest(
  entries = [
    {
      merchantId: "example",
      file: "shape.png",
      attribution: "Operator-provided synthetic raster",
    },
  ],
) {
  const path = join(directory, "manifest.json");
  await writeFile(path, JSON.stringify({ entries }));
  return path;
}

async function importLocal(color = 20, reference = rightsReference) {
  await writeFile(join(directory, "shape.png"), await raster(color));
  return importAuthorizedLocalLogos(store, {
    userId: alice,
    rightsReference: reference,
    manifestPath: await manifest(),
  });
}

async function sharedPublicLogo() {
  const png = (await normalizeLogoRaster(await raster(70)))!;
  const file = await writeStoredLogoPng(join(directory, "merchant-logos"), png);
  return privateMerchantLogoSchema.parse({
    file,
    license: "CC0-1.0",
    attribution: "Synthetic public raster",
    sourceUrl: "https://commons.wikimedia.org/wiki/File:Synthetic_shape.png",
  });
}

function makeCurrentGrantLegacy() {
  const grant = store.authorizedLogo(alice, "example")!;
  const version = createHash("sha256")
    .update(
      JSON.stringify({
        account: alice,
        logo: authorizedMerchantLogoSchema.parse(grant.logo),
      }),
    )
    .digest("hex");
  accounts.transaction((db) =>
    db
      .prepare(
        `UPDATE merchant_authorized_logos
    SET version = ? WHERE user_id = ? AND merchant_id = ? AND version = ?`,
      )
      .run(version, alice, grant.merchantId, grant.version),
  );
  return { ...grant, version };
}

function request(
  path: string,
  who: "alice" | "bob" | "none" = "alice",
  body?: unknown,
) {
  return new Request(`http://localhost/api/merchants/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(who === "none"
        ? {}
        : {
            Cookie: `${sessionCookieName()}=${hashToken(`${who}-fixture-token`)}`,
          }),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function commonsRequests(
  info: Record<string, unknown> = {},
  sourceFilename = filename,
  includeClaims = true,
) {
  if (includeClaims)
    network.mockResolvedValueOnce(
      Response.json({
        claims: {
          P154: [
            {
              rank: "normal",
              mainsnak: {
                snaktype: "value",
                datavalue: { type: "string", value: sourceFilename },
              },
            },
          ],
        },
      }),
    );
  network.mockResolvedValueOnce(
    Response.json({
      query: {
        pages: {
          "1": {
            imageinfo: [
              {
                url: upload,
                size: 1024,
                width: 32,
                height: 24,
                mime: "image/png",
                extmetadata: {
                  Restrictions: { value: "trademarked" },
                  Artist: { value: "Synthetic artist" },
                },
                ...info,
              },
            ],
          },
        },
      },
    }),
  );
}

beforeEach(async () => {
  directory = createTestDirectory();
  accounts = new AccountDatabase(join(directory, "authorized-fixture.sqlite"));
  store = new AutomationStore(accounts);
  alice = randomUUID();
  bob = randomUUID();
  accounts.transaction((db) => {
    for (const [id, username] of [
      [alice, "alice"],
      [bob, "bob"],
    ]) {
      db.prepare(
        "INSERT INTO users VALUES (?, ?, 'user', 'fixture-not-a-password', 1)",
      ).run(id, username);
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
        hashToken(hashToken(`${username}-fixture-token`)),
        id,
        Date.now() + 60_000,
      );
    }
  });
  store.upsertMerchants([merchant()]);
  network = vi
    .fn<typeof fetch>()
    .mockRejectedValue(new Error("External network forbidden in tests"));
  vi.stubGlobal("fetch", network);
  api.runtime.mockResolvedValue({ database: accounts });
  api.authorize.mockImplementation(async (incoming) =>
    accounts.currentUser(requestSessionToken(incoming))
      ? null
      : new Response("Please sign in", { status: 401 }),
  );
});

afterEach(async () => {
  accounts.close();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("account-scoped authorized logos", () => {
  it("imports explicitly reviewed Commons artwork without inventing P154 proof, preserving finance and tenant isolation", async () => {
    const evidence =
      "Commons file description explicitly identifies this synthetic market logo; operator verified its exact public entity and artwork association.";
    const path = join(directory, "reviewed.json");
    await writeFile(
      path,
      JSON.stringify({
        entries: [
          {
            merchantId: "example",
            wikidataId: "Q123",
            filename,
            evidence,
          },
        ],
      }),
    );
    accounts.putFinance(alice, blankTestState(), 0);
    const before = accounts.getFinance(alice);
    for (const expected of [
      { imported: 1, cached: 0 },
      { imported: 0, cached: 1 },
    ]) {
      commonsRequests({}, filename, false);
      network.mockResolvedValueOnce(
        new Response(new Uint8Array(await raster())),
      );
      expect(
        await importReviewedCommonsLogos(store, {
          userId: alice,
          rightsReference,
          manifestPath: path,
        }),
      ).toMatchObject({ ...expected, skipped: [] });
    }
    const grant = store.authorizedLogo(alice, "example")!;
    expect(grant.logo.provenance).toMatchObject({
      kind: "commons",
      wikidataId: "Q123",
      associationEvidence: evidence,
    });
    expect(grant.logo.attribution).toContain(
      "Operator-reviewed file association",
    );
    expect(grant.logo.attribution).not.toContain("P154 reference");
    expect(
      network.mock.calls.every(
        ([url]) => !String(url).includes("wikidata.org"),
      ),
    ).toBe(true);
    expect(accounts.getFinance(alice)).toEqual(before);
    expect(store.authorizedLogo(bob, "example")).toBeNull();
    expect(
      await accountMerchantPresentations(
        store,
        { merchantIds: ["example"] },
        bob,
      ),
    ).toEqual([{ merchantId: "example", logo: null }]);
    expect(store.getMerchant("example")?.logo).toBeNull();
  });

  it("rejects unknown or mismatched reviewed identities before network requests", async () => {
    const path = join(directory, "reviewed.json");
    for (const entry of [
      { merchantId: "unknown", wikidataId: "Q123" },
      { merchantId: "example", wikidataId: "Q999" },
    ]) {
      await writeFile(
        path,
        JSON.stringify({
          entries: [
            {
              ...entry,
              filename,
              evidence:
                "Operator verified the public source description and exact file subject association.",
            },
          ],
        }),
      );
      await expect(
        importReviewedCommonsLogos(store, {
          userId: alice,
          rightsReference,
          manifestPath: path,
        }),
      ).rejects.toThrow("exact existing public merchant entity");
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("serves private exact-name marks only for their owning account and never mutates finance", async () => {
    await importLocal();
    const { accountMerchantNamePresentations } =
      await import("./merchant-logo-presentations");
    const before = accounts.getFinance(alice);
    const own = await accountMerchantNamePresentations(
      store,
      ["Synthetic market"],
      alice,
    );
    expect(own[0].logo?.merchantId).toBe("example");
    expect(
      await accountMerchantNamePresentations(store, ["Synthetic market"], bob),
    ).toEqual([{ merchantName: "Synthetic market", logo: null }]);
    expect(accounts.getFinance(alice)).toEqual(before);
  });

  it("imports locally idempotently, without finance/aliases/shared logos mutations or external traffic", async () => {
    accounts.putFinance(alice, blankTestState(), 0);
    const before = accounts.read((db) => ({
      merchants: db.prepare("SELECT * FROM merchants").all(),
      finance: db.prepare("SELECT * FROM finance").all(),
      users: db.prepare("SELECT * FROM users").all(),
      sessions: db.prepare("SELECT * FROM sessions").all(),
    }));
    expect(await importLocal()).toMatchObject({ imported: 1, cached: 0 });
    expect(await importLocal()).toMatchObject({ imported: 0, cached: 1 });
    const grant = store.authorizedLogo(alice, "example")!;
    expect(privateMerchantLogoSchema.safeParse(grant.logo).success).toBe(false);
    expect(
      privateMerchantLogoSchema.safeParse({
        ...grant.logo,
        license: "CC0-1.0",
        sourceUrl:
          "https://commons.wikimedia.org/wiki/File:Synthetic_shape.png",
      }).success,
    ).toBe(false);
    expect(() =>
      merchantSchema.parse({ ...merchant(), logo: grant.logo }),
    ).toThrow();
    expect(grant.logo).toMatchObject({
      rightsReference,
      permission: "operator-declared-private-usage-rights",
      publicRights: null,
    });
    expect(
      await readAuthorizedMerchantLogo(accounts.path, alice, grant.logo),
    ).not.toBeNull();
    expect(
      await readAuthorizedMerchantLogo(accounts.path, bob, grant.logo),
    ).toBeNull();
    expect(
      accounts.read((db) => ({
        merchants: db.prepare("SELECT * FROM merchants").all(),
        finance: db.prepare("SELECT * FROM finance").all(),
        users: db.prepare("SELECT * FROM users").all(),
        sessions: db.prepare("SELECT * FROM sessions").all(),
      })),
    ).toEqual(before);
    expect(
      accounts.read(
        (db) =>
          db
            .prepare("SELECT count(*) AS n FROM merchant_authorized_logos")
            .get()?.n,
      ),
    ).toBe(1);
    expect(
      await readdir(authorizedLogoDirectory(accounts.path, alice)),
    ).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
  });

  it("makes all API surfaces private-first and denies another account even with a known version/file", async () => {
    await importLocal();
    const grant = store.authorizedLogo(alice, "example")!;
    const ctx = { params: Promise.resolve({ id: "example" }) };
    for (const who of ["alice", "bob"] as const) {
      const marks = await marksApi(
        request("marks", who, {
          merchantIds: ["example", "example", "unknown"],
        }),
      );
      expect(await marks.json()).toEqual({
        marks: [
          {
            merchantId: "example",
            logo:
              who === "alice"
                ? { merchantId: "example", version: grant.version }
                : null,
          },
          { merchantId: "unknown", logo: null },
        ],
      });
      for (const suffix of ["", `?v=${grant.version}`]) {
        const image = await logoApi(request(`example/logo${suffix}`, who), ctx);
        const attribution = await attributionApi(
          request(`example/attribution${suffix}`, who),
          ctx,
        );
        if (who === "alice") {
          expect(image.status).toBe(200);
          expect(image.headers.get("Vary")).toBe("Cookie");
          expect(image.headers.get("X-Merchant-Logo-Permission")).toBe(
            grant.logo.permission,
          );
          expect(image.headers.get("X-Merchant-Logo-License")).toBeNull();
          expect(attribution.status).toBe(200);
          expect(await attribution.text()).toContain(rightsReference);
        } else {
          expect(image.status).toBe(404);
          expect(await attribution.text()).not.toContain(rightsReference);
          if (suffix) expect(attribution.status).toBe(404);
        }
      }
    }
    expect(
      (await marksApi(request("marks", "none", { merchantIds: ["example"] })))
        .status,
    ).toBe(401);
    expect((await logoApi(request("example/logo", "none"), ctx)).status).toBe(
      401,
    );
    expect(
      (await attributionApi(request("example/attribution", "none"), ctx))
        .status,
    ).toBe(401);
    expect(store.authorizedLogo(bob, "example", grant.version)).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps account-scoped permission and image history for immutable cached versions", async () => {
    await importLocal();
    const old = store.authorizedLogo(alice, "example")!;
    const oldBytes = await readAuthorizedMerchantLogo(
      accounts.path,
      alice,
      old.logo,
    );
    await importLocal(90, "Second private declaration, not a licence document");
    const current = store.authorizedLogo(alice, "example")!;
    expect(current.version).not.toBe(old.version);
    expect(store.authorizedLogo(alice, "example", old.version)).toEqual(old);
    const ctx = { params: Promise.resolve({ id: "example" }) };
    const oldImage = await logoApi(
      request(`example/logo?v=${old.version}`),
      ctx,
    );
    expect(oldImage.headers.get("Cache-Control")).toBe(
      "private, max-age=86400, immutable",
    );
    expect(Buffer.from(await oldImage.arrayBuffer())).toEqual(oldBytes);
    const oldCredits = await attributionApi(
      request(`example/attribution?v=${old.version}`),
      ctx,
    );
    const text = await oldCredits.text();
    expect(text).toContain(rightsReference);
    expect(text).toContain("kein geprüfter Lizenznachweis");
    expect(text).not.toContain("Second private");
    expect(
      (
        await attributionApi(
          request(`example/attribution?v=${old.version}`, "bob"),
          ctx,
        )
      ).status,
    ).toBe(404);
    await accounts.transaction((db) =>
      db.prepare("DELETE FROM merchants WHERE id = ?").run("example"),
    );
    expect(
      (
        await attributionApi(
          request(`example/attribution?v=${old.version}`),
          ctx,
        )
      ).status,
    ).toBe(200);
  });

  it("gives identical bytes/permission independent account-bound versions and retains credit-only history", async () => {
    await importLocal();
    const old = store.authorizedLogo(alice, "example")!;
    await importLocal(20, "Updated rights declaration, same raster");
    const current = store.authorizedLogo(alice, "example")!;
    expect(current.logo.file).toBe(old.logo.file);
    expect(current.version).not.toBe(old.version);
    await importAuthorizedLocalLogos(store, {
      userId: bob,
      rightsReference: current.logo.rightsReference,
      manifestPath: await manifest(),
    });
    const other = store.authorizedLogo(bob, "example")!;
    expect(other.logo).toEqual(current.logo);
    expect(other.version).not.toBe(current.version);
    expect(store.authorizedLogo(bob, "example", current.version)).toBeNull();
    expect(
      await readdir(authorizedLogoDirectory(accounts.path, alice)),
    ).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
  });

  it("preserves legacy public fallback and the same public licence gate for all accounts", async () => {
    const png = await normalizeLogoRaster(await raster(70));
    const file = await writeStoredLogoPng(
      join(directory, "merchant-logos"),
      png!,
    );
    const publicLogo = {
      file,
      license: "CC0-1.0" as const,
      attribution: "Synthetic public raster",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Synthetic_shape.png",
    };
    store.upsertMerchants([
      merchant("example", "Q123"),
      {
        ...merchant("osm-brand-Q123-0123456789abcdef", null),
        source: "osm",
        logo: publicLogo,
      },
    ]);
    const version = merchantLogoVersion(publicLogo);
    for (const userId of [alice, bob]) {
      expect(
        await accountMerchantPresentations(
          store,
          { merchantIds: ["example"] },
          userId,
        ),
      ).toEqual([
        {
          merchantId: "example",
          logo: { merchantId: "osm-brand-Q123-0123456789abcdef", version },
        },
      ]);
    }
    await importLocal();
    expect(
      (
        await accountMerchantPresentations(
          store,
          { merchantIds: ["example"] },
          alice,
        )
      )[0].logo?.merchantId,
    ).toBe("example");
    expect(
      (
        await accountMerchantPresentations(
          store,
          { merchantIds: ["example"] },
          bob,
        )
      )[0].logo?.merchantId,
    ).toBe("osm-brand-Q123-0123456789abcdef");
    const ctx = {
      params: Promise.resolve({ id: "osm-brand-Q123-0123456789abcdef" }),
    };
    expect(
      (
        await logoApi(
          request(`osm-brand-Q123-0123456789abcdef/logo?v=${version}`, "bob"),
          ctx,
        )
      ).status,
    ).toBe(200);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    { canonicalName: "Different private brand" },
    { canonicalName: "Synthetic market", region: "DE" },
  ])(
    "falls back to public logos for same-QID references without name/region proof: %j",
    async (overrides) => {
      commonsRequests();
      network.mockResolvedValueOnce(
        new Response(new Uint8Array(await raster())),
      );
      await importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
      });
      const grant = store.authorizedLogo(alice, "example")!;
      const publicLogo = await sharedPublicLogo();
      store.upsertMerchants([
        {
          ...merchant("different-reference"),
          ...overrides,
          logo: publicLogo,
        },
      ]);
      network.mockClear();
      expect(
        store
          .authorizedLogoCandidates(alice, ["different-reference"])
          .get("different-reference"),
      ).toEqual([]);
      expect(
        await accountMerchantPresentations(
          store,
          {
            merchantIds: ["example", "different-reference"],
          },
          alice,
        ),
      ).toEqual([
        {
          merchantId: "example",
          logo: { merchantId: "example", version: grant.version },
        },
        {
          merchantId: "different-reference",
          logo: {
            merchantId: "different-reference",
            version: merchantLogoVersion(publicLogo),
          },
        },
      ]);
      expect(network).not.toHaveBeenCalled();
    },
  );

  it("permits normalized canonical-name equivalents for direct and related private presentation", async () => {
    commonsRequests();
    network.mockResolvedValueOnce(new Response(new Uint8Array(await raster())));
    await importAuthorizedCommonsLogos(store, {
      userId: alice,
      rightsReference,
    });
    const grant = store.authorizedLogo(alice, "example")!;
    store.upsertMerchants([
      { ...merchant(), canonicalName: "SYNTHETIC MARKET", updatedAt: 2 },
      { ...merchant("equivalent-name"), canonicalName: "synthetic MARKET" },
    ]);
    network.mockClear();
    expect(
      await accountMerchantPresentations(
        store,
        {
          merchantIds: ["example", "equivalent-name"],
        },
        alice,
      ),
    ).toEqual([
      {
        merchantId: "example",
        logo: { merchantId: "example", version: grant.version },
      },
      {
        merchantId: "equivalent-name",
        logo: { merchantId: "example", version: grant.version },
      },
    ]);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["local-file", "commons"] as const)(
    "falls back after a direct %s grant's public canonical name changes, preserving owner-only archived credits",
    async (kind) => {
      if (kind === "local-file") await importLocal();
      else {
        commonsRequests();
        network.mockResolvedValueOnce(
          new Response(new Uint8Array(await raster())),
        );
        await importAuthorizedCommonsLogos(store, {
          userId: alice,
          rightsReference,
        });
      }
      const grant = store.authorizedLogo(alice, "example")!;
      const publicLogo = await sharedPublicLogo();
      store.upsertMerchants([
        {
          ...merchant(),
          canonicalName: "Renamed brand",
          updatedAt: 2,
          logo: publicLogo,
        },
        { ...merchant("renamed-related"), canonicalName: "Renamed brand" },
      ]);
      network.mockClear();
      expect(
        store.authorizedLogoCandidates(alice, ["example", "renamed-related"]),
      ).toEqual(
        new Map([
          ["example", []],
          ["renamed-related", []],
        ]),
      );
      expect(
        (
          await accountMerchantPresentations(
            store,
            {
              merchantIds: ["example"],
            },
            alice,
          )
        )[0].logo,
      ).toEqual({
        merchantId: "example",
        version: merchantLogoVersion(publicLogo),
      });
      const context = { params: Promise.resolve({ id: "example" }) };
      const archived = await attributionApi(
        request(`example/attribution?v=${grant.version}`),
        context,
      );
      expect(archived.status).toBe(200);
      const text = await archived.text();
      expect(text).toContain("Händler: Synthetic market");
      expect(text).toContain(rightsReference);
      expect(text).not.toContain("Händler: Renamed brand");
      expect(
        (await logoApi(request(`example/logo?v=${grant.version}`), context))
          .status,
      ).toBe(200);
      expect(
        (
          await attributionApi(
            request(`example/attribution?v=${grant.version}`, "bob"),
            context,
          )
        ).status,
      ).toBe(404);
      expect(network).not.toHaveBeenCalled();
    },
  );

  it("falls back when the public QID of a direct Commons grant changes", async () => {
    commonsRequests();
    network.mockResolvedValueOnce(new Response(new Uint8Array(await raster())));
    await importAuthorizedCommonsLogos(store, {
      userId: alice,
      rightsReference,
    });
    const grant = store.authorizedLogo(alice, "example")!;
    const publicLogo = await sharedPublicLogo();
    store.upsertMerchants([
      {
        ...merchant("example", "Q456"),
        updatedAt: 2,
        logo: publicLogo,
      },
    ]);
    network.mockClear();
    expect(
      store.authorizedLogoCandidates(alice, ["example"]).get("example"),
    ).toEqual([]);
    expect(
      (
        await accountMerchantPresentations(
          store,
          {
            merchantIds: ["example"],
          },
          alice,
        )
      )[0].logo,
    ).toEqual({
      merchantId: "example",
      version: merchantLogoVersion(publicLogo),
    });
    expect(
      store.authorizedLogo(alice, "example", grant.version)?.logo.provenance,
    ).toMatchObject({ wikidataId: "Q123" });
    expect(network).not.toHaveBeenCalled();
  });

  it("requires explicit existing account and a non-empty rights reference before any file or network operation", async () => {
    for (const userId of ["", "missing-account"]) {
      await expect(
        importAuthorizedCommonsLogos(store, { userId, rightsReference }),
      ).rejects.toThrow();
      await expect(
        importAuthorizedLocalLogos(store, {
          userId,
          rightsReference,
          manifestPath: join(directory, "missing.json"),
        }),
      ).rejects.toThrow();
    }
    await expect(
      importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference: " ",
      }),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
});

describe("identity-bound private versions with legacy read compatibility", () => {
  it.each([false, true])(
    "creates new credits on same-file/same-rights reimport after rename (legacy=%s)",
    async (legacy) => {
      await importLocal();
      const old = legacy
        ? makeCurrentGrantLegacy()
        : store.authorizedLogo(alice, "example")!;
      store.upsertMerchants([
        { ...merchant(), canonicalName: "Renamed market", updatedAt: 2 },
      ]);
      expect(
        (
          await accountMerchantPresentations(
            store,
            { merchantIds: ["example"] },
            alice,
          )
        )[0].logo,
      ).toBeNull();
      expect(await importLocal()).toMatchObject({ imported: 1, cached: 0 });
      const current = store.authorizedLogo(alice, "example")!;
      expect(current.canonicalName).toBe("Renamed market");
      expect(current.version).not.toBe(old.version);
      expect(current.logo).toEqual(old.logo);
      expect(
        await accountMerchantPresentations(
          store,
          { merchantIds: ["example"] },
          alice,
        ),
      ).toEqual([
        {
          merchantId: "example",
          logo: { merchantId: "example", version: current.version },
        },
      ]);
      expect(store.authorizedLogo(alice, "example", old.version)).toEqual(old);
      const context = { params: Promise.resolve({ id: "example" }) };
      const originalCredits = await attributionApi(
        request(`example/attribution?v=${old.version}`),
        context,
      );
      expect(originalCredits.status).toBe(200);
      expect(await originalCredits.text()).toContain(
        "Händler: Synthetic market",
      );
      const currentCredits = await attributionApi(
        request(`example/attribution?v=${current.version}`),
        context,
      );
      expect(await currentCredits.text()).toContain("Händler: Renamed market");
      expect(
        (await logoApi(request(`example/logo?v=${old.version}`), context))
          .status,
      ).toBe(200);
      for (const version of [old.version, current.version]) {
        expect(
          (
            await attributionApi(
              request(`example/attribution?v=${version}`, "bob"),
              context,
            )
          ).status,
        ).toBe(404);
        expect(
          (await logoApi(request(`example/logo?v=${version}`, "bob"), context))
            .status,
        ).toBe(404);
      }
      expect(await importLocal()).toMatchObject({ imported: 0, cached: 1 });
      expect(store.authorizedLogo(alice, "example")?.version).toBe(
        current.version,
      );
      expect(
        accounts.read(
          (db) =>
            db
              .prepare("SELECT count(*) AS n FROM merchant_authorized_logos")
              .get()?.n,
        ),
      ).toBe(2);
      expect(
        await readdir(authorizedLogoDirectory(accounts.path, alice)),
      ).toEqual([old.logo.file]);
      expect(network).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy current marks and old cached URLs readable without rewriting or importing", async () => {
    await importLocal();
    const legacy = makeCurrentGrantLegacy();
    expect(store.authorizedLogo(alice, "example")).toEqual(legacy);
    expect(
      await accountMerchantPresentations(
        store,
        { merchantIds: ["example"] },
        alice,
      ),
    ).toEqual([
      {
        merchantId: "example",
        logo: { merchantId: "example", version: legacy.version },
      },
    ]);
    const context = { params: Promise.resolve({ id: "example" }) };
    expect(
      (await logoApi(request(`example/logo?v=${legacy.version}`), context))
        .status,
    ).toBe(200);
    expect(
      (
        await attributionApi(
          request(`example/attribution?v=${legacy.version}`),
          context,
        )
      ).status,
    ).toBe(200);
    const stored = accounts.read((db) =>
      db
        .prepare(
          "SELECT version, canonical_name FROM merchant_authorized_logos",
        )
        .all(),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      version: legacy.version,
      canonical_name: legacy.canonicalName,
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("does not accept modified permission metadata merely because a row has a legacy hash", async () => {
    await importLocal();
    const legacy = makeCurrentGrantLegacy();
    accounts.transaction((db) =>
      db
        .prepare(
          `UPDATE merchant_authorized_logos SET logo_json = ?
      WHERE user_id = ? AND merchant_id = ? AND version = ?`,
        )
        .run(
          JSON.stringify({
            ...legacy.logo,
            rightsReference: "Changed without a new version",
          }),
          alice,
          legacy.merchantId,
          legacy.version,
        ),
    );
    expect(() =>
      store.authorizedLogo(alice, "example", legacy.version),
    ).toThrow("Private logo metadata version mismatch");
    expect(network).not.toHaveBeenCalled();
  });

  it("binds new versions to merchant identity even for identical names, art and permissions", async () => {
    await importLocal();
    const first = store.authorizedLogo(alice, "example")!;
    store.upsertMerchants([merchant("second-identity")]);
    const second = store.saveAuthorizedLogo(
      alice,
      "second-identity",
      first.logo,
    );
    expect(second.canonicalName).toBe(first.canonicalName);
    expect(second.logo).toEqual(first.logo);
    expect(second.version).not.toBe(first.version);
    expect(
      store.authorizedLogo(alice, "second-identity", first.version),
    ).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it("refreshes a renamed Commons identity from its existing PNG without any network lookup", async () => {
    commonsRequests();
    network.mockResolvedValueOnce(new Response(new Uint8Array(await raster())));
    await importAuthorizedCommonsLogos(store, {
      userId: alice,
      rightsReference,
    });
    const old = makeCurrentGrantLegacy();
    store.upsertMerchants([
      { ...merchant(), canonicalName: "Renamed market", updatedAt: 2 },
    ]);
    network.mockClear();
    expect(
      await importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
      }),
    ).toMatchObject({ cached: 1, imported: 0 });
    const current = store.authorizedLogo(alice, "example")!;
    expect(current.canonicalName).toBe("Renamed market");
    expect(current.version).not.toBe(old.version);
    expect(current.logo).toEqual(old.logo);
    expect(store.authorizedLogo(alice, "example", old.version)).toEqual(old);
    expect(
      (
        await accountMerchantPresentations(
          store,
          { merchantIds: ["example"] },
          alice,
        )
      )[0].logo?.version,
    ).toBe(current.version);
    expect(network).not.toHaveBeenCalled();
  });

  it("enforces the extra-version quota before rename reimport and preserves the legacy row/asset", async () => {
    await importLocal();
    const old = makeCurrentGrantLegacy();
    accounts.transaction((db) => {
      const insert = db.prepare(`INSERT INTO merchant_authorized_logos
        VALUES (?, 'fixture-archive', ?, 'Fixture', ?, 0, 1)`);
      for (let i = 1; i < MAX_ACCOUNT_LOGO_VERSIONS; i++)
        insert.run(
          alice,
          i.toString(16).padStart(64, "0"),
          JSON.stringify(old.logo),
        );
    });
    store.upsertMerchants([
      { ...merchant(), canonicalName: "Renamed market", updatedAt: 2 },
    ]);
    await expect(importLocal()).rejects.toThrow(/quota/);
    expect(store.authorizedLogo(alice, "example", old.version)).toEqual(old);
    expect(store.authorizedLogo(alice, "example")?.version).toBe(old.version);
    expect(
      await readdir(authorizedLogoDirectory(accounts.path, alice)),
    ).toEqual([old.logo.file]);
    expect(network).not.toHaveBeenCalled();
  });
});

describe("bounded local operator manifests", () => {
  it("executes the operator CLI against only an explicitly selected synthetic database/account", async () => {
    await writeFile(join(directory, "shape.png"), await raster());
    const args = [
      join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"),
      join(process.cwd(), "scripts", "merchant-authorized-logos.ts"),
      "--database",
      accounts.path,
      "--account",
      "alice",
      "--manifest",
      await manifest(),
    ];
    const run = promisify(execFile);
    const result = await run(
      process.execPath,
      [...args, "--rights-reference", rightsReference],
      { timeout: 20_000 },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      imported: 1,
      cached: 0,
      merchantIds: ["example"],
    });
    expect(store.authorizedLogo(alice, "example")?.logo.rightsReference).toBe(
      rightsReference,
    );
    expect(store.authorizedLogo(bob, "example")).toBeNull();
    expect(store.getMerchant("example")?.logo).toBeNull();
    await expect(
      run(process.execPath, args, { timeout: 20_000 }),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    "../shape.png",
    "..\\shape.png",
    "C:\\shape.png",
    "\\\\server\\shape.png",
    "shape.png:stream",
    "image.svg",
    "nested/../../shape.png",
  ])("rejects unsafe local path %s", async (file) => {
    await expect(
      importAuthorizedLocalLogos(store, {
        userId: alice,
        rightsReference,
        manifestPath: await manifest([
          {
            merchantId: "example",
            file,
            attribution: "Synthetic",
          },
        ]),
      }),
    ).rejects.toThrow(/relative PNG|escapes/);
    expect(store.authorizedLogo(alice, "example")).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects unknown, duplicate and excessive merchant IDs before writing any grant", async () => {
    for (const entries of [
      [{ merchantId: "missing", file: "shape.png", attribution: "Synthetic" }],
      Array(2).fill({
        merchantId: "example",
        file: "shape.png",
        attribution: "Synthetic",
      }),
      Array(201).fill({
        merchantId: "example",
        file: "shape.png",
        attribution: "Synthetic",
      }),
    ]) {
      await writeFile(join(directory, "shape.png"), await raster());
      await expect(
        importAuthorizedLocalLogos(store, {
          userId: alice,
          rightsReference,
          manifestPath: await manifest(entries),
        }),
      ).rejects.toThrow();
      expect(store.authorizedLogo(alice, "example")).toBeNull();
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("rejects 2MiB+, oversized manifests, excessive pixels, local SVG bytes and symlink paths", async () => {
    const manifestPath = await manifest();
    for (const bytes of [
      Buffer.alloc(2 * 1024 * 1024 + 1),
      await raster(20, 2001, 2000),
      Buffer.from("<svg><rect width='10' height='10'/></svg>"),
    ]) {
      await writeFile(join(directory, "shape.png"), bytes);
      await expect(
        importAuthorizedLocalLogos(store, {
          userId: alice,
          rightsReference,
          manifestPath,
        }),
      ).rejects.toThrow();
    }
    await writeFile(manifestPath, Buffer.alloc(128 * 1024 + 1));
    await expect(
      importAuthorizedLocalLogos(store, {
        userId: alice,
        rightsReference,
        manifestPath,
      }),
    ).rejects.toThrow(/byte limit/);
    await mkdir(join(directory, "real"));
    await writeFile(join(directory, "real", "shape.png"), await raster());
    await symlink(
      join(directory, "real"),
      join(directory, "linked"),
      "junction",
    );
    await expect(
      importAuthorizedLocalLogos(store, {
        userId: alice,
        rightsReference,
        manifestPath: await manifest([
          {
            merchantId: "example",
            file: "linked\\shape.png",
            attribution: "Synthetic",
          },
        ]),
      }),
    ).rejects.toThrow(/symlinks/);
    expect(store.authorizedLogo(alice, "example")).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["jpeg", "webp"] as const)(
    "accepts local %s and normalizes to bounded PNG",
    async (format) => {
      const file = `shape.${format}`;
      await writeFile(
        join(directory, file),
        await raster(10, 300, 200, format),
      );
      await importAuthorizedLocalLogos(store, {
        userId: alice,
        rightsReference,
        manifestPath: await manifest([
          {
            merchantId: "example",
            file,
            attribution: "Synthetic raster",
          },
        ]),
      });
      const grant = store.authorizedLogo(alice, "example")!;
      const bytes = await readAuthorizedMerchantLogo(
        accounts.path,
        alice,
        grant.logo,
      );
      expect(bytes!.length).toBeLessThanOrEqual(256 * 1024);
      const info = await sharp(bytes!).metadata();
      expect(info.format).toBe("png");
      expect(info.width).toBeLessThanOrEqual(128);
      expect(info.height).toBeLessThanOrEqual(128);
      expect(network).not.toHaveBeenCalled();
    },
  );

  it("uses a finite account lock, bounded history and no extra file for identical import", async () => {
    const release = acquireAuthorizedLogoImport(accounts, alice);
    await expect(importLocal()).rejects.toThrow(/already running/);
    release();
    await importLocal();
    const grant = store.authorizedLogo(alice, "example")!;
    accounts.transaction((db) => {
      const insert = db.prepare(`INSERT INTO merchant_authorized_logos
        VALUES (?, 'fixture-archive', ?, 'Fixture', ?, 0, 1)`);
      for (let i = 1; i < MAX_ACCOUNT_LOGO_VERSIONS; i++)
        insert.run(
          alice,
          i.toString(16).padStart(64, "0"),
          JSON.stringify(grant.logo),
        );
    });
    expect(await importLocal()).toMatchObject({ cached: 1 });
    await expect(importLocal(99)).rejects.toThrow(/quota/);
    expect(
      await readdir(authorizedLogoDirectory(accounts.path, alice)),
    ).toHaveLength(1);
    expect(network).not.toHaveBeenCalled();
  });

  it("caps stored files and never reads/writes a symlinked private asset directory", async () => {
    const target = authorizedLogoDirectory(accounts.path, alice);
    const png = (await normalizeLogoRaster(await raster()))!;
    await writeStoredLogoPng(target, png, 1);
    await expect(
      writeStoredLogoPng(
        target,
        (await normalizeLogoRaster(await raster(90)))!,
        1,
      ),
    ).rejects.toThrow(/file quota/);
    await importLocal();
    const grant = store.authorizedLogo(alice, "example")!;
    await rm(target, { recursive: true });
    const elsewhere = join(directory, "untrusted-assets");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, grant.logo.file), png);
    await symlink(elsewhere, target, "junction");
    expect(
      await readAuthorizedMerchantLogo(accounts.path, alice, grant.logo),
    ).toBeNull();
    await expect(importLocal(99)).rejects.toThrow(/symlink/);
    expect(await readdir(elsewhere)).toEqual([grant.logo.file]);
    expect(network).not.toHaveBeenCalled();
  });

  it("bounds persistent total assets including orphaned/deleted-account files without breaking idempotence", async () => {
    await importLocal();
    accounts.transaction((db) => {
      const insert = db.prepare(
        "INSERT INTO merchant_authorized_logo_assets VALUES (?, ?)",
      );
      for (let i = 1; i < MAX_TOTAL_PRIVATE_LOGO_FILES; i++) {
        insert.run(i.toString(16).padStart(64, "0"), `${"a".repeat(64)}.png`);
      }
    });
    expect(await importLocal()).toMatchObject({ cached: 1 });
    await expect(importLocal(99)).rejects.toThrow(/asset quota/);
    expect(
      await readdir(authorizedLogoDirectory(accounts.path, alice)),
    ).toHaveLength(1);
    accounts.transaction((db) =>
      db.prepare("DELETE FROM users WHERE id = ?").run(alice),
    );
    expect(
      accounts.read(
        (db) =>
          db
            .prepare("SELECT count(*) AS n FROM merchant_authorized_logos")
            .get()?.n,
      ),
    ).toBe(0);
    expect(
      accounts.read(
        (db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM merchant_authorized_logo_assets",
            )
            .get()?.n,
      ),
    ).toBe(MAX_TOTAL_PRIVATE_LOGO_FILES);
    expect(network).not.toHaveBeenCalled();
  });
});

describe("explicit source-verified logo variant selection", () => {
  it("keeps the normal public importer conservative even if a caller supplies a filename", async () => {
    network.mockResolvedValueOnce(
      Response.json({
        claims: {
          P154: [filename, "Other shape.png"].map((value) => ({
            rank: "normal",
            mainsnak: {
              snaktype: "value",
              datavalue: { type: "string", value },
            },
          })),
        },
      }),
    );
    expect(
      await retrieveMerchantLogo("Q123", accounts.path, {
        fetch: network,
        filename,
      }),
    ).toMatchObject({ status: "skipped", reason: "Ambiguous P154 logos" });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("does not select an older normal-rank variant over preferred logo evidence", async () => {
    network.mockResolvedValueOnce(
      Response.json({
        claims: {
          P154: [filename, "Other shape.png"].map((value, index) => ({
            rank: index === 0 ? "normal" : "preferred",
            mainsnak: {
              snaktype: "value",
              datavalue: { type: "string", value },
            },
          })),
        },
      }),
    );
    expect(
      await importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
        logoChoices: [{ wikidataId: "Q123", filename }],
      }),
    ).toMatchObject({ skipped: 1, imported: 0 });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it("selects only a named current P154 variant under private permission", async () => {
    const shape = (value: string, rank = "normal") => ({
      rank,
      mainsnak: { snaktype: "value", datavalue: { type: "string", value } },
    });
    network.mockResolvedValueOnce(
      Response.json({
        claims: { P154: [shape(filename), shape("Another shape.png")] },
      }),
    );
    network.mockResolvedValueOnce(
      Response.json({
        query: {
          pages: {
            "1": {
              imageinfo: [
                {
                  url: upload,
                  size: 128,
                  width: 32,
                  height: 24,
                  mime: "image/png",
                  extmetadata: {},
                },
              ],
            },
          },
        },
      }),
    );
    network.mockResolvedValueOnce(new Response(new Uint8Array(await raster())));
    expect(
      await importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
        logoChoices: [{ wikidataId: "Q123", filename }],
      }),
    ).toMatchObject({ imported: 1 });
    expect(network).toHaveBeenCalledTimes(3);
    expect(
      store.authorizedLogo(alice, "example")!.logo.provenance,
    ).toMatchObject({
      sourceUrl:
        "https://commons.wikimedia.org/wiki/File:Synthetic%20shape.png",
    });
  });

  it.each(["Foreign logo.png", "Deprecated shape.png"])(
    "never downloads an unverified or deprecated variant: %s",
    async (choice) => {
      network.mockResolvedValueOnce(
        Response.json({
          claims: {
            P154: [
              {
                rank: "deprecated",
                mainsnak: {
                  snaktype: "value",
                  datavalue: { type: "string", value: "Deprecated shape.png" },
                },
              },
              {
                rank: "normal",
                mainsnak: {
                  snaktype: "value",
                  datavalue: { type: "string", value: filename },
                },
              },
            ],
          },
        }),
      );
      expect(
        await importAuthorizedCommonsLogos(store, {
          userId: alice,
          rightsReference,
          logoChoices: [{ wikidataId: "Q123", filename: choice }],
        }),
      ).toMatchObject({
        imported: 0,
        skipped: 1,
        entities: [
          expect.objectContaining({
            reason: "Selected logo is not an active P154 candidate",
          }),
        ],
      });
      expect(network).toHaveBeenCalledTimes(1);
      expect(store.authorizedLogo(alice, "example")).toBeNull();
    },
  );

  it("rejects unknown and duplicate selections before any requests", async () => {
    for (const logoChoices of [
      [{ wikidataId: "Q999", filename }],
      [
        { wikidataId: "Q123", filename },
        { wikidataId: "Q123", filename },
      ],
    ]) {
      await expect(
        importAuthorizedCommonsLogos(store, {
          userId: alice,
          rightsReference,
          logoChoices,
        }),
      ).rejects.toThrow(/existing public merchant|Duplicate/);
    }
    expect(network).not.toHaveBeenCalled();
  });
});

describe("Commons acquisition with declared private permission", () => {
  it.each([
    "Logopedia; https://logos.fandom.com/wiki/Synthetic",
    "logowik.com",
    "brandsoftheworld.com",
  ])(
    "retains upstream credits under private permission without fetching those sites: %s",
    async (credit) => {
      const metadata = {
        LicenseShortName: { value: "CC BY 4.0" },
        LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
        Artist: { value: "Synthetic source artist" },
        Credit: { value: credit },
        Restrictions: { value: "trademarked" },
        Copyrighted: { value: "True" },
      };
      commonsRequests({ extmetadata: metadata });
      expect(
        await retrieveMerchantLogo("Q123", accounts.path, { fetch: network }),
      ).toMatchObject({
        status: "skipped",
        reason: "Commons lists unreviewed upstream logo provenance",
      });
      expect(network).toHaveBeenCalledTimes(2);
      network.mockReset();
      commonsRequests({
        extmetadata: {
          ...metadata,
          LicenseShortName: { value: "Copyrighted brand mark" },
          LicenseUrl: { value: "https://example.invalid/source-rights" },
          UsageTerms: { value: "All rights reserved" },
        },
      });
      network.mockResolvedValueOnce(
        new Response(new Uint8Array(await raster())),
      );
      const before = store.loadMerchants();
      expect(
        await importAuthorizedCommonsLogos(store, {
          userId: alice,
          rightsReference,
        }),
      ).toMatchObject({ imported: 1 });
      const grant = store.authorizedLogo(alice, "example")!;
      expect(grant.logo).toMatchObject({
        permission: "operator-declared-private-usage-rights",
        rightsReference,
        publicRights: {
          credit,
          license: null,
          licenseName: "Copyrighted brand mark",
          usageTerms: "All rights reserved",
          restrictions: "trademarked",
        },
      });
      expect(grant.logo.attribution).toContain(credit);
      expect(store.loadMerchants()).toEqual(before);
      expect(
        network.mock.calls.map(([url]) => new URL(String(url)).hostname),
      ).toEqual([
        "www.wikidata.org",
        "commons.wikimedia.org",
        "upload.wikimedia.org",
      ]);
      for (const [, init] of network.mock.calls)
        expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
      expect(store.authorizedLogo(bob, "example")).toBeNull();
    },
  );

  it.each(["png", "jpg", "jpeg", "svg"])(
    "downloads only a provenance-matched PNG thumbnail for an oversized %s original",
    async (extension) => {
      const name = `Synthetic shape.${extension}`;
      const source = name.replace(/ /g, "_");
      const original = `https://upload.wikimedia.org/wikipedia/commons/a/ab/${source}`;
      const thumbnail = `https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/${source}/250px-${source}${extension === "png" ? "" : ".png"}`;
      const info = {
        url: original,
        mime:
          extension === "png"
            ? "image/png"
            : extension === "svg"
              ? "image/svg+xml"
              : "image/jpeg",
        size: 2 * 1024 * 1024 + 1,
        width: 10_000,
        height: 8000,
        thumburl: thumbnail,
        thumbmime: "image/png",
        thumbwidth: 128,
        thumbheight: 64,
        extmetadata: {
          LicenseShortName: { value: "CC BY 4.0" },
          LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
          Artist: { value: "Synthetic source artist" },
        },
      };
      commonsRequests(info, name);
      network.mockResolvedValueOnce(
        new Response(new Uint8Array(await raster(20, 250, 125))),
      );
      expect(
        await importAuthorizedCommonsLogos(store, {
          userId: alice,
          rightsReference,
        }),
      ).toMatchObject({ imported: 1 });
      expect(String(network.mock.calls[2][0])).toBe(thumbnail);
      expect(network.mock.calls.some(([url]) => String(url) === original)).toBe(
        false,
      );
      const grant = store.authorizedLogo(alice, "example")!;
      const stored = await readAuthorizedMerchantLogo(
        accounts.path,
        alice,
        grant.logo,
      );
      const dimensions = await sharp(stored!).metadata();
      expect(dimensions.width).toBeLessThanOrEqual(128);
      expect(dimensions.height).toBeLessThanOrEqual(128);
      expect(grant.logo.provenance).toMatchObject({
        kind: "commons",
        sourceUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(name)}`,
      });
      network.mockReset();
      commonsRequests(info, name);
      expect(
        await retrieveMerchantLogo("Q123", accounts.path, { fetch: network }),
      ).toMatchObject({
        status: "skipped",
        reason: "Commons image exceeds raster limits",
      });
      expect(network).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { thumburl: undefined },
    {
      thumbmime: "image/jpeg",
      thumburl:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Synthetic_shape.png/250px-Synthetic_shape.jpg",
    },
    { thumbwidth: 129 },
    { thumbheight: 129 },
    {
      thumburl:
        "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bb/Synthetic_shape.png/250px-Synthetic_shape.png",
    },
    {
      thumburl:
        "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Other.png/250px-Other.png",
    },
    {
      thumburl:
        "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Synthetic_shape.png/250px-Other.png",
    },
  ])(
    "skips oversized rasters without an exact safe PNG thumbnail: %j",
    async (overrides) => {
      commonsRequests({
        size: 2 * 1024 * 1024 + 1,
        thumburl:
          "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Synthetic_shape.png/250px-Synthetic_shape.png",
        thumbmime: "image/png",
        thumbwidth: 128,
        thumbheight: 64,
        ...overrides,
      });
      expect(
        await importAuthorizedCommonsLogos(store, {
          userId: alice,
          rightsReference,
        }),
      ).toMatchObject({
        skipped: 1,
        entities: [
          {
            reason:
              "No provenance-matched Commons PNG thumbnail for oversized raster",
          },
        ],
      });
      expect(network).toHaveBeenCalledTimes(2);
      expect(store.authorizedLogo(alice, "example")).toBeNull();
    },
  );

  it.each([
    "https://evil.example/wikipedia/commons/thumb/a/ab/Synthetic_shape.png/250px-Synthetic_shape.png",
    "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Synthetic_shape.png/513px-Synthetic_shape.png",
  ])(
    "never fetches unallowlisted oversized-raster thumbnails: %s",
    async (thumburl) => {
      commonsRequests({
        size: 2 * 1024 * 1024 + 1,
        thumburl,
        thumbmime: "image/png",
        thumbwidth: 128,
        thumbheight: 64,
      });
      await expect(
        importAuthorizedCommonsLogos(store, { userId: alice, rightsReference }),
      ).rejects.toThrow(/Disallowed/);
      expect(network).toHaveBeenCalledTimes(2);
      expect(store.authorizedLogo(alice, "example")).toBeNull();
    },
  );

  it("enforces actual thumbnail dimensions and downloaded byte limits independently of original metadata", async () => {
    const info = {
      size: 2 * 1024 * 1024 + 1,
      thumburl:
        "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Synthetic_shape.png/250px-Synthetic_shape.png",
      thumbmime: "image/png",
      thumbwidth: 128,
      thumbheight: 64,
    };
    commonsRequests(info);
    network.mockResolvedValueOnce(
      new Response(new Uint8Array(await raster(20, 513, 10))),
    );
    expect(
      await importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
      }),
    ).toMatchObject({
      skipped: 1,
      entities: [{ reason: "Raster decoding or normalization failed" }],
    });
    expect(store.authorizedLogo(alice, "example")).toBeNull();
    network.mockReset();
    commonsRequests(info);
    network.mockResolvedValueOnce(
      new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
    );
    await expect(
      importAuthorizedCommonsLogos(store, { userId: alice, rightsReference }),
    ).rejects.toThrow(/byte limit/);
    expect(store.authorizedLogo(alice, "example")).toBeNull();
  });

  it("keeps a verified public licence/attribution separate from the operator's private declaration", async () => {
    commonsRequests({
      extmetadata: {
        LicenseShortName: { value: "CC BY 4.0" },
        LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
        Artist: { value: "Synthetic artist" },
        Credit: { value: "Synthetic source credit" },
        Restrictions: { value: "trademark" },
      },
    });
    network.mockResolvedValueOnce(new Response(new Uint8Array(await raster())));
    await importAuthorizedCommonsLogos(store, {
      userId: alice,
      rightsReference,
    });
    const grant = store.authorizedLogo(alice, "example")!;
    expect(grant.logo.publicRights).toMatchObject({
      license: "CC-BY-4.0",
      artist: "Synthetic artist",
      credit: "Synthetic source credit",
      restrictions: "trademark",
    });
    expect(store.getMerchant("example")?.logo).toBeNull();
    const response = await attributionApi(
      request(`example/attribution?v=${grant.version}`),
      { params: Promise.resolve({ id: "example" }) },
    );
    const text = await response.text();
    expect(text).toContain("Öffentliche Logo-Lizenz: CC-BY-4.0");
    expect(text).toContain(rightsReference);
    expect(text).toContain("Nutzererklärung; kein geprüfter Lizenznachweis");
  });

  it("allows absent public CC licence while preserving public/source rights separately, without global mutation", async () => {
    const before = store.loadMerchants();
    commonsRequests();
    network.mockResolvedValueOnce(new Response(new Uint8Array(await raster())));
    const report = await importAuthorizedCommonsLogos(store, {
      userId: alice,
      rightsReference,
    });
    expect(report).toMatchObject({ imported: 1, processed: 1, remaining: 0 });
    const grant = store.authorizedLogo(alice, "example")!;
    expect(authorizedMerchantLogoSchema.parse(grant.logo)).toMatchObject({
      rightsReference,
      publicRights: {
        license: null,
        restrictions: "trademarked",
        artist: "Synthetic artist",
      },
      provenance: { kind: "commons", wikidataId: "Q123" },
    });
    expect(store.loadMerchants()).toEqual(before);
    const ctx = { params: Promise.resolve({ id: "example" }) };
    const credits = await attributionApi(
      request(`example/attribution?v=${grant.version}`),
      ctx,
    );
    expect(await credits.text()).toContain(
      "Öffentliche Logo-Lizenz: Nicht verifiziert / nicht angegeben",
    );
    for (const [target, init] of network.mock.calls) {
      expect(String(target)).not.toMatch(
        /alice|bob|private.usage|2026-10-09|amount|description|Synthetic.market/,
      );
      expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
    }
    network.mockReset();
    commonsRequests();
    const publicResult = await retrieveMerchantLogo("Q123", accounts.path, {
      fetch: network,
    });
    expect(publicResult).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/licensing/),
    });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("shares a private Commons asset across only that account's known public QID/legacy references", async () => {
    store.upsertMerchants([
      { ...merchant("osm-brand-Q123-0123456789abcdef", null), source: "osm" },
    ]);
    commonsRequests();
    network.mockResolvedValueOnce(new Response(new Uint8Array(await raster())));
    await importAuthorizedCommonsLogos(store, {
      userId: alice,
      rightsReference,
    });
    const ownMarks = await accountMerchantPresentations(
      store,
      { merchantIds: ["example", "osm-brand-Q123-0123456789abcdef"] },
      alice,
    );
    expect(ownMarks[0].logo).toEqual(ownMarks[1].logo);
    expect(ownMarks[0].logo).not.toBeNull();
    const otherMarks = await accountMerchantPresentations(
      store,
      { merchantIds: ["example", "osm-brand-Q123-0123456789abcdef"] },
      bob,
    );
    expect(otherMarks.every((mark) => mark.logo === null)).toBe(true);
    network.mockClear();
    expect(
      await importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
      }),
    ).toMatchObject({ cached: 1 });
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    { url: "https://evil.example/shape.png" },
    {
      url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Different.png",
    },
    { extmetadata: { Restrictions: { value: "restricted" } } },
    { size: 2 * 1024 * 1024 + 1 },
    { width: 4001, height: 1000 },
  ])(
    "does not bypass hosts, provenance, restrictions or bounds with private rights: %j",
    async (info) => {
      commonsRequests(info);
      if (String(info.url ?? "").includes("evil")) {
        await expect(
          importAuthorizedCommonsLogos(store, {
            userId: alice,
            rightsReference,
          }),
        ).rejects.toThrow(/Disallowed/);
      } else {
        expect(
          await importAuthorizedCommonsLogos(store, {
            userId: alice,
            rightsReference,
          }),
        ).toMatchObject({ skipped: 1 });
      }
      expect(network).toHaveBeenCalledTimes(2);
      expect(store.authorizedLogo(alice, "example")).toBeNull();
    },
  );

  it("downloads licensed SVG only as provenance-matched Commons PNG, never SVG or foreign thumbnails", async () => {
    const name = "Synthetic shape.svg";
    const thumb =
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Synthetic_shape.svg/250px-Synthetic_shape.svg.png";
    const info = {
      url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Synthetic_shape.svg",
      mime: "image/svg+xml",
      thumburl: thumb,
      thumbmime: "image/png",
      thumbwidth: 128,
      thumbheight: 96,
    };
    commonsRequests(info, name);
    network.mockResolvedValueOnce(new Response(new Uint8Array(await raster())));
    expect(
      await importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
      }),
    ).toMatchObject({ imported: 1 });
    expect(String(network.mock.calls[2][0])).toBe(thumb);
    network.mockReset();
    commonsRequests(
      { ...info, thumburl: "https://evil.example/Synthetic_shape.svg.png" },
      name,
    );
    await expect(
      importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
        refresh: true,
      }),
    ).rejects.toThrow(/Disallowed/);
    expect(network).toHaveBeenCalledTimes(2);
    network.mockReset();
    commonsRequests(info, name);
    network.mockResolvedValueOnce(
      new Response(new Uint8Array(await raster(20, 513, 10))),
    );
    expect(
      await importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
        refresh: true,
      }),
    ).toMatchObject({ skipped: 1 });
  });

  it("does not invent logos for missing P154 and reports source failures without persistent grants", async () => {
    network.mockResolvedValueOnce(Response.json({ claims: {} }));
    expect(
      await importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
      }),
    ).toMatchObject({ skipped: 1, entities: [{ reason: "No P154 logo" }] });
    expect(network).toHaveBeenCalledTimes(1);
    network
      .mockReset()
      .mockResolvedValueOnce(new Response("Unavailable", { status: 403 }));
    await expect(
      importAuthorizedCommonsLogos(store, { userId: alice, rightsReference }),
    ).rejects.toThrow("HTTP 403");
    expect(store.authorizedLogo(alice, "example")).toBeNull();
    expect(await readdir(directory)).not.toContain("merchant-authorized-logos");
  });

  it("caps a run to 200 known public entities, batch<=20, sequential calls and resumable cursor", async () => {
    store.upsertMerchants(
      Array.from({ length: 204 }, (_, i) =>
        merchant(`public-${i}`, `Q${1000 + i}`),
      ),
    );
    let active = 0;
    let maxActive = 0;
    network.mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
      return Response.json({ claims: {} });
    });
    await expect(
      importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
        batchSize: 21,
      }),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
    const onBatch = vi.fn();
    const report = await importAuthorizedCommonsLogos(store, {
      userId: alice,
      rightsReference,
      batchSize: 20,
      onBatch,
    });
    expect(report.processed).toBe(MAX_AUTHORIZED_LOGO_ENTITIES);
    expect(report.remaining).toBe(5);
    expect(report.nextAfter).toMatch(/^Q/);
    expect(network).toHaveBeenCalledTimes(200);
    expect(onBatch).toHaveBeenCalledTimes(10);
    expect(maxActive).toBe(1);
    const rest = await importAuthorizedCommonsLogos(store, {
      userId: alice,
      rightsReference,
      after: report.nextAfter!,
    });
    expect(rest).toMatchObject({ processed: 5, remaining: 0, nextAfter: null });
  });

  it("fails an aborted operator deadline before reading/fetching or writing", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      importAuthorizedCommonsLogos(store, {
        userId: alice,
        rightsReference,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(network).not.toHaveBeenCalled();
  });
});
