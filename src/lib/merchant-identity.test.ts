import { expect, it } from "vitest";
import { merchantAliasAssignment } from "./merchant-identity";

it("clears stale global identity and logos on a manual name change, not on category-only edits", () => {
  const row = {
    merchantAlias: "BILLA",
    merchantId: "at-billa",
    merchantLogo: true,
    merchantMatch: "alias" as const,
  };
  expect(merchantAliasAssignment(row, "Mein Laden")).toEqual({
    merchantAlias: "Mein Laden",
    merchantNameConfirmed: true,
    merchantId: undefined,
    merchantLogo: false,
    merchantMatch: undefined,
  });
  expect(merchantAliasAssignment(row, "BILLA")).toEqual({
    merchantAlias: "BILLA",
    merchantNameConfirmed: true,
  });
  expect(merchantAliasAssignment({}, "Mein Laden")).toEqual({
    merchantAlias: "Mein Laden",
    merchantNameConfirmed: true,
  });
});
