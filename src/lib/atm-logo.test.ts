import { describe, expect, it } from "vitest";
import { atmLogoBank, isAtmBooking } from "./atm-logo";
import { shouldShowMerchantMark } from "./merchant-mark-policy";
import { classify } from "./calc";
import { transactionSchema } from "./types";

describe("display-only ATM artwork", () => {
  it.each([
    "BANKOMAT 00092293 Kartenfolge",
    "(BANKOMAT 00092293 Kartenfolge: 001)",
    "BANKOMAT00092293 KARTENFOLGE 001",
    "Bankautomat 00092293",
    "bankautomat: 92293 / Kartenfolge 1",
    "BANK-AUTOMAT 00092293",
    "Bankautomaten",
    "ＢＡＮＫＯＭＡＴ 00092293",
  ])(
    "recognizes %s without identifying an operator from numbers",
    (description) => {
      const row = { description };
      expect(isAtmBooking(row)).toBe(true);
      expect(atmLogoBank(row)).toMatchObject({
        name: "Raiffeisen",
        explicit: false,
      });
    },
  );

  it("recognizes self-service and foreign withdrawals, but lends the domestic artwork only to Austrian machines", () => {
    expect(atmLogoBank({ description: "SB-BEHEBUNG 00092293" })).toMatchObject({ name: "Raiffeisen", explicit: false });
    for (const description of ["Bargeldbehebung Flughafen Terminal 1", "ATM S1234 GRAZ 8010", "XYZ ATM563 HAFEN 12345", "Cash withdrawal LONDON"]) {
      expect(isAtmBooking({ description })).toBe(true);
      expect(atmLogoBank({ description })).toBeNull();
    }
    expect(isAtmBooking({ description: "ATMOSPHERE BAR WIEN" })).toBe(false);
    expect(isAtmBooking({ description: "Pro-Cashback" })).toBe(false);
  });

  it("uses historic descriptions and details without consulting the account's bank or stored merchant", () => {
    const row = transactionSchema.parse({
      id: "historic",
      date: "2026-10-01",
      bank: "Revolut",
      pocket: null,
      description: "Bargeld",
      rawDescription: "Kartenfolge 0001",
      rawDetails: ["Verwendungszweck: BANKOMAT 00092293", "Filiale: 1234"],
      merchantAlias: "Revolut",
      merchantId: "revolut",
      merchantNameConfirmed: true,
      amount: -100,
      category: "Transfer",
      includeInPlan: false,
    });
    const before = structuredClone(row);
    expect(atmLogoBank(row)).toMatchObject({
      name: "Raiffeisen",
      explicit: false,
    });
    expect(shouldShowMerchantMark(row, classify(row))).toBe(true);
    expect(row).toEqual(before);
    expect(
      atmLogoBank({ ...row, rawDescription: "BANKOMAT 92293 Volksbank" }),
    ).toMatchObject({ name: "Volksbank", explicit: true });
  });

  it.each([
    { description: "BANKOMAT/POS Verwendungszweck: BILLA" },
    { description: "BANKOMAT / POS Verwendungszweck: BILLA" },
    { description: "bankomat\t/\tpos Verwendungszweck: BILLA" },
    { description: "ＢＡＮＫＯＭＡＴ／ＰＯＳ Verwendungszweck: BILLA" },
    {
      description: "BILLA",
      rawDescription: "BANKOMAT/POS Verwendungszweck: BILLA",
    },
    {
      description: "BILLA",
      rawDetails: ["Buchungsart: BANKOMAT / POS", "Verwendungszweck: BILLA"],
    },
  ])(
    "does not mistake generic card-terminal metadata for an ATM: %j",
    (row) => {
      expect(isAtmBooking(row)).toBe(false);
      expect(atmLogoBank(row)).toBeNull();
    },
  );

  it("still recognizes separate withdrawal evidence alongside generic terminal metadata", () => {
    const row = {
      description: "BANKOMAT 00092293 Kartenfolge",
      rawDetails: ["Buchungstyp: BANKOMAT / POS"],
    };
    expect(isAtmBooking(row)).toBe(true);
    expect(atmLogoBank(row)).toMatchObject({
      name: "Raiffeisen",
      explicit: false,
    });
  });

  it("matches explicit other banks by exact name/alias and prefers them to Raiffeisen mentions", () => {
    const banks = [
      { name: "BAWAG", aliases: ["BAWAG P.S.K.", "BAWAG PSK"] },
      { name: "Bank Austria", aliases: ["UniCredit Bank Austria"] },
    ];
    expect(
      atmLogoBank(
        { description: "Raiffeisen BANKOMAT BAWAG P.S.K. 123" },
        banks,
      ),
    ).toMatchObject({ name: "BAWAG", explicit: true });
    expect(
      atmLogoBank(
        { description: "BANKOMAT BAWAG00092293 Kartenfolge 1" },
        banks,
      ),
    ).toMatchObject({ name: "BAWAG", explicit: true });
    expect(
      atmLogoBank(
        { description: "BANKOMAT UniCredit Bank Austria 123" },
        banks,
      ),
    ).toMatchObject({ name: "Bank Austria", explicit: true });
    expect(
      atmLogoBank({ description: "BANKOMAT BAWAG und Bank Austria" }, banks),
    ).toBeNull();
  });

  it.each(["Unknown Bank", "Unlistedbank", "Sparkasse und Volksbank"])(
    "does not give an unavailable or ambiguous explicit bank Raiffeisen artwork: %s",
    (bank) => {
      expect(
        atmLogoBank({ description: `BANKOMAT 00092293 ${bank}` }),
      ).toBeNull();
    },
  );

  it.each([
    "BANKOMAT 00092293 Betreiber: Unbekannter Dienst",
    "Bankautomat Operator: Unknown Cash Services",
    "Bankautomat Bank: Unlisted Institution",
  ])(
    "fails closed for an explicitly labelled unknown operator: %s",
    (description) => {
      expect(isAtmBooking({ description })).toBe(true);
      expect(atmLogoBank({ description })).toBeNull();
    },
  );

  it("uses an explicitly labelled known bank rather than treating its field label as another bank", () => {
    expect(
      atmLogoBank({ description: "Bankautomat Bank: Sparkasse" }),
    ).toMatchObject({ name: "Sparkasse", explicit: true });
    expect(
      atmLogoBank({ description: "BANKOMAT Betreiber: BAWAG 00092293" }, [
        { name: "BAWAG" },
      ]),
    ).toMatchObject({ name: "BAWAG", explicit: true });
  });

  it.each(["Revolut", "Santander", "HSBC", "N26"])(
    "recognizes explicitly named %s even when no artwork is known",
    (name) => {
      expect(
        atmLogoBank({ description: `Bankautomat 00092293 ${name}` }),
      ).toMatchObject({ name, explicit: true });
    },
  );

  it("supports precise long supplied bank names without public merchant validation", () => {
    const name = "The Very Long Community Bank";
    expect(
      atmLogoBank(
        { description: `BANKOMAT 00092293 ${name} Kartenfolge 001` },
        [{ name }],
      ),
    ).toMatchObject({ name, explicit: true });
    expect(
      atmLogoBank({ description: "Bankautomat Deutsche B4nk" }, [
        { name: "Deutsche Bank" },
      ]),
    ).not.toMatchObject({ name: "Deutsche Bank" });
  });

  it.each([
    { description: "SEPA Überweisung an Raiffeisen" },
    { description: "Bankomatgebühr" },
    { description: "Bankautomatiker" },
    { description: "XBANKOMAT 92293" },
    { description: `BANKOMAT ${"x".repeat(10_000)}` },
    { description: "Bargeld", rawDetails: Array(23).fill("BANKOMAT") },
  ])("fails closed for non-ATM and oversized text: %j", (row) => {
    expect(isAtmBooking(row)).toBe(false);
    expect(atmLogoBank(row)).toBeNull();
  });

  it("leaves ordinary transfer suppression intact even with a supplied mark", () => {
    const row = transactionSchema.parse({
      id: "transfer",
      date: "2026-10-01",
      bank: "Revolut",
      pocket: null,
      description: "SEPA Überweisung an BAWAG",
      amount: -100,
      category: "Transfer",
      includeInPlan: true,
    });
    expect(shouldShowMerchantMark(row, classify(row), true)).toBe(false);
  });
});
