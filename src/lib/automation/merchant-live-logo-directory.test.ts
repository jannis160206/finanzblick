import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountDatabase } from "@/lib/server/database";
import { blankTestState, createTestDirectory } from "@/lib/server/test-support";
import { transactionSchema } from "@/lib/types";
import { AutomationStore } from "./store";
import { importSuppliedLocalLogos, localLogoGrants } from "./merchant-local-logos";
import { accountMerchantBookingPresentations } from "./merchant-booking-presentations";
import {
  LIVE_LOGO_USAGE_FILE,
  syncLiveLogoDirectory,
} from "./merchant-live-logo-directory";

let directory: string;
let logos: string;
let accounts: AccountDatabase;
let store: AutomationStore;
const userId = "live-logo-account";
const rightsReference = "Synthetic private logo usage declaration for tests.";

beforeEach(async () => {
  directory = createTestDirectory();
  logos = join(directory, "Logo");
  await mkdir(logos);
  vi.stubEnv("FINANZBLICK_LOGO_DIR", logos);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  accounts = new AccountDatabase(join(directory, "accounts.sqlite"));
  store = new AutomationStore(accounts);
  accounts.transaction((db) => {
    db.prepare("INSERT INTO users VALUES (?, ?, 'user', 'fixture', 1)").run(
      userId,
      userId,
    );
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  accounts.close();
  await rm(directory, { recursive: true, force: true });
});

async function raster() {
  const ink = await sharp({
    create: { width: 80, height: 40, channels: 4, background: "#126ab0" },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width: 200, height: 160, channels: 4, background: "#ffffff" },
  })
    .composite([{ input: ink, left: 60, top: 60 }])
    .png()
    .toBuffer();
}

async function logo(name: string) {
  await writeFile(join(logos, name), await raster());
}

async function allowAccount(id = userId) {
  await writeFile(
    join(logos, LIVE_LOGO_USAGE_FILE),
    JSON.stringify({ accounts: [{ userId: id, rightsReference }] }),
  );
}

function booking(id: string, description: string) {
  return transactionSchema.parse({
    id,
    date: "2026-10-01",
    bank: "Revolut",
    pocket: null,
    description,
    amount: -12.5,
    category: "Shopping",
    includeInPlan: true,
  });
}

let later = Date.now();
const sync = () => syncLiveLogoDirectory(store, userId, (later += 60_000));

it("assigns a logo file to every booking containing its name without a manual import", async () => {
  await logo("DISKONT.png");
  await allowAccount();
  accounts.putFinance(
    userId,
    {
      ...blankTestState(),
      transactions: [
        booking("exact", "Diskont"),
        booking("embedded", "Einkauf bei Diskont Markt Malaga"),
        booking("other", "Unrelated Bakery"),
      ],
    },
    0,
  );
  const marks = await accountMerchantBookingPresentations(
    store,
    ["exact", "embedded", "other"],
    userId,
  );
  const expected = localLogoGrants(store, userId).get("diskont")?.merchantId;
  expect(expected).toBeDefined();
  expect(marks.map((mark) => mark.logo?.merchantId ?? null)).toEqual([
    expected,
    expected,
    null,
  ]);
});

it("picks up logos added later and keeps working when one file is unusable", async () => {
  await logo("Alpha.png");
  await writeFile(join(logos, "Broken.png"), Buffer.from("not an image"));
  await allowAccount();
  await sync();
  expect([...localLogoGrants(store, userId).keys()]).toEqual(["alpha"]);
  await logo("Beta Shop.png");
  await sync();
  expect([...localLogoGrants(store, userId).keys()].sort()).toEqual([
    "alpha",
    "beta shop",
  ]);
  expect(console.error).toHaveBeenCalled();
});

it("takes back the logo of a deleted file and restores it when the file returns", async () => {
  await logo("Alpha.png");
  await logo("Gamma.png");
  await allowAccount();
  await sync();
  await rm(join(logos, "Gamma.png"));
  await sync();
  expect([...localLogoGrants(store, userId).keys()]).toEqual(["alpha"]);
  await logo("Gamma.png");
  await sync();
  expect([...localLogoGrants(store, userId).keys()].sort()).toEqual(["alpha", "gamma"]);
});

it("keeps logos imported from elsewhere under another declaration", async () => {
  await mkdir(join(directory, "Other"));
  await writeFile(join(directory, "Other", "Delta.png"), await raster());
  await importSuppliedLocalLogos(store, {
    userId, rightsReference: "Operator import from another folder.", directory: join(directory, "Other"),
  });
  await logo("Alpha.png");
  await allowAccount();
  await sync();
  expect([...localLogoGrants(store, userId).keys()].sort()).toEqual(["alpha", "delta"]);
});

it("does nothing without a usage declaration for this account", async () => {
  await logo("Alpha.png");
  await sync();
  expect(localLogoGrants(store, userId).size).toBe(0);
  await allowAccount("another-account-id");
  await sync();
  expect(localLogoGrants(store, userId).size).toBe(0);
});

it("does not relist the folder within the throttle window", async () => {
  await logo("Alpha.png");
  await allowAccount();
  const now = Date.now() + 1_000_000;
  await syncLiveLogoDirectory(store, userId, now);
  await logo("Beta.png");
  await syncLiveLogoDirectory(store, userId, now + 100);
  expect([...localLogoGrants(store, userId).keys()]).toEqual(["alpha"]);
  await syncLiveLogoDirectory(store, userId, now + 10_000);
  expect(localLogoGrants(store, userId).size).toBe(2);
});

it("keeps a payment-provider logo from claiming unrelated merchants", async () => {
  await logo("PayPal.png");
  await allowAccount();
  accounts.putFinance(
    userId,
    {
      ...blankTestState(),
      transactions: [booking("provider", "Hotel Sonnenhof via PayPal")],
    },
    0,
  );
  const [mark] = await accountMerchantBookingPresentations(
    store,
    ["provider"],
    userId,
  );
  expect(mark.logo).toBeNull();
});
