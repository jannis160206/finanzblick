import { describe, expect, it } from "vitest";
import { categories } from "@/lib/categories";
import {
  MerchantIndex,
  merchantSchema,
  normalizeMerchantText,
  seedMerchants,
  type Merchant,
} from "./merchants";

const index = new MerchantIndex(seedMerchants);
const merchant = (overrides: Partial<Merchant> = {}): Merchant => ({
  id: "test-merchant",
  canonicalName: "Test Merchant",
  aliases: [],
  regexPatterns: [],
  defaultCategory: "Shopping",
  region: "AT",
  source: "local",
  wikidataId: null,
  requiresCategoryEvidence: false,
  city: null,
  license: null,
  attribution: null,
  logo: null,
  updatedAt: 0,
  ...overrides,
});
const expectMerchant = (text: string, id: string, method = "exact") => {
  const result = index.match(text);
  expect(result.merchant?.id).toBe(id);
  expect(result.requiresManualReview).toBe(method === "fuzzy");
  expect(result.method).toBe(method);
};

describe("merchant schema and local seeds", () => {
  it("indexes verified shared aliases once and preserves an existing public identity on request", () => {
    const local = merchant({
      id: "local-identity",
      canonicalName: "Nordlicht",
      wikidataId: "Q123",
    });
    const imported = merchant({
      id: "osm-identity",
      canonicalName: "Nordlicht",
      aliases: ["Northern Lights"],
      wikidataId: "Q123",
      source: "osm",
    });
    const index = new MerchantIndex([imported, local]);
    expect(index.match("Northern Lights")).toMatchObject({
      merchant: { id: local.id },
      method: "exact",
    });
    expect(index.match("Northern Lights", imported.id)).toMatchObject({
      merchant: { id: imported.id },
    });
    expect(index.match("Northern Lights", "unrelated")).toMatchObject({
      merchant: { id: local.id },
    });
    expect(index.match("Northern Lighst").requiresManualReview).toBe(true);
  });

  it("keeps very large ambiguous alias postings bounded during matching", () => {
    const index = new MerchantIndex(
      Array.from({ length: 1000 }, (_, id) =>
        merchant({ id: `collision-${id}`, canonicalName: "Nordlicht" }),
      ),
    );
    expect(index.match("Nordlicht")).toEqual({
      method: "exact",
      requiresManualReview: true,
    });
    expect(index.match("Nordlihct")).toMatchObject({
      requiresManualReview: true,
    });
    expect(index.match("Nordlicht").merchant).toBeUndefined();
  });

  it.each([
    ["MPREIS", "at-mpreis"],
    ["Ströck", "at-stroeck"],
    ["Kentucky Fried Chicken", "kfc"],
    ["Paramount+", "paramount-plus"],
    ["Wiener Staedtische", "at-wiener-staedtische"],
  ])("recognizes the additional concrete reference %s", (text, id) => {
    expect(index.match(text).merchant?.id).toBe(id);
  });
  it("does not discard stricter purpose requirements while resolving duplicate public identities", () => {
    const common = merchant({
      canonicalName: "Test Merchant",
      wikidataId: "Q123",
    });
    const index = new MerchantIndex([
      common,
      { ...common, id: "strict", requiresCategoryEvidence: true },
    ]);
    expect(index.match("Test Merchant")).toMatchObject({
      requiresManualReview: true,
    });
    expect(index.match("Test Merchant").merchant).toBeUndefined();
  });
  it("validates the curated AT database against current purpose categories", () => {
    expect(new Set(seedMerchants.map((item) => item.id)).size).toBe(
      seedMerchants.length,
    );
    for (const item of seedMerchants) {
      expect(merchantSchema.parse(item)).toEqual(item);
      if (item.defaultCategory !== null)
        expect(categories).toContain(item.defaultCategory);
      expect(item.region).toBe("AT");
      expect(item.source).toBe("local");
    }
  });

  it("rejects missing fields, non-current categories, unsafe timestamps and provider identities", () => {
    expect(merchantSchema.safeParse({}).success).toBe(false);
    for (const item of [
      { defaultCategory: "PayPal Abo" },
      { defaultCategory: "Imaginary" },
      { updatedAt: -1 },
      { updatedAt: 0.5 },
      { updatedAt: Number.POSITIVE_INFINITY },
      { canonicalName: "PayPal" },
      { aliases: ["Klarna"] },
      { aliases: ["12345"] },
      { aliases: ["D1"] },
      { aliases: ["K2"] },
      { aliases: [".AT"] },
    ])
      expect(merchantSchema.safeParse({ ...merchant(), ...item }).success).toBe(
        false,
      );
  });

  it("rejects logos with unknown rights or non-Commons attribution sources at the storage boundary", () => {
    const logo = {
      file: `${"a".repeat(64)}.png`,
      license: "CC-BY-4.0",
      attribution: "Test artist",
      sourceUrl: "https://commons.wikimedia.org/wiki/File:Test.png",
    };
    expect(merchantSchema.safeParse({ ...merchant(), logo }).success).toBe(
      true,
    );
    for (const invalid of [
      { ...logo, license: "All rights reserved" },
      { ...logo, sourceUrl: "https://example.com/logo.png" },
    ])
      expect(
        merchantSchema.safeParse({ ...merchant(), logo: invalid }).success,
      ).toBe(false);
  });

  it.each([
    "(a+)+$",
    "(a|aa)+$",
    ".*billa.*",
    "\\b(?:billa|penny)\\b",
    "(?=billa)billa",
    "(billa)\\1",
    "billa+",
    "billa{1,100}",
    "billa{1,}",
    "a?a?a?billa",
    "\\bbilla[",
    "\\b\\b",
    "^$",
    "[a-z]{1,8}[a-z]{1,8}[a-z]{1,8}",
    "\\p{L}billa",
  ])(
    "rejects unsafe/unsupported regex %s at schema and constructor boundaries",
    (pattern) => {
      const input = merchant({ regexPatterns: [pattern] });
      expect(merchantSchema.safeParse(input).success).toBe(false);
      expect(() => new MerchantIndex([input])).toThrow();
    },
  );

  it("accepts bounded local regexes, rejects non-local patterns and duplicate IDs", () => {
    expect(
      merchantSchema.safeParse(
        merchant({
          regexPatterns: ["\\bbilla[ ]?online\\b", "^bill[a-z]{1,2}$"],
        }),
      ).success,
    ).toBe(true);
    expect(
      merchantSchema.safeParse(
        merchant({ source: "remote", regexPatterns: ["billa"] }),
      ).success,
    ).toBe(false);
    expect(() => new MerchantIndex([merchant(), merchant()])).toThrow(
      "Duplicate merchant ID",
    );
  });
});

