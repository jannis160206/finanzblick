import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountDatabase, hashToken } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { sessionCookieName } from "@/lib/server/http";
import { transactionSchema } from "@/lib/types";
import { AutomationStore } from "./store";
import {
  availableLocalLogoGrants,
  importSuppliedLocalLogos,
  localLogoGrants,
} from "./merchant-local-logos";
import {
  accountMerchantNamePresentations,
  accountMerchantPresentations,
} from "./merchant-logo-presentations";
import { accountMerchantBookingPresentations } from "./merchant-booking-presentations";
import { merchantSchema } from "./merchants";
import { normalizeLogoRaster } from "./merchant-logo-raster";
import {
  authorizedLogoDirectory,
  readAuthorizedMerchantLogo,
} from "./merchant-logo-grants";

const api = vi.hoisted(() => ({ runtime: vi.fn(), authorize: vi.fn() }));
vi.mock("@/lib/server/runtime", () => ({ getAccountRuntime: api.runtime }));
vi.mock("@/lib/server/auth", () => ({
  isAccountMode: () => true,
  authorizeApi: api.authorize,
}));
import { GET as logoApi } from "@/app/api/merchants/[id]/logo/route";
import { GET as attributionApi } from "@/app/api/merchants/[id]/attribution/route";

let directory: string;
let accounts: AccountDatabase;
let store: AutomationStore;
let network: ReturnType<typeof vi.fn>;
const userId = "local-logo-account";
const rightsReference =
  "User supplied named rasters for this private dashboard.";

beforeEach(async () => {
  directory = createTestDirectory();
  await mkdir(join(directory, "Logo"));
  accounts = new AccountDatabase(join(directory, "accounts.sqlite"));
  store = new AutomationStore(accounts);
  accounts.transaction((db) => {
    for (const id of [userId, "other-logo-account"]) {
      db.prepare("INSERT INTO users VALUES (?, ?, 'user', 'fixture', 1)").run(
        id,
        id,
      );
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
        hashToken(hashToken(id)),
        id,
        Date.now() + 60_000,
      );
    }
  });
  api.runtime.mockResolvedValue({ database: accounts });
  api.authorize.mockResolvedValue(null);
  network = vi.fn().mockRejectedValue(new Error("Network forbidden"));
  vi.stubGlobal("fetch", network);
});

afterEach(async () => {
  expect(network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  accounts.close();
  await rm(directory, { recursive: true, force: true });
});

async function padded(format: "png" | "jpeg" | "webp" = "png") {
  const ink = await sharp({
    create: { width: 80, height: 40, channels: 4, background: "#126ab0" },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 200, height: 160, channels: 4, background: "#ffffff" },
  })
    .composite([{ input: ink, left: 60, top: 60 }])
    .toFormat(format)
    .toBuffer();
}

async function supplied(file = "Unlisted shop.png", bytes?: Buffer) {
  await writeFile(join(directory, "Logo", file), bytes ?? (await padded()));
}

function importLogos(aliases?: Record<string, string[]>) {
  return importSuppliedLocalLogos(store, {
    userId,
    rightsReference,
    directory: join(directory, "Logo"),
    aliases,
  });
}

function request(
  id: string,
  route: string,
  account = userId,
  version?: string,
) {
  return new Request(
    `http://localhost/api/merchants/${id}/${route}${version ? `?v=${version}` : ""}`,
    {
      headers: { Cookie: `${sessionCookieName()}=${hashToken(account)}` },
    },
  );
}

