import { describe, expect, it } from "vitest";
import { actualBookings } from "@/lib/calc";
import { createEmptyAccountState } from "@/lib/account-state";
import type { Transaction } from "@/lib/types";
import { cleanBookingText, stripBankMetadata } from "./bank-description";
import {
  bookingDescription,
  merchantCandidates,
  recoverMerchant,
} from "./merchant-description";
import { statementFingerprint } from "./identity";
import { parseStatementCsv } from "./statements";
import { merchantRuleKey } from "./merchant-rules";

const metadata =
  "IBAN Auftraggeber: AT001234567890123456 BIC Auftraggeber: TESTAT00XXX";
const booking = (patch: Partial<Transaction> = {}): Transaction => ({
  id: "test-booking",
  date: "2026-10-12",
  description: `Testfirma ${metadata}`,
  bank: "Raiffeisen",
  pocket: null,
  amount: 120,
  category: "Einkommen",
  categoryOverride: true,
  manualCategory: true,
  includeInPlan: false,
  ...patch,
});

describe("meaningful booking descriptions", () => {
  it.each([
    [`Testfirma ${metadata}`, "Testfirma"],
    [
      `${metadata} Verwendungszweck: Rechnung 2026-10 / 120,00 EUR`,
      "Rechnung 2026-10 / 120,00 EUR",
    ],
    [
      "Empfänger: Testladen IBAN Empfänger: AT00 1234 5678 9012 3456 BIC Empfänger: TESTAT00 Verwendungszweck: Bestellung 123",
      "Testladen Bestellung 123",
    ],
    [
      "Verwendungszweck/Text: Miete Oktober IBAN: DE00123456789012345678 BIC: TESTDE00XXX",
      "Miete Oktober",
    ],
    [
      "Testladen | Mandatsreferenz: PRIVATE-123 | Gläubiger-ID: PRIVATE-456",
      "Testladen",
    ],
    ["Testladen AT001234567890123456", "Testladen"],
    ["Gehalt 10/2026, 120,00 EUR", "Gehalt 10/2026, 120,00 EUR"],
    ["IBAN-Unterstützung im Bankkurs", "IBAN-Unterstützung im Bankkurs"],
    [metadata, ""],
  ])("shows only useful text from %s", (source, expected) => {
    expect(cleanBookingText(source)).toBe(expected);
  });

  it("keeps purpose fields available for merchant recovery and excludes bank details", () => {
    const source = `Verwendungszweck: BILLA ${metadata} Zahlungsreferenz: Beleg 123`;
    expect(stripBankMetadata(source)).toBe(
      "Verwendungszweck: BILLA Zahlungsreferenz: Beleg 123",
    );
    expect(merchantCandidates({ description: source })).toEqual(["BILLA"]);
    expect(recoverMerchant({ description: source }).description).toBe("BILLA");
    expect(
      recoverMerchant({
        description: metadata,
        rawDetails: ["Verwendungszweck: Gehalt Oktober"],
      }).description,
    ).toBe("Gehalt Oktober");
  });

  it("preserves raw source, identity, amounts, manual categories and locks", () => {
    const original = booking({
      is_locked: true,
      merchantNameConfirmed: true,
      rawDetails: ["Originaldetails"],
    });
    const recovered = recoverMerchant(original);
    expect(recovered).toEqual({
      ...original,
      description: "Testfirma",
      rawDescription: original.description,
    });
    expect(statementFingerprint(recovered)).toBe(
      statementFingerprint(original),
    );
    expect(merchantRuleKey(recovered)).toBe(merchantRuleKey(original));
    expect(original.rawDescription).toBeUndefined();
    expect(recoverMerchant(recovered)).toBe(recovered);
  });

  it("cleans historical ledger rows and fixed receipts without changing the stored state", () => {
    const state = createEmptyAccountState();
    state.transactions = [booking({ is_locked: true })];
    state.fixedReceipts = [
      {
        key: "fixed-receipt",
        date: "2026-10-11",
        amount: -80,
        category: "Telefon & Internet",
        booking: booking({ id: "receipt-source", amount: -80 }),
      },
    ];
    const before = structuredClone(state);
    const rows = actualBookings(state);
    expect(rows).toHaveLength(2);
    expect(rows.map(bookingDescription)).toEqual(["Testfirma", "Testfirma"]);
    expect(rows[0].rawDescription).toBe(before.transactions[0].description);
    expect(state).toEqual(before);
  });

  it("keeps aliases meaningful and reports missing purpose without inventing a merchant", () => {
    expect(
      bookingDescription(booking({ merchantAlias: `Mein Name ${metadata}` })),
    ).toBe("Mein Name");
    expect(bookingDescription({ description: metadata })).toBe(
      "Verwendungszweck fehlt",
    );
    expect(merchantCandidates({ description: metadata })).toEqual([]);
  });

  it("cleans future CSV imports while preserving the original bank text for deduplication", () => {
    const result = parseStatementCsv(
      `Raiffeisen\nBuchungsdatum;Buchungstext;Betrag\n12.10.2026;Testfirma ${metadata};120,00`,
    );
    expect(result.rows[0]).toMatchObject({
      description: "Testfirma",
      rawDescription: `Testfirma ${metadata}`,
      amount: 120,
    });
    expect(result.issues).toEqual([]);
  });
});