describe("merchant text normalization", () => {
  it.each([
    ["MÜLLER Fil. 0042 Wien 08.10.2026 14:32:01", "mueller wien"],
    ["Mueller #0042 WIEN", "mueller wien"],
    ["BILLA1234 Filiale AB0042 POS", "billa"],
    ["POS BILLA4711", "billa"],
    ["PENNY Markt 1234 Graz 2026-10-08T14:32:01Z", "penny markt graz"],
    [
      "Händler: Müller; Referenz: PP-BILLA12345; IBAN: AT61 1904 3002 3457 3201",
      "mueller",
    ],
    ["BILLA AT611904300234573201", "billa"],
    ["IBAN: AT611904300234573201 BILLA", "billa"],
    ["BILLA DE89 3704 0044 0532 0130 00", "billa"],
    ["BILLA GB82 WEST 1234 5698 7654 32", "billa"],
    ["ID: BILLA99999", ""],
    [
      "POS Terminal-ID: BILLA4711 Händler: PENNY 12:42 Referenz: MUELLER99",
      "penny",
    ],
    [
      "POS 0142 Terminal Nr. X1234 Müller Filiale 47 08.10.2026 12:32",
      "mueller",
    ],
    ["Rückerstattung BILLA 08.10.2026", "billa"],
  ])("cleans %s without losing merchant letters", (input, expected) => {
    expect(normalizeMerchantText(input)).toBe(expected);
  });

  it("keeps meaningful letters and short alphanumeric names", () => {
    expect(normalizeMerchantText("ÖBB Müller Straße A1")).toBe(
      "oebb mueller strasse a1",
    );
    expect(normalizeMerchantText("Müller")).toBe(
      normalizeMerchantText("Mueller"),
    );
    expect(normalizeMerchantText("BILLA" + " ".repeat(1024))).toBe("");
  });
});