it("persists private filename associations without creating merchants or altering finance and survives reopen", async () => {
  await supplied();
  const finance = {
    ...blankTestState(),
    transactions: [
      transactionSchema.parse({
        id: "legacy",
        date: "2026-10-01",
        bank: "Revolut",
        pocket: null,
        description: "Unlisted shop",
        amount: -10,
        category: "Shopping",
        categoryOverride: true,
        includeInPlan: true,
      }),
    ],
  };
  accounts.putFinance(userId, finance, 0);
  const before = accounts.getFinance(userId);
  const catalogue = store.loadMerchants();
  expect(await importLogos()).toMatchObject({ imported: 1, cached: 0 });
  const first = localLogoGrants(store, userId).get("unlisted shop")!;
  expect(first.merchantId).toMatch(/^private-[a-f0-9]{64}$/);
  expect(await importLogos()).toMatchObject({ imported: 0, cached: 1 });
  expect(store.loadMerchants()).toEqual(catalogue);
  expect(accounts.getFinance(userId)).toEqual(before);
  const historical = await accountMerchantBookingPresentations(
    store,
    ["legacy"],
    userId,
  );
  const future = await accountMerchantNamePresentations(
    store,
    ["UNLISTED SHOP"],
    userId,
  );
  expect(historical[0].logo).toEqual({
    merchantId: first.merchantId,
    version: first.version,
  });
  expect(future[0].logo).toEqual(historical[0].logo);
  expect(
    (
      await accountMerchantNamePresentations(
        store,
        ["Unlisted Shop"],
        "other-logo-account",
      )
    )[0].logo,
  ).toBeNull();
  accounts.close();
  accounts = new AccountDatabase(join(directory, "accounts.sqlite"));
  store = new AutomationStore(accounts);
  expect(
    (await availableLocalLogoGrants(store, userId)).get("unlisted shop")
      ?.version,
  ).toBe(first.version);
  expect(accounts.getFinance(userId)).toEqual(before);
});

it("uses exact explicit private aliases and existing public aliases, never fuzzy or substring names", async () => {
  await supplied("Shop.png");
  store.upsertMerchants([
    merchantSchema.parse({
      id: "public-shop",
      canonicalName: "The Shop",
      aliases: ["Shop"],
      defaultCategory: null,
      regexPatterns: [],
      region: "AT",
      source: "local",
      updatedAt: 1,
    }),
  ]);
  await importLogos({ "Shop.png": ["My branch"] });
  const named = await accountMerchantNamePresentations(
    store,
    ["My branch", "Shopp", "Shop Bank"],
    userId,
  );
  expect(named[0].logo).not.toBeNull();
  expect(named.slice(1).map((mark) => mark.logo)).toEqual([null, null]);
  expect(
    (
      await accountMerchantPresentations(
        store,
        { merchantIds: ["public-shop"] },
        userId,
      )
    )[0].logo,
  ).toEqual(named[0].logo);
});

it("supports long supplied booking names without breaking unrelated booking batches", async () => {
  await supplied("From Malaga With Love SL.jpg", await padded("jpeg"));
  await supplied("Other Shop.png");
  await importLogos();
  const row = transactionSchema.parse({
    id: "long-name",
    date: "2026-10-01",
    bank: "Revolut",
    pocket: null,
    description: "From Malaga With Love SL MALAGA",
    amount: -10,
    category: "Shopping",
    includeInPlan: true,
  });
  accounts.putFinance(
    userId,
    {
      ...blankTestState(),
      transactions: [row, { ...row, id: "other", description: "Other Shop" }],
    },
    0,
  );
  const marks = await accountMerchantBookingPresentations(
    store,
    ["long-name", "other"],
    userId,
  );
  expect(marks.map((mark) => mark.logo?.merchantId)).toEqual([
    localLogoGrants(store, userId).get("from malaga with love sl")!.merchantId,
    localLogoGrants(store, userId).get("other shop")!.merchantId,
  ]);
});

it("imports supplied AVIF as private PNG without enabling remote AVIF images", async () => {
  const bytes = await sharp(await padded())
    .avif()
    .toBuffer();
  expect(await normalizeLogoRaster(bytes)).toBeNull();
  await supplied("Dia.avif", bytes);
  expect(await importLogos()).toMatchObject({ imported: 1 });
  const grant = localLogoGrants(store, userId).get("dia")!;
  const stored = await readAuthorizedMerchantLogo(
    accounts.path,
    userId,
    grant.logo,
  );
  expect((await sharp(stored!).metadata()).format).toBe("png");
});

