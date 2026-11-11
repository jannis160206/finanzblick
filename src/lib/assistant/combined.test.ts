import { describe, expect, it } from "vitest";
import { splitQuestion } from "./combined";

describe("combined questions", () => {
  it("splits two independent questions and gives each its own tool", () => {
    expect(splitQuestion("Wie viel hab ich im Oktober für Essen ausgegeben und was bleibt mir diesen Monat?")).toEqual([
      { text: "Wie viel hab ich im Oktober für Essen ausgegeben", tool: "query" }, { text: "was bleibt mir diesen Monat?", tool: "budget" }]);
    expect(splitQuestion("Wie viel netto bekomme ich und wann kommt das Gehalt?")?.map((part) => part.tool)).toEqual(["payroll", "pulse"]);
    expect(splitQuestion("Wie viel hab ich bei Billa und bei Spar ausgegeben?")?.map((part) => part.text)).toEqual([
      "Wie viel hab ich bei Billa ausgegeben?", "Wie viel hab ich bei Spar ausgegeben?"]);
    expect(splitQuestion("Zeig mir meine Kontostände und meine Sparziele")?.map((part) => part.text)).toEqual(["Zeig mir meine Kontostände", "Zeig mir meine Sparziele"]);
    expect(splitQuestion("Welche Abos habe ich? Wie viel kann ich heute noch ausgeben?")?.map((part) => part.tool)).toEqual(["contracts", "pulse"]);
    // "es" stands for "mein Gehalt", so the second part can stand alone.
    expect(splitQuestion("Wie hoch ist mein Gehalt und wann kommt es?")).toEqual([
      { text: "Wie hoch ist mein Gehalt", tool: "payroll" }, { text: "wann kommt mein Gehalt?", tool: "pulse" }]);
    // Advice is answered in words, not by a calculator that asks for amounts.
    expect(splitQuestion("Was ist ein ETF und soll ich in einen investieren?")).toEqual([
      { text: "Was ist ein ETF", tool: "knowledge" }, { text: "soll ich in einen investieren?", tool: undefined }]);
  });

  it("keeps one question whole when the second part refers back, changes data or is just a thank-you", () => {
    expect(splitQuestion("Welche Abos habe ich und was kosten sie im Jahr?")).toBeUndefined();
    expect(splitQuestion("Kann ich mir einen Fernseher um 800 € leisten und wie wirkt sich das aufs Motorrad aus?")).toBeUndefined();
    expect(splitQuestion("Erhöhe Japan auf 4000 und was bleibt mir dann?", ["Japan"])).toBeUndefined();
    expect(splitQuestion("Danke! Und was ist eigentlich ein ETF?")).toBeUndefined();
    expect(splitQuestion("Was ist der Unterschied zwischen Brutto und Netto?")).toBeUndefined();
    expect(splitQuestion("Wie viel hab ich im Oktober ausgegeben?")).toBeUndefined();
  });
});
