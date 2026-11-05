import { describe, expect, it } from "vitest";
import { groundModelExtraction, mergeDraft, missingQuestion, parseAmount, parseAssistantMessage } from "./intent";

const asOf = "2026-10-07";
const draftFor = (text: string, pending?: Parameters<typeof mergeDraft>[0]) =>
  mergeDraft(pending, parseAssistantMessage(text, asOf), {}, text, asOf);

describe("assistant intent parser", () => {
  it("reads German amounts", () => {
    expect(parseAmount("3.000")).toBe(3000);
    expect(parseAmount("1.234,56")).toBe(1234.56);
    expect(parseAmount("12,5")).toBe(12.5);
  });

  it("understands a savings goal with start capital", () => {
    const draft = draftFor("Ich will bis Juli 2027 3.000 € für Japan sparen, 500 € liegen schon am Sparkonto.");
    expect(draft).toEqual({ action: "savings_goal", name: "Japan", amount: 3000, date: "2027-07-31", startCapital: 500, fromAccount: "Sparkonto" });
    expect(missingQuestion(draft!)).toBeUndefined();
  });

  it("understands a monthly amount instead of a date", () => {
    expect(draftFor("Ich möchte 2.400 € für ein Motorboot sparen und kann 200 € im Monat zurücklegen.")).toEqual(
      { action: "savings_goal", name: "Motorboot", amount: 2400, monthly: 200 });
  });

  it("understands instalments and one-off expenses", () => {
    expect(draftFor("Laptop 1.200 € in 6 Raten ab Jänner")).toMatchObject({ action: "expense", name: "Laptop", amount: 1200, installments: 6, date: "2027-01-01" });
    expect(draftFor("Im März kommt das Pickerl, ca. 400 €")).toEqual({ action: "expense", name: "Pickerl", amount: 400, date: "2027-03-01" });
    expect(draftFor("Kann ich mir im Mai einen Fernseher um 900 € leisten?")).toMatchObject({ action: "affordability", amount: 900, date: "2027-05-01" });
  });

  it("asks for missing values and merges follow-up answers", () => {
    const first = draftFor("Ich will für ein Auto sparen");
    expect(first).toEqual({ action: "savings_goal", name: "Auto" });
    expect(missingQuestion(first!)).toContain("insgesamt");
    const second = draftFor("8.000 €", first);
    expect(second).toEqual({ action: "savings_goal", name: "Auto", amount: 8000 });
    const third = draftFor("300", second);
    expect(third).toEqual({ action: "savings_goal", name: "Auto", amount: 8000, monthly: 300 });
    expect(missingQuestion(third!)).toBeUndefined();
  });

  it("flags what-if questions and shared costs", () => {
    expect(draftFor("Was wäre, wenn ich im April 600 € für Möbel mit Raphael ausgebe? Geht sich das aus?"))
      .toMatchObject({ action: "affordability", amount: 600, shared: true, whatIf: true });
  });

  it("drops model values that are not written in the message", () => {
    const text = "Ich will 3.000 € für Japan sparen, 500 € habe ich schon";
    const parsed = parseAssistantMessage(text, asOf);
    expect(groundModelExtraction({ action: "savings_goal", name: "Japanreise Tokio", amount: 3500, startCapital: 500, monthly: 278, shared: true }, parsed, text))
      .toEqual({ action: "savings_goal", startCapital: 500 });
  });
});