it("uses a precise supplied company name for unconfirmed legacy artwork but does not change its shorter public identity", async () => {
  await supplied("Example Bank.png");
  await importLogos();
  const legacy = transactionSchema.parse({
    id: "old-identity",
    date: "2026-10-01",
    bank: "Revolut",
    pocket: null,
    description: "Example Bank",
    merchantId: "example",
    merchantAlias: "Example",
    amount: -10,
    category: "Shopping",
    categoryOverride: true,
    includeInPlan: true,
  });
  accounts.putFinance(
    userId,
    {
      ...blankTestState(),
      transactions: [
        legacy,
        { ...legacy, id: "explicitly-confirmed", merchantNameConfirmed: true },
        { ...legacy, id: "different-company", description: "Example Cars" },
        {
          ...legacy,
          id: "short-display",
          description: "Example",
          rawDescription: "Example Bank",
        },
      ],
    },
    0,
  );
  const before = accounts.getFinance(userId);
  const marks = await accountMerchantBookingPresentations(
    store,
    [
      "old-identity",
      "explicitly-confirmed",
      "different-company",
      "short-display",
    ],
    userId,
  );
  expect(marks[0].logo?.merchantId).toMatch(/^private-/);
  expect(marks.slice(1, 3).map((mark) => mark.logo)).toEqual([null, null]);
  expect(marks[3].logo).toEqual(marks[0].logo);
  expect(accounts.getFinance(userId)).toEqual(before);
});

it("resolves explicit supplied business labels in payment descriptors without assigning generic income logos", async () => {
  await supplied("Unlisted employer.png");
  await importLogos();
  const row = transactionSchema.parse({
    id: "employer",
    date: "2026-10-01",
    bank: "Revolut",
    pocket: null,
    description: "Lohn/Gehalt von Unlisted employer",
    amount: 1000,
    category: "Gehalt",
    categoryOverride: true,
    includeInPlan: true,
  });
  accounts.putFinance(
    userId,
    {
      ...blankTestState(),
      transactions: [
        row,
        { ...row, id: "other-income", description: "Unknown salary" },
        {
          ...row,
          id: "source-income",
          description: "Gehalt",
          rawDescription:
            "Auftraggeber: Unlisted employer Verwendungszweck: Gehalt",
        },
        {
          ...row,
          id: "reference-only",
          description: "Salary Referenz: Unlisted employer",
        },
      ],
    },
    0,
  );
  const marks = await accountMerchantBookingPresentations(
    store,
    ["employer", "other-income", "reference-only", "source-income"],
    userId,
  );
  expect(marks[0].logo?.merchantId).toMatch(/^private-/);
  expect(marks.slice(1, 3).map((mark) => mark.logo)).toEqual([null, null]);
  expect(marks[3].logo).toEqual(marks[0].logo);
});

it("uses explicit supplied bindings for issuer fees, credits, bank interest and a specific salary period without altering finance", async () => {
  await supplied("American Express.png");
  await supplied("Teamtalentsolution.png");
  await supplied("Raiffeisen.png");
  await importLogos({
    "American Express.png": ["MONATSGEBÜHR", "Entertainment Gutschrift"],
    "Teamtalentsolution.png": ["Gehalt 9/2026"],
    "Raiffeisen.png": [
      "Anweisungsbearbeitung", "Kontoführung", "Habenzinsen", "Sollzinsen",
    ],
  });
  const cases = [
    { description: "MONATSGEBÜHR", bank: "Amex", amount: -20, category: "Bankgebühren", source: "american express" },
    { description: "Entertainment Gutschrift", bank: "Amex", amount: 10, category: "Entertainment", source: "american express" },
    { description: "Gehalt 9/2026", bank: "Raiffeisen", amount: 1000, category: "Gehalt", source: "teamtalentsolution" },
    { description: "Anweisungsbearbeitung", bank: "Raiffeisen", amount: -1, category: "Bankgebühren", source: "raiffeisen" },
    { description: "Kontoführung", bank: "Raiffeisen", amount: -10, category: "Bankgebühren", source: "raiffeisen" },
    { description: "Habenzinsen", bank: "Raiffeisen", amount: 1, category: "Einkommen", source: "raiffeisen" },
    { description: "Sollzinsen", bank: "Raiffeisen", amount: -1, category: "Bankgebühren", source: "raiffeisen" },
  ];
  const rows = cases.map((row, index) =>
    transactionSchema.parse({
      ...row,
      id: `requested-${index}`,
      date: "2026-10-01",
      pocket: null,
      includeInPlan: false,
      categoryOverride: true,
      manualCategory: true,
    }),
  );
  const unrelated = transactionSchema.parse({
    ...rows[2], id: "unrelated-salary", description: "Gehalt 10/2026",
  });
  const transfer = transactionSchema.parse({
    ...rows[4], id: "transfer", category: "Transfer intern",
  });
  const unrelatedFee = transactionSchema.parse({
    ...rows[4], id: "unrelated-fee", description: "Beleggebühr",
  });
  accounts.putFinance(userId, {
    ...blankTestState(),
    transactions: [...rows, unrelated, transfer, unrelatedFee],
  }, 0);
  const before = accounts.getFinance(userId);
  const marks = await accountMerchantBookingPresentations(
    store,
    [...rows, unrelated, transfer, unrelatedFee].map((row) => row.id),
    userId,
  );
  const grants = localLogoGrants(store, userId);
  expect(marks.slice(0, rows.length).map((mark) => mark.logo?.merchantId)).toEqual(
    cases.map((row) => grants.get(row.source)!.merchantId),
  );
  expect(marks.slice(rows.length).map((mark) => mark.logo)).toEqual([
    null, null, null,
  ]);
  expect(accounts.getFinance(userId)).toEqual(before);
});

