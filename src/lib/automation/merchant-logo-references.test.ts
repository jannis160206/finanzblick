import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { seedMerchants } from "./merchants";
import {
  authorizedLogoChoicesSchema,
  reviewedCommonsManifestSchema,
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
  expect(
    choices.find((choice) => choice.wikidataId === "Q154950")?.filename,
  ).toBe("Shell oil cropped 2.png");
});
