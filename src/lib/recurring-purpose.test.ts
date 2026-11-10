import { describe, expect, it } from "vitest";
import { accountHolidayRanges, actualBookings, classify } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import type { AppState, Transaction } from "@/lib/types";
import { recurringLunchCategory, revolutLunchMerchant } from "./recurring-purpose";

let counter = 0;
const booking = (description: string, extra: Partial<Transaction> = {}): Transaction => ({
  id: `lunch-${++counter}`, date: "2026-09-14", time: "12:15:00", bank: "Revolut", pocket: "Persönliches Konto",
  description, amount: -23.4, category: "Prüfen", includeInPlan: true, ...extra,
});
const category = (description: string, extra: Partial<Transaction> = {}) => classify(booking(description, extra)).category;

describe("Revolut lunch rule", () => {
  it.each(["Mensa", "Wiener Reuther", "BIPA", "BILLA", "SPAR", "INTERSPAR", "EUROSPAR 2361", "Billa Dankt"])("files %s as Mittagessen at lunch time without an amount limit", (description) => {
    expect(category(description)).toBe("Mittagessen");
    expect(category(description, { amount: -84.9 })).toBe("Mittagessen");
  });

  it.each([["10:59:00", false], ["10:59:59", false], ["11:00:00", true], ["13:30:00", true], ["14:00:00", true], ["14:00:01", false], ["14:01:00", false]] as const)("checks the clock boundary %s", (time, lunch) => {
    expect(category("BILLA", { time })).toBe(lunch ? "Mittagessen" : "Lebensmittel");
    expect(category("Wiener Reuther", { time, category: "Restaurants" })).toBe(lunch ? "Mittagessen" : "Restaurants");
  });

  it.each([["2026-09-12", "Samstag"], ["2026-09-13", "Sonntag"], ["2026-10-26", "Nationalfeiertag"], ["2026-12-08", "Mariä Empfängnis"]])("never applies on %s (%s)", (date) => {
    expect(category("BILLA", { date })).toBe("Lebensmittel");
    expect(category("SPAR", { date, amount: -6 })).toBe("Lebensmittel");
  });

  it("needs a known clock time", () => {
    expect(category("BILLA", { time: undefined })).toBe("Lebensmittel");
    expect(category("SPAR", { time: undefined, rawDescription: "SPAR 2026-09-14 12:10:00" })).toBe("Mittagessen");
  });

  it("leaves other banks with the 10 € limit", () => {
    for (const bank of ["Raiffeisen", "Amex", "Trade Republic"]) {
      expect(category("BILLA", { bank })).toBe("Lebensmittel");
      expect(category("BILLA", { bank, amount: -9.5 })).toBe("Mittagessen");
      expect(category("Wiener Reuther", { bank, category: "Restaurants" })).toBe("Restaurants");
    }
  });

  it("keeps manual and learned categories but replaces automatic ones", () => {
    expect(category("BILLA", { category: "Wohnen & Haushalt", manualCategory: true, categoryOverride: true })).toBe("Wohnen & Haushalt");
    expect(category("BILLA", { category: "Lebensmittel", categoryOverride: true })).toBe("Lebensmittel");
    expect(category("BILLA", { category: "Lebensmittel", categoryOverride: true, reviewed: true,
      automaticCategoryEvidence: { method: "merchant", category: "Lebensmittel" } })).toBe("Lebensmittel");
    expect(category("BILLA", { category: "Lebensmittel", categoryOverride: true,
      automaticCategoryEvidence: { method: "merchant", category: "Lebensmittel" } })).toBe("Mittagessen");
  });

  it("does not turn refunds, savings or transfers into lunch", () => {
    expect(category("BILLA", { amount: 12 })).not.toBe("Mittagessen");
    expect(category("To Sparen")).not.toBe("Mittagessen");
    expect(revolutLunchMerchant("Revolut", "Sparkonto")).toBe(false);
    expect(revolutLunchMerchant("Revolut", "Hotspot")).toBe(false);
    expect(revolutLunchMerchant("Raiffeisen", "BILLA")).toBe(false);
    expect(revolutLunchMerchant(" revolut ", undefined, "Wiener Reuther")).toBe(true);
  });
});

describe("vacation ranges", () => {
  const stateWith = (transactions: Transaction[]): AppState => ({
    ...createSeed(), transactions, holidayRanges: [{ from: "2026-09-14", to: "2026-09-18" }],
    settings: { ...createSeed().settings, asOf: "2026-09-30" },
  });
  const categories = (state: AppState) => Object.fromEntries(actualBookings(state).map((row) => [row.id, classify(row).category]));

  it("assigns no lunch automatically inside a stored vacation", () => {
    const rows = [
      booking("BILLA", { id: "billa-vacation" }),
      booking("Mensa", { id: "mensa-vacation", time: undefined, bank: "Raiffeisen" }),
      booking("BIPA", { id: "bipa-vacation", date: "2026-09-15", time: undefined, bank: "Raiffeisen" }),
      booking("SPAR", { id: "spar-small-vacation", bank: "Raiffeisen", amount: -6 }),
      booking("BILLA", { id: "billa-home", date: "2026-09-21" }),
      booking("Mensa", { id: "mensa-home", date: "2026-09-22", time: undefined }),
      booking("BIPA", { id: "bipa-home", date: "2026-09-23", time: undefined }),
      booking("SPAR", { id: "spar-home", date: "2026-09-24", bank: "Raiffeisen", amount: -6 }),
    ];
    expect(categories(stateWith(rows))).toEqual({
      "billa-vacation": "Lebensmittel", "mensa-vacation": "Restaurants", "bipa-vacation": "Drogerie", "spar-small-vacation": "Lebensmittel",
      "billa-home": "Mittagessen", "mensa-home": "Mittagessen", "bipa-home": "Mittagessen", "spar-home": "Mittagessen",
    });
  });

  it("keeps a manual lunch and books unfamiliar places as vacation", () => {
    const rows = [
      booking("BILLA", { id: "manual", category: "Mittagessen", manualCategory: true, categoryOverride: true }),
      booking("Wiener Reuther", { id: "away", category: "Restaurants" }),
    ];
    expect(categories(stateWith(rows))).toEqual({ manual: "Mittagessen", away: "Urlaub" });
  });

  it("marks only would-be lunch bookings and drops stale markers", () => {
    const rows = [booking("BILLA", { id: "lunch" }), booking("BILLA", { id: "evening", time: "19:00:00" })];
    const accounted = accountHolidayRanges(rows, [{ from: "2026-09-14", to: "2026-09-14" }]);
    expect(accounted.map((row) => "vacationDay" in row)).toEqual([true, false]);
    expect(accountHolidayRanges(accounted, []).some((row) => "vacationDay" in row)).toBe(false);
  });

  it("drops the fixed Mensa/BIPA lunch on vacation days", () => {
    expect(recurringLunchCategory("Mensa", "2026-09-14", -5)).toBe("Mittagessen");
    expect(recurringLunchCategory("Mensa", "2026-09-14", -5, true)).toBe("Restaurants");
    expect(recurringLunchCategory("BIPA 123", "2026-09-14", -5, true)).toBe("Drogerie");
  });
});
