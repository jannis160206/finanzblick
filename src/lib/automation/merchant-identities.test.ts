import { describe, expect, it } from "vitest";
import { curatedMerchantIdentities } from "./merchant-identities";
import { MerchantIndex, seedMerchants } from "./merchants";

describe("verified public seed identities", () => {
  it("only attaches valid public identities to existing factual seeds", () => {
    const seeds = new Map(
      seedMerchants.map((merchant) => [merchant.id, merchant]),
    );
    for (const [id, wikidataId] of Object.entries(curatedMerchantIdentities)) {
      expect(wikidataId).toMatch(/^Q[1-9]\d{0,11}$/);
      expect(seeds.get(id)?.wikidataId).toBe(wikidataId);
      expect(seeds.get(id)?.source).toBe("local");
      expect(seeds.get(id)?.logo).toBeNull();
    }
  });

  it("does not combine service purposes just because their company supplies branding", () => {
    const index = new MerchantIndex(seedMerchants);
    expect(index.match("Uber Eats")).toMatchObject({
      merchant: {
        id: "uber-eats",
        wikidataId: "Q21462723",
        defaultCategory: "Lieferdienste",
      },
    });
    expect(index.match("Uber Trip")).toMatchObject({
      merchant: {
        id: "uber-trips",
        wikidataId: "Q780442",
        defaultCategory: "Mobilität",
      },
    });
    expect(index.match("Shell")).toMatchObject({
      merchant: { id: "at-shell", requiresCategoryEvidence: true },
    });
    expect(index.match("OMV")).toMatchObject({
      merchant: { id: "at-omv", requiresCategoryEvidence: true },
    });
  });

  it("keeps exact product identities and leaves unverified brands without an entity", () => {
    const seeds = new Map(seedMerchants.map((merchant) => [merchant.id, merchant]));
    expect(seeds.get("rewe")?.wikidataId).toBe("Q16968817");
    expect(seeds.get("sky-x")?.wikidataId).toBe("Q139587834");
    expect(seeds.get("paramount-plus")?.wikidataId).toBe("Q27903045");
    expect(seeds.get("at-hdi")?.wikidataId).toBe("Q1563024");
    expect(seeds.get("le-burger")?.wikidataId).toBeNull();
    for (const id of ["esso", "bp", "jet", "avia"]) {
      expect(seeds.get(id)?.requiresCategoryEvidence).toBe(true);
    }
  });
});
