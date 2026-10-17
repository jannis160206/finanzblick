import { describe, expect, it } from "vitest";
import { parseMoneyText } from "./money-parse";

describe("parseMoneyText", () => {
  it.each([
    ["1.500", 1500],
    ["1.500,5", 1500.5],
    ["1.500,50", 1500.5],
    ["1,5", 1.5],
    ["1.5", 1.5],
    ["1.50", 1.5],
    ["1500", 1500],
    ["12.345.678", 12345678],
    ["  € 2.000,00 ", 2000],
    ["(12,00)", -12],
    ["12,00-", -12],
    ["−3,20", -3.2],
    ["+7", 7],
    ["0", 0],
  ])("reads %s as %s", (text, value) => {
    expect(parseMoneyText(text)).toBe(value);
  });

  it.each(["", "abc", "1,234", "1,5,5", "1..5", "1.5000", "12.34.56", "1e3", "--5", "1.500,", "2000000000"])(
    "rejects %s instead of guessing",
    (text) => {
      expect(parseMoneyText(text)).toBeNull();
    },
  );

  it("rounds numbers to cents and rejects non-finite numbers", () => {
    expect(parseMoneyText(1.005)).toBe(1.01);
    expect(parseMoneyText(Number.NaN)).toBeNull();
    expect(parseMoneyText(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
