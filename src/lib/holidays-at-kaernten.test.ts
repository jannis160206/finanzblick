import { describe, expect, it } from "vitest";
import { austrianHolidays, easterSunday, isLunchTime, isWorkingDay, statementTime } from "./holidays-at-kaernten";
import { classify } from "./calc";
import type { Transaction } from "./types";

const booking = (date: string, time?: string, description = "Mensa"): Transaction => ({
  id: "lunch", bank: "Raiffeisen", pocket: "Raiffeisen Giro", date, time,
  description, amount: -8, category: "Prüfen", includeInPlan: true,
});

describe("Austrian and Kärnten calendar", () => {
  it.each([[2026, "2026-04-05"], [2027, "2027-03-28"]] as const)("computes Easter in %s", (year, date) => expect(easterSunday(year)).toBe(date));
  it.each([
    [2026, "2026-04-06", "2026-05-14", "2026-05-25", "2026-06-04"],
    [2027, "2027-03-29", "2027-05-06", "2027-05-17", "2027-05-27"],
  ] as const)("includes all Easter-moving holidays in %s", (year, ...dates) => {
    for (const date of dates) { expect(austrianHolidays(year).has(String(date))).toBe(true); expect(isWorkingDay(String(date))).toBe(false); }
  });
  it.each([2026, 2027])("includes the fixed holidays and Kärnten October 10 in %s", (year) => {
    for (const suffix of ["01-01", "01-06", "05-01", "08-15", "10-10", "10-26", "11-01", "12-08", "12-25", "12-26"])
      expect(austrianHolidays(year).has(`${year}-${suffix}`)).toBe(true);
  });
  it.each(["2026-04-06", "2026-10-10", "2026-10-26", "2027-03-29", "2027-10-26", "2026-09-12", "2026-09-13"])("never forces lunch on %s", (date) => {
    expect(isLunchTime(date, "12:00:00")).toBe(false);
    expect(classify({ ...booking(date, "12:00:00"), category: "Mittagessen", categoryOverride: true }).category).not.toBe("Mittagessen");
  });
  it.each([["10:59:59", false], ["11:00:00", true], ["12:30:00", true], ["14:00:00", true], ["14:00:01", false], ["18:00:00", false], [undefined, false]] as const)("checks the exact clock boundary %s", (time, eligible) => {
    expect(isLunchTime("2026-09-14", time)).toBe(eligible);
    expect(classify(booking("2026-09-14", time)).category === "Mittagessen").toBe(eligible);
  });
  it("requires both a valid clock and a lunch merchant", () => {
    expect(classify(booking("2026-09-14", "12:00:00", "Other merchant")).category).toBe("Prüfen");
    expect(classify(booking("2026-09-14", undefined, "SPAR")).category).toBe("Lebensmittel");
    expect(isWorkingDay("2026-02-30")).toBe(false);
  });
  it("parses clocks without fabricating time from a date or identifier", () => {
    expect(statementTime("14.09.2026 12:03:04:123")).toBe("12:03:04");
    expect(statementTime("2026-09-14 13:15:00")).toBe("13:15:00");
    expect(statementTime("12:15 PM")).toBe("12:15:00");
    expect(statementTime("2026-09-14")).toBeUndefined();
    expect(statementTime("25:15:00")).toBeUndefined();
  });
});
