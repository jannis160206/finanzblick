import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { seedMerchants } from "./merchants";
import {
  authorizedLogoChoicesSchema,
  reviewedCommonsManifestSchema,
  reviewedWikimediaManifestSchema,
} from "./merchant-logo-authorized-import";

it("keeps reviewed artwork tied to existing exact factual seed identities", () => {
  const manifest = reviewedCommonsManifestSchema.parse(
    JSON.parse(
      readFileSync(
        resolve("scripts", "data", "merchant-logo-reviewed-files.json"),
        "utf8",
      ),
    ),
  );
  const seeds = new Map(
    seedMerchants.map((merchant) => [merchant.id, merchant]),
  );
  expect(new Set(manifest.entries.map((entry) => entry.merchantId)).size).toBe(
    manifest.entries.length,
  );
  for (const entry of manifest.entries)
    expect(seeds.get(entry.merchantId)?.wikidataId).toBe(entry.wikidataId);
  expect(
    manifest.entries.find((entry) => entry.merchantId === "toyota")?.filename,
  ).toBe("Toyota Symbol.svg");
});

it("keeps reproducible P154 choices bounded and explicit rather than arbitrary URLs", () => {
  const choices = authorizedLogoChoicesSchema.parse(
    JSON.parse(
      readFileSync(
        resolve("scripts", "data", "merchant-logo-choices.json"),
        "utf8",
      ),
    ),
  );
  expect(new Set(choices.map((choice) => choice.wikidataId)).size).toBe(
    choices.length,
  );
  expect(choices.some((choice) => choice.wikidataId === "Q154950")).toBe(false);
  expect(
    choices.find((choice) => choice.wikidataId === "Q483915")?.filename,
  ).toBe("Logo NIKE.svg");
  expect(choices.some((choice) => choice.wikidataId === "Q125054")).toBe(false);
  const known = new Set([
    ...seedMerchants.map((merchant) => merchant.wikidataId),
    "Q390107",
    "Q649646",
    "Q665740",
  ]);
  for (const choice of choices) expect(known.has(choice.wikidataId)).toBe(true);
});

it("keeps reviewed German Wikimedia artwork tied to exact seed identities and truthful source evidence", () => {
  const manifest = reviewedWikimediaManifestSchema.parse(
    JSON.parse(
      readFileSync(
        resolve("scripts", "data", "merchant-logo-reviewed-wikimedia.json"),
        "utf8",
      ),
    ),
  );
  const seeds = new Map(
    seedMerchants.map((merchant) => [merchant.id, merchant]),
  );
  for (const entry of manifest.entries) {
    expect(seeds.get(entry.merchantId)?.wikidataId).toBe(entry.wikidataId);
    expect(entry.wiki).toBe("de");
    expect(entry.evidence.length).toBeGreaterThan(60);
  }
  expect(
    manifest.entries.find((entry) => entry.merchantId === "at-shell")?.filename,
  ).toBe("Royal Dutch Shell.svg");
  expect(
    manifest.entries.find((entry) => entry.merchantId === "at-anker")
      ?.wikidataId,
  ).toBe("Q557116");
});