describe("indexed merchant matching", () => {
  it.each([
    ["POS H&M Filiale 1234 Wien", "hm"],
    ["POS C&A Terminal 9876", "ca"],
    ["Lastschrift A1 Telekom Austria", "at-a1"],
    ["POS A1 Terminal 1234", "at-a1"],
    ["PayPal*AMZN Mktp 38734", "amazon"],
    ["Card Payment SPOTIFY AB", "spotify"],
    ["DISNEY+ WIEN", "disney-plus"],
    ["UBER *TRIP", "uber-trips"],
    ["UBER *EATS", "uber-eats"],
    ["McDonalds Graz", "mcdonalds"],
    ["POST.AT", "at-post"],
  ])("recognizes unambiguous concrete catalog aliases: %s", (text, id) => {
    expectMerchant(text, id);
  });

  it("does not identify a known brand mentioned inside another merchant's name", () => {
    expect(index.match("Unknown shop near BILLA")).toMatchObject({
      requiresManualReview: true,
    });
    expect(index.match("Corporate cafe Mueller")).toMatchObject({
      requiresManualReview: true,
    });
    expect(index.match("APPLE.COM/BILL")).toMatchObject({
      method: "exact",
      requiresManualReview: true,
    });
  });

  it("coalesces only independently verified same-brand identities with agreeing categories", () => {
    const bipa = seedMerchants.find((item) => item.id === "at-bipa");
    if (!bipa) throw new Error("BIPA seed is missing");
    const imported = merchant({
      id: "osm-bipa",
      source: "osm",
      canonicalName: "Bipa",
      defaultCategory: "Drogerie",
      wikidataId: "Q864933",
    });
    for (const order of [
      [bipa, imported],
      [imported, bipa],
    ])
      expect(new MerchantIndex(order).match("BIPA Wien")).toMatchObject({
        merchant: { id: "at-bipa" },
        requiresManualReview: false,
      });
    for (const variant of [
      { ...imported, wikidataId: null },
      { ...imported, wikidataId: "Q123" },
      { ...imported, defaultCategory: "Restaurants" as const },
      { ...imported, canonicalName: "BIPA Shop", aliases: ["BIPA"] },
    ])
      expect(
        new MerchantIndex([bipa, variant]).match("BIPA Wien"),
      ).toMatchObject({ requiresManualReview: true });
  });

  it.each([
    ["BILLA", "at-billa"],
    ["POS BILLA Filiale 001234 WIEN AT 08.10.2026 12:42", "at-billa"],
    ["BILLA1234 1010 Wien", "at-billa"],
    ["PENNY Markt 0234 Graz", "at-penny"],
    ["Müller Fil. 1234 Klagenfurt", "at-mueller"],
    ["MUELLER DROGERIE 0042 Wien", "at-mueller"],
    ["BILLA Plus", "at-billa"],
    ["dm-drogerie markt Wien", "at-dm"],
    ["ÖBB Personenverkehr", "at-oebb"],
  ])("matches exact aliases in branch/location text: %s", (text, id) => {
    expectMerchant(text, id);
  });

  it.each([
    ["PayPal*BILLA 1234 Wien", "at-billa"],
    ["PAYPAL * PENNY MARKT 0123", "at-penny"],
    ["Klarna*Müller", "at-mueller"],
    ["SumUp * Martin Auer Graz", "at-martin-auer"],
    ["PayPal Europe S.a.r.l. et Cie S.C.A. * BILLA", "at-billa"],
    ["Stripe / Thalia", "at-thalia"],
    ["Apple Pay * HOFER", "at-hofer"],
    ["Pay Pal * BILLA", "at-billa"],
  ])("extracts the actual merchant from a payment provider: %s", (text, id) => {
    expectMerchant(text, id);
  });

  it.each([
    "PayPal",
    "PayPal ID 123456789",
    "PayPal ID BILLA123456",
    "PayPal Referenz: BILLA",
    "PayPal ID: Stripe*BILLA",
    "PayPal Ref: PAYPAL*BILLA",
    "PayPal Referenz: PP BILLA",
    "PayPal ID=BILLA12345",
    "PayPal Europe S.a.r.l. et Cie S.C.A. ID 12345678",
    "KLARNA 012345",
    "SUMUP * 123456",
    "Stripe * unknown shop",
    "BILL",
    "PENNI",
    "A completely unknown merchant",
    "",
    "08.10.2026 14:32",
    "IBAN: AT61 1904 3002 3457 3201",
  ])("leaves unresolved providers/unknowns for review: %s", (text) => {
    expect(index.match(text)).toEqual({
      method: "none",
      requiresManualReview: true,
    });
  });

  it("uses precompiled safe regexes without stateful lastIndex", () => {
    expectMerchant("BillaOnline Wien", "at-billa", "regex");
    expectMerchant("BillaOnline Wien", "at-billa", "regex");
  });

  it.each([
    "BILLA PENNY",
    "PENNY BILLA",
    "PayPal*BILLA / Klarna*PENNY",
    "BILLA Müller",
    "BILLA BillaOnline PENNY",
  ])("never picks a merchant from conflicting signals: %s", (text) => {
    expect(index.match(text)).toEqual({
      method: "exact",
      requiresManualReview: true,
    });
  });

  it("does not favor a whole-description alias over a conflicting token alias", () => {
    const collision = new MerchantIndex([
      merchant({ id: "a", canonicalName: "Billa" }),
      merchant({ id: "b", canonicalName: "Billa Plus" }),
    ]);
    expect(collision.match("Billa Plus")).toEqual({
      method: "exact",
      requiresManualReview: true,
    });
  });

  it("retains alias collisions instead of overwriting based on insertion order", () => {
    const inputs = [
      merchant({ id: "a", canonicalName: "Müller" }),
      merchant({
        id: "b",
        canonicalName: "Mueller",
        defaultCategory: "Drogerie",
      }),
    ];
    for (const ordered of [inputs, [...inputs].reverse()]) {
      expect(new MerchantIndex(ordered).match("Müller Fil.123 Wien")).toEqual({
        method: "exact",
        requiresManualReview: true,
      });
    }
  });

  it("detects regex-only and exact/regex collisions", () => {
    const collision = new MerchantIndex([
      merchant({
        id: "a",
        canonicalName: "Billa",
        regexPatterns: ["\\bonlineshop\\b"],
      }),
      merchant({
        id: "b",
        canonicalName: "Penny",
        regexPatterns: ["\\bonlineshop\\b"],
      }),
    ]);
    expect(collision.match("OnlineShop")).toEqual({
      method: "regex",
      requiresManualReview: true,
    });
    expect(collision.match("Billa OnlineShop")).toEqual({
      method: "exact",
      requiresManualReview: true,
    });
  });

  it.each([
    ["Muelller", "at-mueller"],
    ["Muelller Fil. 1234 Wien", "at-mueller"],
    ["PayPal*Muelller", "at-mueller"],
    ["INTERPSAR", "at-spar"],
    ["Fressnap", "at-fressnapf"],
  ])("uses the bounded one-edit fuzzy fallback for %s", (text, id) => {
    expectMerchant(text, id, "fuzzy");
  });

  it("rejects multiple edits and ambiguous fuzzy candidates", () => {
    expect(index.match("Muelllerr").merchant).toBeUndefined();
    const collision = new MerchantIndex([
      merchant({ id: "a", canonicalName: "Merchant" }),
      merchant({ id: "b", canonicalName: "Merchants" }),
    ]);
    expect(collision.match("Merchantt")).toEqual({
      method: "fuzzy",
      requiresManualReview: true,
    });
  });

  it("fails closed on oversized text and too many words, rather than truncating conflicts", () => {
    expect(
      index.match("BILLA " + " ".repeat(1024) + "PENNY").merchant,
    ).toBeUndefined();
    expect(
      index.match("BILLA " + "word ".repeat(32) + "PENNY").merchant,
    ).toBeUndefined();
  });

  it("does not fuzzy-scan saturated posting lists", () => {
    const large = new MerchantIndex(
      Array.from({ length: 65 }, (_, position) =>
        merchant({
          id: `merchant-${position}`,
          canonicalName: `Merchant${String.fromCharCode(97 + Math.floor(position / 26))}${String.fromCharCode(97 + (position % 26))}`,
        }),
      ),
    );
    expect(large.match("Merchentaa")).toEqual({
      method: "none",
      requiresManualReview: true,
    });
    expect(large.match("Merchantaa").merchant?.id).toBe("merchant-0");
  });

  it("snapshots caller-owned merchant definitions", () => {
    const input = merchant({ canonicalName: "Billa" });
    const snapshot = new MerchantIndex([input]);
    input.canonicalName = "Penny";
    input.aliases.push("Penny");
    expect(snapshot.match("Billa").merchant?.canonicalName).toBe("Billa");
    expect(snapshot.match("Penny").merchant).toBeUndefined();
  });
});
