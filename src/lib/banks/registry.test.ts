import { describe, expect, it } from "vitest";
import {
  BANKS, bankByBic, bankColor, bankDisplayName, bankLabel, bankLogoUrl, bankMonogram, canonicalBank, normalizeBankName,
} from "./registry";

const channel = (value: number) => Math.min(1, Math.max(0, value));

function hexLuminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// OKLCH → linear sRGB (Björn Ottosson's matrices), clamped to the sRGB gamut.
function oklchLuminance(css: string) {
  const [lightness, chroma, hue] = css.match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/)!.slice(1).map(Number);
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const red = channel(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = channel(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = channel(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

const contrastWithWhite = (luminance: number) => 1.05 / (luminance + 0.05);
const contrastOf = (color: string) =>
  contrastWithWhite(color.startsWith("#") ? hexLuminance(color) : oklchLuminance(color));

describe("bank registry data", () => {
  it("has unique, file-safe ids and plain official domains", () => {
    expect(new Set(BANKS.map((entry) => entry.id)).size).toBe(BANKS.length);
    for (const entry of BANKS) {
      expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      for (const domain of [entry.domain, ...(entry.assetDomains ?? [])])
        expect(domain).toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/);
      for (const prefix of entry.bic ?? []) expect(prefix).toMatch(/^[A-Z0-9]{2,11}$/);
    }
  });

  it("maps every registry name back to its own entry", () => {
    for (const entry of BANKS) expect(canonicalBank(entry.name, entry.country)?.id).toBe(entry.id);
  });

  it("keeps every brand color readable with white text", () => {
    for (const entry of BANKS.filter((bank) => bank.color)) {
      expect(entry.color).toMatch(/^#[0-9a-f]{6}$/);
      expect(contrastOf(entry.color!), entry.id).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("canonicalBank", () => {
  it.each([
    ["Raiffeisen", "raiffeisen"],
    ["RAIFFEISEN BANK", "raiffeisen"],
    ["Raiffeisenbank Kärnten", "raiffeisen"],
    ["Raiffeisen-Landesbank Steiermark", "raiffeisen"],
    ["Raiffeisenlandesbank Oberösterreich", "raiffeisen"],
    ["RLB NÖ-Wien", "raiffeisen"],
    ["Raiffeisen · Giro (EUR)", "raiffeisen"],
    ["Erste Bank der oesterreichischen Sparkassen AG", "erste"],
    ["Kärntner Sparkasse", "sparkasse-at"],
    ["Die Zweite Sparkasse", "sparkasse-at"],
    ["UniCredit Bank Austria AG", "bank-austria"],
    ["BAWAG P.S.K.", "bawag"],
    ["easybank", "easybank"],
    ["Oberbank AG", "oberbank"],
    ["Volksbank Wien", "volksbank-at"],
    ["HYPO NOE Landesbank", "hypo"],
    ["N26 Bank GmbH", "n26"],
    ["Revolut Bank UAB", "revolut"],
    ["Trade Republic Bank GmbH", "trade-republic"],
    ["Amex", "amex"],
    ["American Express Europe S.A.", "amex"],
    ["PayPal (Europe) S.à r.l. et Cie, S.C.A.", "paypal"],
    ["ING-DiBa", "ing"],
    ["ING", "ing"],
    ["Deutsche Kreditbank", "dkb"],
    ["comdirect bank", "comdirect"],
    ["Commerzbank", "commerzbank"],
    ["Deutsche Bank", "deutsche-bank"],
    ["TransferWise", "wise"],
    ["bunq", "bunq"],
    ["Klarna Bank AB", "klarna"],
  ])("recognizes %s", (name, id) => {
    expect(canonicalBank(name)?.id).toBe(id);
  });

  it("lets the country decide between banks sharing a name", () => {
    expect(canonicalBank("Sparkasse")?.id).toBe("sparkasse-at");
    expect(canonicalBank("Sparkasse KölnBonn", "DE")?.id).toBe("sparkasse-de");
    expect(canonicalBank("Stadtsparkasse München", "de")?.id).toBe("sparkasse-de");
    expect(canonicalBank("Volksbank")?.id).toBe("volksbank-at");
    expect(canonicalBank("Volksbank Mittelhessen", "DE")?.id).toBe("vr-de");
    expect(canonicalBank("Raiffeisenbank im Hochtaunus", "DE")?.id).toBe("vr-de");
    expect(canonicalBank("VR-Bank Ostalb", "DE")?.id).toBe("vr-de");
    expect(canonicalBank("Revolut", "DE")?.id).toBe("revolut");
  });

  it("ignores unrelated names, titles and empty input", () => {
    expect(canonicalBank("Andere Bank")).toBeUndefined();
    expect(canonicalBank("Ing. Max Mustermann")).toBeUndefined();
    expect(canonicalBank("Bausparkasse Wüstenrot")).toBeUndefined();
    expect(canonicalBank("")).toBeUndefined();
    expect(canonicalBank(null)).toBeUndefined();
    expect(canonicalBank(undefined)).toBeUndefined();
  });

  it("falls back to BIC prefixes, longest prefix first", () => {
    expect(canonicalBank("RZKTAT2K")?.id).toBe("raiffeisen");
    expect(bankByBic("BKAUATWW")?.id).toBe("bank-austria");
    expect(bankByBic("COBADEHD001")?.id).toBe("comdirect");
    expect(bankByBic("COBADEFFXXX")?.id).toBe("commerzbank");
    expect(bankByBic("GENODEF1M04")?.id).toBe("vr-de");
    expect(bankByBic("bawa at ww")?.id).toBe("bawag");
    expect(bankByBic("ZZZZATWW")).toBeUndefined();
    expect(bankByBic("RZ")).toBeUndefined();
  });
});

describe("bank labels", () => {
  it("normalizes case, accents, punctuation and account suffixes", () => {
    expect(bankLabel("Raiffeisen · Giro (EUR)")).toBe("Raiffeisen");
    expect(normalizeBankName("  Bank   Österreich & Söhne (EUR) ")).toBe("bank osterreich sohne");
    expect(normalizeBankName("Straßenbank")).toBe("strassenbank");
  });

  it("shows registry names for known banks and the cleaned label otherwise", () => {
    expect(bankDisplayName("Raiffeisenbank Kärnten")).toBe("Raiffeisen");
    expect(bankDisplayName("Amex · Kreditkarte")).toBe("American Express");
    expect(bankDisplayName("Dolomitenbank (EUR)")).toBe("Dolomitenbank");
    expect(bankDisplayName(null)).toBe("");
  });

  it("builds one or two letter monograms", () => {
    expect(bankMonogram("Raiffeisen")).toBe("R");
    expect(bankMonogram("Raiffeisenbank Kärnten")).toBe("R");
    expect(bankMonogram("Trade Republic")).toBe("TR");
    expect(bankMonogram("Amex")).toBe("AE");
    expect(bankMonogram("American Express")).toBe("AE");
    expect(bankMonogram("N26")).toBe("N");
    expect(bankMonogram("Volksbank", "DE")).toBe("VR");
    expect(bankMonogram("Bankhaus Spängler & Co. AG")).toBe("BS");
    expect(bankMonogram("Oberbank AG")).toBe("O");
    expect(bankMonogram("ölbank")).toBe("Ö");
    expect(bankMonogram("")).toBe("");
  });
});

describe("bankColor", () => {
  it("uses the registry color when known", () => {
    expect(bankColor("Raiffeisenbank Kärnten")).toBe("#6b5a00");
    expect(bankColor("Amex")).toBe("#006fcf");
  });

  it("derives a stable hue from the name otherwise", () => {
    const color = bankColor("Dolomitenbank");
    expect(color).toMatch(/^oklch\(0\.5 0\.11 \d{1,3}\)$/);
    expect(bankColor("DOLOMITENBANK (EUR)")).toBe(color);
    expect(bankColor("Bankhaus Spängler")).not.toBe(color);
    expect(bankColor("")).toBe("oklch(0.5 0.02 260)");
  });

  it("keeps derived colors readable with white text for every hue", () => {
    for (let hue = 0; hue < 360; hue++)
      expect(contrastOf(`oklch(0.5 0.11 ${hue})`), `hue ${hue}`).toBeGreaterThanOrEqual(4.5);
    expect(contrastOf("oklch(0.5 0.02 260)")).toBeGreaterThanOrEqual(4.5);
  });
});

describe("bankLogoUrl", () => {
  it("asks for the registry name so every label shares one logo", () => {
    expect(bankLogoUrl("Raiffeisenbank Kärnten · Giro")).toBe("/api/banks/logo?name=Raiffeisen&country=AT");
    expect(bankLogoUrl("Commerzbank")).toBe("/api/banks/logo?name=Commerzbank&country=DE");
    expect(bankLogoUrl("Volksbank", "DE")).toBe("/api/banks/logo?name=Volksbank+Raiffeisenbank&country=DE");
    expect(bankLogoUrl("Revolut", "de")).toBe("/api/banks/logo?name=Revolut&country=DE");
  });

  it("keeps unknown names, trims and limits them", () => {
    expect(bankLogoUrl(" Dolomitenbank (EUR) ", "AT")).toBe("/api/banks/logo?name=Dolomitenbank&country=AT");
    const url = new URL(bankLogoUrl(`Bank ${"x".repeat(200)}`), "http://localhost");
    expect(url.searchParams.get("name")).toHaveLength(120);
    expect(bankLogoUrl("   ")).toBe("");
  });
});
