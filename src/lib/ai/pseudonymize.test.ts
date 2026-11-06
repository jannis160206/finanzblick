import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import type { AppState, Transaction } from "@/lib/types";
import { createPseudonymizer, findPersonNames, maskToolResult, merchantNames, personNamesFrom } from "./pseudonymize";

const booking = (id: string, description: string, amount: number, extra: Partial<Transaction> = {}): Transaction =>
  ({ id, date: "2026-10-01", bank: "Raiffeisen", pocket: "Raiffeisen Giro", description, amount, category: "Sonstiges", includeInPlan: true, ...extra });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.transactions = [
    booking("t1", "To Maxima Musterfrau", -50),
    booking("t2", "Überweisung von MUSTERMANN", 20),
    booking("t3", "Auftraggeber: Erika Beispiel IBAN Auftraggeber: AT611904300234573201", 100),
    booking("t4", "BILLA DANKT 1234", -23.4, { merchantAlias: "Billa", category: "Lebensmittel" }),
    booking("t5", "To EUR Urlaub", -100),
    booking("t6", "Kartenzahlung Hofer", -12, { pocket: "Amex Quirin", bank: "Amex" }),
  ];
  return state;
}

describe("person detection", () => {
  it("finds counterparties of private transfers but not banks, currencies or pockets", () => {
    expect(findPersonNames("To Maxima Musterfrau")).toEqual(["Maxima Musterfrau"]);
    expect(findPersonNames("Überweisung an Erika Beispiel Miete")).toEqual(["Erika Beispiel"]);
    expect(findPersonNames("To EUR Urlaub")).toEqual([]);
    expect(findPersonNames("Überweisung von Raiffeisen Bank")).toEqual([]);
    expect(findPersonNames("IBAN Auftraggeber: AT611904300234573201")).toEqual([]);
    expect(findPersonNames("Empfänger: Musterstrasse 15")).toEqual([]);
  });

  it("collects names from the data including secondary card holders", () => {
    const names = personNamesFrom(fixture(), ["Extra Name"]);
    expect(names).toEqual(expect.arrayContaining(["Maxima Musterfrau", "MUSTERMANN", "Erika Beispiel", "Quirin", "Extra Name"]));
    expect(names).not.toContain("Billa");
    expect(merchantNames(fixture()).has("billa")).toBe(true);
  });
});

describe("pseudonymizer", () => {
  it("masks IBANs, e-mails, phones, cards and people deterministically", () => {
    const privacy = createPseudonymizer(["Maxima Musterfrau"]);
    const text = "To Maxima Musterfrau IBAN AT61 1904 3002 3457 3201 mail maxima@example.at Tel +43 664 1234567 Karte **4242";
    const masked = privacy.maskText(text);
    expect(masked).toBe("To Person-1 IBAN IBAN-1 mail email-1 Tel Telefon-1 Karte Karte-1");
    expect(privacy.maskText("AT611904300234573201 und maxima musterfrau")).toBe("IBAN-1 und Person-1");
    expect(privacy.maskText("Maxima hat bezahlt")).toBe("Person-1 hat bezahlt");
  });

  it("keeps merchants readable and ids untouched", () => {
    const privacy = createPseudonymizer(personNamesFrom(fixture()), merchantNames(fixture()));
    const masked = privacy.mask({ rows: [
      { id: "123456789012", merchant: "Billa", description: "BILLA DANKT 1234", amount: -23.4 },
      { id: "t1", merchant: "Maxima Musterfrau", description: "To Maxima Musterfrau", amount: -50 },
    ] });
    expect(masked.rows[0]).toEqual({ id: "123456789012", merchant: "Billa", description: "BILLA DANKT 1234", amount: -23.4 });
    expect(masked.rows[1].merchant).toMatch(/^Person-\d+$/);
    expect(masked.rows[1].description).toMatch(/^To Person-\d+$/);
  });

  it("learns people seen for the first time and reveals tokens in arguments", () => {
    const privacy = createPseudonymizer();
    const masked = privacy.maskText("Zahlung an Hans Huber, IBAN DE89370400440532013000");
    expect(masked).toBe("Zahlung an Person-1, IBAN IBAN-1");
    expect(privacy.reveal({ query: "Person-1", transactionId: "Person-1", nested: ["IBAN-1", "Person-9"] }))
      .toEqual({ query: "Hans Huber", transactionId: "Person-1", nested: ["DE89370400440532013000", "Person-9"] });
  });

  it("masks JSON and plain text tool results", () => {
    const privacy = createPseudonymizer(["Erika Beispiel"]);
    const json = maskToolResult({ content: [{ type: "text" as const, text: JSON.stringify({ total: 1, rows: [{ description: "Erika Beispiel", amount: 5 }] }) }] }, privacy);
    expect(JSON.parse(json.content[0].text)).toEqual({ total: 1, rows: [{ description: "Person-1", amount: 5 }] });
    const plain = maskToolResult({ content: [{ type: "text" as const, text: "Fehler bei Erika Beispiel" }], isError: true }, privacy);
    expect(plain).toEqual({ content: [{ type: "text", text: "Fehler bei Person-1" }], isError: true });
  });
});