it.each(["png", "jpeg", "webp"] as const)(
  "trims %s padding, preserving aspect ratio at bounded badge resolution",
  async (format) => {
    const png = await normalizeLogoRaster(await padded(format), {
      suppliedLocalFile: true,
    });
    expect(png).not.toBeNull();
    const meta = await sharp(png!).metadata();
    expect(meta.width).toBeGreaterThanOrEqual(80);
    expect(meta.height! / meta.width!).toBeCloseTo(0.5, 1);
    expect(meta.width).toBeLessThanOrEqual(128);
    expect(meta.height).toBeLessThanOrEqual(128);
  },
);

it("accepts bounded supplied high-resolution images without weakening remote raster limits", async () => {
  const bytes = await sharp({
    create: { width: 4167, height: 4167, channels: 4, background: "#126ab0" },
  })
    .png()
    .toBuffer();
  expect(await normalizeLogoRaster(bytes)).toBeNull();
  expect(
    await normalizeLogoRaster(bytes, { suppliedLocalFile: true }),
  ).not.toBeNull();
});

it("serves original private attribution versions and denies other accounts' image and credits", async () => {
  await supplied();
  await importLogos();
  const first = localLogoGrants(store, userId).get("unlisted shop")!;
  await supplied(
    "Unlisted shop.png",
    await sharp({
      create: { width: 64, height: 32, channels: 4, background: "#cd1234" },
    })
      .png()
      .toBuffer(),
  );
  await importLogos();
  const current = localLogoGrants(store, userId).get("unlisted shop")!;
  expect(current.version).not.toBe(first.version);
  const params = { params: Promise.resolve({ id: first.merchantId }) };
  const image = await logoApi(
    request(first.merchantId, "logo", userId, first.version),
    params,
  );
  expect(image.status).toBe(200);
  expect(image.headers.get("Content-Type")).toBe("image/png");
  expect(Buffer.from(await image.arrayBuffer())).toEqual(
    await readAuthorizedMerchantLogo(accounts.path, userId, first.logo),
  );
  const credits = await attributionApi(
    request(first.merchantId, "attribution", userId, first.version),
    params,
  );
  expect(credits.status).toBe(200);
  expect(await credits.text()).toContain("Unlisted shop.png");
  for (const [handler, route] of [
    [logoApi, "logo"],
    [attributionApi, "attribution"],
  ] as const) {
    expect(
      (
        await handler(
          request(first.merchantId, route, "other-logo-account", first.version),
          params,
        )
      ).status,
    ).toBe(404);
  }
});

it("rejects conflicting filename keys and invalid rasters before persisting associations", async () => {
  await supplied("Same Shop.png");
  await supplied("same-shop.jpg", await padded("jpeg"));
  await expect(importLogos()).rejects.toThrow(
    "Conflicting supplied logo names",
  );
  expect(localLogoGrants(store, userId).size).toBe(0);
  await rm(join(directory, "Logo", "same-shop.jpg"));
  await supplied("broken.png", Buffer.from("not a raster"));
  await expect(importLogos()).rejects.toThrow(
    "Invalid or unsafe supplied raster",
  );
  expect(localLogoGrants(store, userId).size).toBe(0);
});

it("falls back when the private cached file disappears", async () => {
  await supplied();
  await importLogos();
  const grant = localLogoGrants(store, userId).get("unlisted shop")!;
  await rm(
    join(authorizedLogoDirectory(accounts.path, userId), grant.logo.file),
  );
  expect(
    (
      await accountMerchantNamePresentations(store, ["Unlisted shop"], userId)
    )[0].logo,
  ).toBeNull();
});
