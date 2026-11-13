import { mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
import * as logoGrants from "./merchant-logo-grants";
import { MerchantLogoRequest } from "./merchant-logo-request";
import * as calculation from "@/lib/calc";
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
import { POST as marksApi } from "@/app/api/merchants/marks/route";

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

it("preserves shop artwork for generic BANKOMAT/POS card payments and recovered merchant descriptions", async () => {
  await supplied("Raiffeisen.png");
  await supplied("BILLA.png");
  await importLogos();
  store.upsertMerchants([
    merchantSchema.parse({
      id: "at-billa",
      canonicalName: "BILLA",
      aliases: [],
      defaultCategory: "Lebensmittel",
      regexPatterns: [],
      region: "AT",
      source: "local",
      updatedAt: 1,
    }),
  ]);
  const base = transactionSchema.parse({
    id: "shop-card",
    date: "2026-10-01",
    bank: "Raiffeisen",
    pocket: null,
    description: "BANKOMAT/POS Verwendungszweck: BILLA",
    amount: -12,
    category: "Lebensmittel",
    categoryOverride: true,
    includeInPlan: true,
  });
  const rows = [
    base,
    {
      ...base,
      id: "spaced-shop",
      description: "BANKOMAT / POS Verwendungszweck: BILLA",
    },
    {
      ...base,
      id: "recovered-shop",
      description: "BILLA",
      rawDescription: "BANKOMAT/POS Verwendungszweck: BILLA",
    },
    {
      ...base,
      id: "shop-details",
      description: "BILLA",
      rawDetails: ["Buchungsart: BANKOMAT / POS", "Verwendungszweck: BILLA"],
    },
    {
      ...base,
      id: "confirmed-shop",
      description: "BILLA",
      rawDescription: "BANKOMAT / POS Verwendungszweck: BILLA",
      merchantAlias: "BILLA",
      merchantId: "at-billa",
      merchantNameConfirmed: true,
      manualCategory: true,
      is_locked: true,
    },
  ];
  accounts.putFinance(userId, { ...blankTestState(), transactions: rows }, 0);
  const before = accounts.getFinance(userId);
  const billa = localLogoGrants(store, userId).get("billa")!;
  const logo = { merchantId: billa.merchantId, version: billa.version };
  const marks = await accountMerchantBookingPresentations(
    store,
    rows.map((row) => row.id),
    userId,
  );
  expect(marks.slice(0, -1).map((mark) => mark.logo)).toEqual(
    rows.slice(0, -1).map(() => logo),
  );
  expect(marks.at(-1)?.logo).toBeNull();
  expect(
    (
      await accountMerchantPresentations(
        store,
        { merchantIds: ["at-billa"] },
        userId,
      )
    )[0].logo,
  ).toEqual(logo);
  expect(accounts.getFinance(userId)).toEqual(before);
});

it("does not default an explicitly labelled unknown ATM operator to private Raiffeisen artwork", async () => {
  await supplied("Raiffeisen.png");
  await importLogos();
  const descriptions = [
    "BANKOMAT 00092293 Betreiber: Unbekannter Dienst",
    "Bankautomat Operator: Unknown Cash Services",
    "Bankautomat Bank: Unlisted Institution",
    "Bankautomat Unlistedbank 00092293",
    "BANKOMAT 00092293 Betreiber: Raiffeisen",
    "BANKOMAT 00092293 Kartenfolge",
  ];
  const rows = descriptions.map((description, index) =>
    transactionSchema.parse({
      id: `operator-${index}`,
      date: "2026-10-01",
      bank: "Revolut",
      pocket: null,
      description,
      amount: -100,
      category: "Transfer",
      merchantAlias: "Raiffeisen",
      merchantNameConfirmed: true,
      is_locked: true,
      manualCategory: true,
      includeInPlan: false,
    }),
  );
  accounts.putFinance(userId, { ...blankTestState(), transactions: rows }, 0);
  const before = accounts.getFinance(userId);
  const marks = await accountMerchantBookingPresentations(
    store,
    rows.map((row) => row.id),
    userId,
  );
  const grant = localLogoGrants(store, userId).get("raiffeisen")!;
  expect(marks.slice(0, 4).map((mark) => mark.logo)).toEqual([
    null,
    null,
    null,
    null,
  ]);
  expect(marks.slice(4).map((mark) => mark.logo)).toEqual([
    {
      merchantId: grant.merchantId,
      version: grant.version,
    },
    {
      merchantId: grant.merchantId,
      version: grant.version,
    },
  ]);
  expect(accounts.getFinance(userId)).toEqual(before);
});

it("shows private Raiffeisen artwork for unnamed ATMs across banks, stored names and historic details without writing finance or associations", async () => {
  await supplied("Raiffeisen.png");
  await supplied("Revolut.png");
  await importLogos();
  const base = transactionSchema.parse({
    id: "numeric-atm",
    date: "2026-10-01",
    bank: "Revolut",
    pocket: null,
    description: "(BANKOMAT 00092293 Kartenfolge)",
    amount: -100,
    category: "Transfer",
    categoryOverride: true,
    includeInPlan: false,
    is_locked: true,
    manualCategory: true,
  });
  const rows = [
    base,
    {
      ...base,
      id: "variant",
      description: "Bankautomat: 00092293 / Kartenfolge 1",
      bank: "Raiffeisen Giro",
    },
    { ...base, id: "manual-name", merchantAlias: "Bargeld" },
    {
      ...base,
      id: "confirmed-name",
      merchantAlias: "Revolut",
      merchantId: "revolut",
      merchantNameConfirmed: true,
    },
    {
      ...base,
      id: "raw-atm",
      description: "Bargeld",
      rawDescription: "BANKOMAT 00092293 Kartenfolge 1",
    },
    {
      ...base,
      id: "details-atm",
      description: "Bargeld",
      rawDetails: [
        "Buchungstyp: Überweisung",
        "Verwendungszweck: BANKOMAT 00092293 Kartenfolge",
      ],
      sourceCategory: "SEPA Überweisung",
    },
    {
      ...base,
      id: "ordinary-transfer",
      description: "SEPA Überweisung an Raiffeisen",
      merchantAlias: "Raiffeisen",
      merchantId: "at-raiffeisen-bank-international",
    },
  ];
  const finance = { ...blankTestState(), transactions: rows };
  accounts.putFinance(userId, finance, 0);
  accounts.putFinance("other-logo-account", finance, 0);
  const before = accounts.getFinance(userId);
  const namesBefore = localLogoGrants(store, userId);
  const catalogueBefore = store.loadMerchants();
  const marks = await accountMerchantBookingPresentations(
    store,
    rows.map((row) => row.id),
    userId,
  );
  const raiffeisen = namesBefore.get("raiffeisen")!;
  expect(marks.slice(0, -1).map((mark) => mark.logo)).toEqual(
    rows.slice(0, -1).map(() => ({
      merchantId: raiffeisen.merchantId,
      version: raiffeisen.version,
    })),
  );
  expect(marks.at(-1)?.logo).toBeNull();
  expect(
    (
      await accountMerchantBookingPresentations(
        store,
        rows.map((row) => row.id),
        "other-logo-account",
      )
    ).map((mark) => mark.logo),
  ).toEqual(rows.map(() => null));
  expect(accounts.getFinance(userId)).toEqual(before);
  expect(accounts.getFinance("other-logo-account").state).toEqual(before.state);
  expect(localLogoGrants(store, userId)).toEqual(namesBefore);
  expect(store.loadMerchants()).toEqual(catalogueBefore);
  await rm(
    join(authorizedLogoDirectory(accounts.path, userId), raiffeisen.logo.file),
  );
  expect(
    (
      await accountMerchantBookingPresentations(store, ["numeric-atm"], userId)
    )[0].logo,
  ).toBeNull();
});

it("overrides ATM artwork only from explicit exact other-bank text, not account bank, confirmed names or card IDs", async () => {
  const longBank = "The Very Long Community Bank";
  for (const name of [
    "Raiffeisen",
    "BAWAG",
    "Bank Austria",
    "Sparkasse",
    "Revolut",
    longBank,
  ])
    await supplied(`${name}.png`);
  await importLogos();
  const base = transactionSchema.parse({
    id: "bawag",
    date: "2026-10-01",
    bank: "Raiffeisen",
    pocket: null,
    description: "BANKOMAT BAWAG00092293 Kartenfolge 0001",
    amount: -100,
    category: "Transfer intern",
    categoryOverride: true,
    includeInPlan: false,
    merchantAlias: "Raiffeisen",
    merchantId: "at-raiffeisen-bank-international",
    merchantNameConfirmed: true,
  });
  const rows = [
    base,
    {
      ...base,
      id: "bank-austria",
      description: "Bankautomat UniCredit Bank Austria 00092293",
      bank: "Revolut",
    },
    { ...base, id: "sparkasse", description: "Bankautomat 00092293 Sparkasse" },
    { ...base, id: "revolut", description: "Bankautomat Revolut 00092293" },
    {
      ...base,
      id: "historic-override",
      description: "BANKOMAT 00092293",
      rawDescription: "Raiffeisen BANKOMAT 00092293 BAWAG PSK",
    },
    {
      ...base,
      id: "details-override",
      description: "Bankautomat 00092293",
      rawDetails: ["Bankautomat: Bank Austria; Kartenfolge 1"],
    },
    {
      ...base,
      id: "long-bank",
      description: `BANKOMAT 00092293 ${longBank} Kartenfolge 1`,
    },
    { ...base, id: "unavailable", description: "BANKOMAT 00092293 Oberbank" },
    {
      ...base,
      id: "unknown",
      description: "Bankautomat 00092293 Unknown Bank",
    },
    {
      ...base,
      id: "conflicting",
      description: "Bankautomat BAWAG und Bank Austria",
    },
    {
      ...base,
      id: "unavailable-hsbc",
      description: "Bankautomat HSBC 00092293",
    },
  ];
  accounts.putFinance(userId, { ...blankTestState(), transactions: rows }, 0);
  const before = accounts.getFinance(userId);
  const marks = await accountMerchantBookingPresentations(
    store,
    rows.map((row) => row.id),
    userId,
  );
  const grants = localLogoGrants(store, userId);
  expect(marks.slice(0, 7).map((mark) => mark.logo?.merchantId)).toEqual(
    [
      "bawag",
      "bank austria",
      "sparkasse",
      "revolut",
      "bawag",
      "bank austria",
      longBank.toLowerCase(),
    ].map((name) => grants.get(name)!.merchantId),
  );
  expect(marks.slice(7).map((mark) => mark.logo)).toEqual([
    null,
    null,
    null,
    null,
  ]);
  expect(accounts.getFinance(userId)).toEqual(before);
});

it("uses an available public bank reference for explicitly named ATM operators but never as the unnamed ATM default", async () => {
  await supplied("Raiffeisen.png");
  await importLogos();
  const bytes = await sharp(await padded())
    .resize({ width: 128, height: 128, fit: "inside" })
    .png()
    .toBuffer();
  const file = `${createHash("sha256").update(bytes).digest("hex")}.png`;
  await mkdir(join(directory, "merchant-logos"));
  await writeFile(join(directory, "merchant-logos", file), bytes);
  const logo = {
    file,
    license: "CC0-1.0",
    attribution: "Test-created geometric PNG; CC0-1.0",
    sourceUrl:
      "https://commons.wikimedia.org/wiki/File:Test-created-example.png",
  };
  store.upsertMerchants(
    ["bank-austria", "raiffeisen"].map((bank) =>
      merchantSchema.parse({
        id:
          bank === "bank-austria"
            ? "at-bank-austria"
            : "at-raiffeisen-bank-international",
        canonicalName:
          bank === "bank-austria"
            ? "Bank Austria"
            : "Raiffeisen Bank International",
        aliases: bank === "bank-austria" ? ["UniCredit Bank Austria"] : [],
        defaultCategory: null,
        regexPatterns: [],
        region: "AT",
        source: "local",
        updatedAt: 1,
        logo,
      }),
    ),
  );
  const base = transactionSchema.parse({
    id: "public-bank-atm",
    date: "2026-10-01",
    bank: "Revolut",
    pocket: null,
    description: "BANKOMAT 00092293 UniCredit Bank Austria Kartenfolge 1",
    amount: -100,
    category: "Transfer",
    includeInPlan: true,
    merchantAlias: "Raiffeisen",
    merchantNameConfirmed: true,
  });
  const rows = [
    base,
    { ...base, id: "unnamed-atm", description: "Bankautomat 00092293" },
  ];
  for (const id of [userId, "other-logo-account"])
    accounts.putFinance(id, { ...blankTestState(), transactions: rows }, 0);
  const marks = await accountMerchantBookingPresentations(
    store,
    rows.map((row) => row.id),
    userId,
  );
  expect(marks[0].logo?.merchantId).toBe("at-bank-austria");
  expect(marks[1].logo?.merchantId).toBe(
    localLogoGrants(store, userId).get("raiffeisen")!.merchantId,
  );
  const other = await accountMerchantBookingPresentations(
    store,
    rows.map((row) => row.id),
    "other-logo-account",
  );
  expect(other[0].logo?.merchantId).toBe("at-bank-austria");
  expect(other[1].logo).toBeNull();
});

it("resolves supplied company artwork for contract labels without changing their names or finance", async () => {
  await supplied("Porsche Bank.png");
  await supplied("A1.png");
  await supplied("Allianz.png");
  await importLogos();
  const names = [
    "Porsche Bank Leasing (KL123AB)",
    "A1 Telefonvertrag",
    "Allianz | KFZ-Versicherung (KL-123AB)",
    "Porsche Bank Leasing (OTHER123)",
    "A1 Telekom Shop",
    "Allianz Consulting GmbH",
  ];
  const before = accounts.getFinance(userId);
  const result = await accountMerchantNamePresentations(store, names, userId);
  const suppliedGrants = localLogoGrants(store, userId);
  expect(result.map((mark) => mark.merchantName)).toEqual(names);
  expect(result.map((mark) => mark.logo?.merchantId ?? null)).toEqual([
    suppliedGrants.get("porsche bank")!.merchantId,
    suppliedGrants.get("a1")!.merchantId,
    suppliedGrants.get("allianz")!.merchantId,
    suppliedGrants.get("porsche bank")!.merchantId,
    null,
    null,
  ]);
  expect((await accountMerchantNamePresentations(
    store, names, "other-logo-account",
  )).every((mark) => mark.logo === null)).toBe(true);
  expect(accounts.getFinance(userId)).toEqual(before);
  const file = suppliedGrants.get("porsche bank")!.logo.file;
  await rm(join(authorizedLogoDirectory(accounts.path, userId), file));
  expect((await accountMerchantNamePresentations(store, names, userId))
    .every((mark) => mark.logo === null)).toBe(true);
});

it("prefers an exact supplied contract label to the generic company's artwork", async () => {
  await supplied("Allianz.png");
  await supplied("Allianz Haftpflicht.png");
  await importLogos();
  const result = await accountMerchantNamePresentations(
    store, ["Allianz Haftpflicht"], userId,
  );
  expect(result[0].logo?.merchantId).toBe(
    localLogoGrants(store, userId).get("allianz haftpflicht")!.merchantId,
  );
});

it("shares artwork validation and catalogue reads across ID, name and booking marks within one authenticated request", async () => {
  await supplied("A1.png");
  await importLogos();
  store.upsertMerchants([merchantSchema.parse({
    id: "a1-reference", canonicalName: "A1", aliases: [],
    regexPatterns: [], region: "AT", source: "local",
    defaultCategory: null, updatedAt: 1,
  })]);
  const row = transactionSchema.parse({
    id: "shared-request", date: "2026-10-01", bank: "Revolut", pocket: null,
    description: "A1", amount: -10, category: "Shopping",
    categoryOverride: true, includeInPlan: true,
  });
  accounts.putFinance(userId, { ...blankTestState(), transactions: [row] }, 0);
  const read = vi.spyOn(logoGrants, "readAuthorizedMerchantLogo");
  const catalogue = vi.spyOn(AutomationStore.prototype, "loadMerchants");
  try {
    const response = await marksApi(new Request("http://localhost/api/merchants/marks", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${sessionCookieName()}=${hashToken(userId)}`,
      },
      body: JSON.stringify({
        merchantIds: ["a1-reference"],
        merchantNames: ["A1 Telefonvertrag", "Unmatched company"],
        bookingIds: [row.id],
      }),
    }));
    expect(response.status).toBe(200);
    const result = await response.json();
    const logo = localLogoGrants(store, userId).get("a1")!;
    expect(result.marks[0].logo?.merchantId).toBe(logo.merchantId);
    expect(result.nameMarks[0].logo?.merchantId).toBe(logo.merchantId);
    expect(result.bookingMarks[0].logo?.merchantId).toBe(logo.merchantId);
    expect(read).toHaveBeenCalledTimes(1);
    expect(catalogue).toHaveBeenCalledTimes(1);
  } finally {
    read.mockRestore();
    catalogue.mockRestore();
  }
});

it("rejects sharing a request context with another account or database", async () => {
  const requestContext = new MerchantLogoRequest(store, userId);
  await expect(accountMerchantNamePresentations(
    store, ["A1 Telefonvertrag"], "other-logo-account", requestContext,
  )).rejects.toThrow("account mismatch");
  const other = new AccountDatabase(join(directory, "other.sqlite"));
  try {
    await expect(accountMerchantPresentations(
      new AutomationStore(other), { merchantIds: [] }, userId, requestContext,
    )).rejects.toThrow("account mismatch");
  } finally {
    other.close();
  }
});

it("reuses derived booking lookup data only for the same account and exact stored snapshot", () => {
  const row = transactionSchema.parse({
    id: "cached-booking", date: "2026-10-01", bank: "Revolut", pocket: null,
    description: "A1", amount: -10, category: "Shopping",
    categoryOverride: true, includeInPlan: true,
  });
  const state = { ...blankTestState(), transactions: [row] };
  accounts.putFinance(userId, state, 0);
  accounts.putFinance("other-logo-account", state, 0);
  const calculate = vi.spyOn(calculation, "actualBookings");
  try {
    const first = new MerchantLogoRequest(store, userId).bookings();
    expect(new MerchantLogoRequest(store, userId).bookings()).toBe(first);
    expect(calculate).toHaveBeenCalledTimes(1);
    expect(new MerchantLogoRequest(store, "other-logo-account").bookings()).not.toBe(first);
    expect(calculate).toHaveBeenCalledTimes(2);
    const updated = { ...state, transactions: [{ ...row, merchantAlias: "A1 Telefonvertrag" }] };
    accounts.putFinance(userId, updated, 1);
    const second = new MerchantLogoRequest(store, userId).bookings();
    expect(second?.rows.get(row.id)?.merchantAlias).toBe("A1 Telefonvertrag");
    expect(second).not.toBe(first);
    expect(calculate).toHaveBeenCalledTimes(3);
    accounts.transaction((db) => db.prepare(
      "UPDATE finance SET state_json = ? WHERE user_id = ?",
    ).run(JSON.stringify({ ...state, transactions: [{ ...row, description: "Allianz" }] }), userId));
    expect(new MerchantLogoRequest(store, userId).bookings()
      ?.rows.get(row.id)?.description).toBe("Allianz");
    expect(calculate).toHaveBeenCalledTimes(4);
    accounts.transaction((db) => db.prepare("DELETE FROM finance WHERE user_id = ?").run(userId));
    expect(new MerchantLogoRequest(store, userId).bookings()).toBeNull();
  } finally {
    calculate.mockRestore();
  }
});

it("does not retain oversized snapshots in the derived booking cache", () => {
  const state = blankTestState();
  accounts.putFinance(userId, state, 0);
  accounts.transaction((db) => db.prepare(
    "UPDATE finance SET state_json = ? WHERE user_id = ?",
  ).run(JSON.stringify({ ...state, legacyExtension: "x".repeat(8 * 1024 * 1024) }), userId));
  const first = new MerchantLogoRequest(store, userId).bookings();
  expect(new MerchantLogoRequest(store, userId).bookings()).not.toBe(first);
});

it("evicts least-recently-used account lookup data at the small cache limit", () => {
  accounts.transaction((db) => db.prepare(
    "INSERT INTO users VALUES ('third-logo-account', 'third-logo-account', 'user', 'fixture', 1)",
  ).run());
  for (const id of [userId, "other-logo-account", "third-logo-account"])
    accounts.putFinance(id, blankTestState(), 0);
  const first = new MerchantLogoRequest(store, userId).bookings();
  new MerchantLogoRequest(store, "other-logo-account").bookings();
  const third = new MerchantLogoRequest(store, "third-logo-account").bookings();
  expect(new MerchantLogoRequest(store, userId).bookings()).not.toBe(first);
  expect(new MerchantLogoRequest(store, "third-logo-account").bookings()).toBe(third);
});

it("bounds parallel verification of supplied files instead of re-reading them serially", async () => {
  for (let index = 0; index < 12; index++) {
    const bytes = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: index + 2, g: 40, b: 160, alpha: 1 } },
    }).png().toBuffer();
    await supplied(`Brand ${index}.png`, bytes);
  }
  await importLogos();
  const originalRead = logoGrants.readAuthorizedMerchantLogo;
  let active = 0;
  let maximum = 0;
  const read = vi.spyOn(logoGrants, "readAuthorizedMerchantLogo").mockImplementation(async (...args) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await originalRead(...args);
    } finally {
      active--;
    }
  });
  try {
    expect((await availableLocalLogoGrants(store, userId)).size).toBe(12);
    expect(read).toHaveBeenCalledTimes(12);
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(8);
  } finally {
    read.mockRestore();
  }
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

function publicMerchant(id: string, canonicalName: string, aliases: string[] = []) {
  return merchantSchema.parse({
    id, canonicalName, aliases, defaultCategory: null, regexPatterns: [], region: "AT", source: "osm", updatedAt: 1,
  });
}

function cardBooking(id: string, description: string, merchantId?: string) {
  return transactionSchema.parse({
    id, date: "2026-10-01", bank: "Raiffeisen", pocket: null, description, amount: -12,
    category: "Lebensmittel", categoryOverride: true, includeInPlan: true, ...(merchantId ? { merchantId } : {}),
  });
}

it("shows a supplied brand logo although the public catalogue lists several branches of that brand", async () => {
  await supplied("Spar.png");
  store.upsertMerchants([publicMerchant("osm-spar-1", "Spar"), publicMerchant("osm-spar-2", "SPAR", ["Spar Markt"])]);
  accounts.putFinance(userId, { ...blankTestState(), transactions: [cardBooking("spar", "SPAR DANKT 6423 Spar Fil Finkenstein")] }, 0);
  await importLogos();
  const grant = localLogoGrants(store, userId).get("spar")!;
  const [mark] = await accountMerchantBookingPresentations(store, ["spar"], userId);
  expect(mark.logo?.merchantId).toBe(grant.merchantId);
});

it("prefers the supplied file of the main brand name and falls back to the brand word of longer names", async () => {
  await supplied("Amazon.png");
  await supplied("AMZN Prime.webp", await padded("webp"));
  await supplied("Uber.png");
  store.upsertMerchants([
    publicMerchant("brand-amazon", "Amazon", ["AMZN Prime"]),
    publicMerchant("brand-uber-trip", "Uber Trip"),
    publicMerchant("brand-ub", "Ub Shop"),
  ]);
  await importLogos();
  const grants = localLogoGrants(store, userId);
  const marks = await accountMerchantPresentations(
    store, { merchantIds: ["brand-amazon", "brand-uber-trip", "brand-ub"] }, userId,
  );
  const byId = new Map(marks.map((mark) => [mark.merchantId, mark.logo]));
  expect(byId.get("brand-amazon")?.merchantId).toBe(grants.get("amazon")!.merchantId);
  expect(byId.get("brand-uber-trip")?.merchantId).toBe(grants.get("uber")!.merchantId);
  expect(byId.get("brand-ub") ?? null).toBeNull();
});

it("shows the supplied file the booking text starts with, beside catalogue near-misses, town files and spelled-out umlauts", async () => {
  for (const file of ["OBI.png", "OBI SAGT DANKE.png", "Dunkin.png", "Wien.png", "Lift Cafe.png", "Nordwagen Auto.png",
    "ÖBB.png", "LINDEN AP 1234.png", "Nordlicht.png", "H&M.png"]) await supplied(file);
  store.upsertMerchants([
    publicMerchant("cafe-1", "Cafe Eins", ["Cafe"]), publicMerchant("cafe-2", "Café Zwei", ["Cafe"]),
    publicMerchant("near-1", "Nordlichz"), publicMerchant("near-2", "Nordlichz Bar", ["Nordlichz"]),
  ]);
  const rows = [
    cardBooking("refund", "OBI SAGT DANKE VILLACH"),
    cardBooking("donut", "DUNKIN HAUPTBAHNHOF WIEN"),
    cardBooking("cafe", "SUMUP *LIFT CAFE WIEN 1040"),
    cardBooking("transfer", "To Nordwagen Auto GmbH & Co KG"),
    cardBooking("rail", "OEBB TICKET"),
    cardBooking("terminal", "LINDEN AP 8010"),
    cardBooking("airline", "NORDLICHT AIR LINES OSLO"),
    cardBooking("fashion", "HM GRAZ AT0001 GRAZ"),
  ];
  accounts.putFinance(userId, { ...blankTestState(), transactions: rows }, 0);
  await importLogos();
  const grants = localLogoGrants(store, userId);
  const marks = await accountMerchantBookingPresentations(store, rows.map((row) => row.id), userId);
  expect(marks.map((mark) => mark.logo?.merchantId ?? null)).toEqual(
    ["obi sagt danke", "dunkin", "lift cafe", "nordwagen auto", "öbb", "linden ap 1234", "nordlicht", "h m"]
      .map((name) => grants.get(name)!.merchantId),
  );
});

it("lets a web address alias show its brand file, but never a longer company name", async () => {
  await supplied("ÖBB.png");
  await supplied("A1.png");
  await importLogos();
  const marks = await accountMerchantNamePresentations(store, ["OEBB.AT", "www.oebb.at", "A1 Telekom Shop"], userId);
  const grant = localLogoGrants(store, userId).get("öbb")!;
  expect(marks.map((mark) => mark.logo?.merchantId ?? null)).toEqual([grant.merchantId, grant.merchantId, null]);
});
