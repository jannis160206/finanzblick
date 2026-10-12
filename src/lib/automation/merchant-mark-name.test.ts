import { describe, expect, it } from "vitest";
import {
  merchantLogoName,
  normalizeLogoIdentityName,
  merchantLogoBookingId,
  merchantBookingMarkKey,
} from "./merchant-mark-name";

describe("display-only merchant names", () => {
  it("uses bounded references for legacy rows and unconfirmed IDs, protecting confirmed names", () => {
    expect(merchantLogoBookingId({ id: "legacy" })).toBe("legacy");
    expect(merchantBookingMarkKey("legacy")).toBe("booking:legacy");
    for (const row of [
      { id: "legacy", merchantAlias: "Mein Händler" },
      { id: "legacy", merchantNameConfirmed: true },
      { id: "x".repeat(2001) },
      { id: "private\nid" },
    ])
      expect(merchantLogoBookingId(row)).toBeNull();
    expect(merchantLogoBookingId({ id: "legacy", merchantId: "old-id" })).toBe(
      "legacy",
    );
  });
  it("uses an existing alias, including the legacy subscription annotation", () => {
    expect(merchantLogoName({ merchantAlias: "Audi | Abo" })).toBe("Audi");
    expect(merchantLogoName({ merchantAlias: " Shell " })).toBe("Shell");
    expect(merchantLogoName({ merchantAlias: "Audi | Volkswagen" })).toBe(
      "Audi | Volkswagen",
    );
  });
  it("never guesses from booking text or replaces an existing identity", () => {
    expect(merchantLogoName({})).toBeNull();
    expect(
      merchantLogoName({ merchantId: "confirmed", merchantAlias: "Audi" }),
    ).toBeNull();
    expect(merchantLogoName({ merchantAlias: "Audi\nprivate" })).toBeNull();
    expect(merchantLogoName({ merchantAlias: "a".repeat(101) })).toBeNull();
  });
  it("only folds exact name presentation, not IDs, purpose words or spelling mistakes", () => {
    expect(normalizeLogoIdentityName(" ＡＵＤＩ ")).toBe("audi");
    expect(normalizeLogoIdentityName("Audi Bank")).toBe("audi bank");
    expect(normalizeLogoIdentityName("Audi 123")).toBe("audi 123");
    expect(normalizeLogoIdentityName("Aud1")).not.toBe("audi");
  });
});
