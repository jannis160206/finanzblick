import { describe, expect, it } from "vitest";
import { bankOperation } from "./bank-operation";
import { classify } from "./calc";
import { isMerchantTransfer } from "./merchant-transfer";
import { isNamedTransfer } from "./transfers";
import {
  MerchantIndex,
  normalizeMerchantDescriptor,
  seedMerchants,
} from "./automation/merchants";
import { enrichTransaction } from "./automation/pipeline";
import { createAccountMerchantResolver } from "./automation/aliases";
import { merchantRuleKey } from "./import/merchant-rules";
import { createSeed } from "./seed";
import { type Transaction } from "./types";
import { prepareStatementImport } from "./import/review";

const booking = (
  description: string,
  patch: Partial<Transaction> = {},
): Transaction => ({
  id: description,
  description,
  amount: -30,
  category: "Prüfen",
  date: "2026-10-09",
  bank: "Raiffeisen",
  pocket: null,
  includeInPlan: true,
  ...patch,
});
const index = new MerchantIndex(seedMerchants);

describe("explicit bank operations", () => {
  it.each([
    "KONTOFÜHRUNG 01.07.2026 - 30.09.2026",
    "Kontofuehrung",
    "Kontoführungsentgelt",
    "Entgelt für die Kontoführung",
    "Kontospesen",
    "Bankspesen",
    "Kartengebühr",
    "Buchungsentgelt",
    "Überweisungsgebühr",
    "Transfergebühr",
    "Gebühr für SEPA Überweisung",
    "Account maintenance fee",
    "Monthly account fee",
    "Annual card fee",
    "Transfer fee",
    "AMEX Monatsgebühr",
    "PayPal Transaktionsgebühr",
    "PP*Gebühren",
    "PayPal*Transaktionsgebuehr",
    "Bankomatgebühr",
    "Bargeldbehebungsentgelt",
    "Gebühr für die Bargeldabhebung",
    "ATM fee",
    "Erste Bank Kontoführungsgebühr",
    "BAWAG Kontoführungsgebühr",
    "bank99 Kontoführungsgebühr",
    "Bank Austria Bankgebühr",
    "Oberbank Kontospesen",
    "BKS Bank Kartengebühr",
    "DADAT Bank Buchungsentgelt",
    "DenizBank Österreich Kontoführung",
    "Santander Consumer Bank Überweisungsgebühr",
  ])("assigns only the existing fee category for %s", (description) => {
    const row = booking(description);
    expect(bankOperation(row)).toEqual({
      kind: "fee",
      category: "Bankgebühren",
    });
    expect(isNamedTransfer(row)).toBe(false);
    const enriched = enrichTransaction(row, index);
    expect(enriched).toMatchObject({
      category: "Bankgebühren",
      categoryOverride: true,
      requires_manual_review: false,
      merchantLogo: false,
    });
    expect(enriched.merchantId).toBeUndefined();
    expect(classify(enriched)).toMatchObject({
      category: "Bankgebühren",
      isTransfer: false,
    });
    expect(enrichTransaction(enriched, index)).toEqual(enriched);
    expect(enriched.description).toBe(row.description);
  });

  it("uses the known card issuer for its explicit membership fee, not an unrelated subscription", () => {
    expect(
      enrichTransaction(booking("Monatsgebühr", { bank: "Amex" }), index),
    ).toMatchObject({
      category: "Bankgebühren",
      requires_manual_review: false,
    });
    expect(
      enrichTransaction(booking("Monatsgebühr", { bank: "Revolut" }), index)
        .requires_manual_review,
    ).toBe(true);
    expect(
      enrichTransaction(
        booking("Monatsgebühr", {
          bank: "Amex",
          rawDetails: ["Merchant Name: Netflix"],
        }),
        index,
      ).requires_manual_review,
    ).toBe(true);
    expect(
      enrichTransaction(booking("Bargeldbehebung"), index)
        .requires_manual_review,
    ).toBe(true);
  });

  it.each([
    "Rücklastschriftgebühr",
    "Ruecklastschriftkosten",
    "Entgelt wegen einer Rücklastschrift",
  ])("keeps returned-debit fees separate for %s", (description) => {
    expect(enrichTransaction(booking(description), index)).toMatchObject({
      category: "Rücklastschriftgebühren",
      requires_manual_review: false,
    });
  });

  it.each([
    "Erstattung Kontoführungsgebühr",
    "Rückvergütung Kontoführungsgebühr",
    "Rueckverguetung Kontofuehrungsgebuehr",
  ])(
    "does not turn an explicit fee refund into income or a transfer: %s",
    (description) => {
      const row = enrichTransaction(booking(description, { amount: 5 }), index);
      expect(row).toMatchObject({
        category: "Rückerstattungen",
        requires_manual_review: false,
      });
      expect(classify(row)).toMatchObject({
        category: "Rückerstattungen",
        isTransfer: false,
        isFixedCost: false,
      });
      expect(isMerchantTransfer(row)).toBe(false);
    },
  );

  it.each([
    "Kontoführung ohne Gebühr",
    "Keine Kontoführungsgebühr",
    "Kontoführung inklusive Gebühr",
    "Überweisung an Alex inklusive Kontoführungsgebühr",
    "BILLA Kontoführungsgebühr",
    "Erste Bank BILLA Kontoführungsgebühr",
    "BAWAG NETFLIX Kartengebühr",
    "bank99 Kontoführung ohne Gebühr",
    "BAWAG Shop GmbH Kontoführungsgebühr",
    "Erste Bannk Kontoführungsgebühr",
  ])("keeps mixed or negated evidence in review: %s", (description) => {
    expect(
      enrichTransaction(booking(description), index).requires_manual_review,
    ).toBe(true);
  });

  it.each([
    "Rücklastschrift",
    "Rücklastschrift 100 EUR inklusive Gebühr 3 EUR",
    "Gebühr",
    "PayPal",
    "PP",
  ])("does not guess a service or merchant from %s", (description) => {
    const result = enrichTransaction(booking(description), index);
    expect(result.requires_manual_review).toBe(true);
    expect(result.merchantId).toBeUndefined();
  });

  it("accepts labelled operation details but not account-wide fee summaries", () => {
    expect(
      enrichTransaction(
        booking("Buchung", {
          rawDetails: ["Verwendungszweck: Kontoführung"],
        }),
        index,
      ),
    ).toMatchObject({
      category: "Bankgebühren",
      requires_manual_review: false,
    });
    expect(
      enrichTransaction(
        booking("Unbekannt", {
          rawDetails: ["Jährliche Übersicht: Kontoführungsgebühr"],
        }),
        index,
      ),
    ).toMatchObject({ category: "Prüfen", requires_manual_review: true });
    expect(
      enrichTransaction(
        booking("Kontoführungsgebühr", {
          rawDetails: ["Merchant Name: BILLA"],
        }),
        index,
      ).requires_manual_review,
    ).toBe(true);
  });

  it.each([
    "Interne Überweisung",
    "Umbuchung zwischen eigenen Konten",
    "Übertrag auf eigenes Konto",
    "Eigenübertrag",
    "PayPal Guthaben aufladen",
    "PP* Guthaben-Aufladung",
    "PayPal Guthabenaufladung 30,00 EUR",
    "PayPal balance top-up",
  ])("recognizes an explicit own-account movement: %s", (description) => {
    const row = enrichTransaction(
      booking(description, {
        merchantId: "at-billa",
        merchantAlias: "BILLA",
        merchantMatch: "alias",
        merchantLogo: true,
      }),
      index,
    );
    expect(row).toMatchObject({
      category: "Transfer intern",
      includeInPlan: false,
      fixedCost: false,
      requires_manual_review: false,
      merchantLogo: false,
    });

    expect(row.merchantId).toBeUndefined();
    expect(classify(row)).toMatchObject({
      isTransfer: true,
      includeInPlan: false,
    });
    expect(isMerchantTransfer(row)).toBe(true);
  });

  it.each([
    "PP*AMAZON Guthabenaufladung",
    "PayPal Guthabenkarte",
    "PP*NETFLIX",
  ])(
    "does not mistake purchases or gift cards for wallet funding: %s",
    (description) => {
      expect(bankOperation(booking(description))?.kind).not.toBe(
        "internal-transfer",
      );
    },
  );

  it.each([
    "SEPA Überweisung an BILLA",
    "Echtzeitüberweisung an Alex",
    "Dauerauftrag Unbekannt",
    "Bank transfer to Amazon",
    "SEPA Credit Transfer to Unknown",
    "Überweisung an BILLA",
  ])("does not hide an external payment as savings: %s", (description) => {
    const row = enrichTransaction(booking(description), index);
    expect(row).toMatchObject({
      category: "Prüfen",
      requires_manual_review: true,
      merchantLogo: false,
    });
    expect(row.merchantId).toBeUndefined();
    expect(classify(row)).toMatchObject({
      category: "Prüfen",
      isTransfer: false,
    });
    expect(isMerchantTransfer(row)).toBe(true);
  });

  it("recognizes the transaction-type field and not an IBAN alone", () => {
    const row = booking("BILLA", {
      rawDetails: ["Transaktionsart: SEPA Überweisung"],
    });
    expect(enrichTransaction(row, index)).toMatchObject({
      category: "Prüfen",
      requires_manual_review: true,
    });
    expect(isMerchantTransfer(row)).toBe(true);
    expect(
      enrichTransaction(booking("BILLA IBAN AT611904300234573201"), index),
    ).toMatchObject({ merchantId: "at-billa", requires_manual_review: false });
  });

  it("keeps locked choices and learns an explicit transfer purpose only for its account", () => {
    const row = booking("SEPA Überweisung an Alex");
    const state = createSeed();
    state.merchantRules = [
      { key: merchantRuleKey(row), category: "Geschenke & Spenden" },
    ];
    expect(
      enrichTransaction(row, index, createAccountMerchantResolver(state)),
    ).toMatchObject({
      category: "Geschenke & Spenden",
      categoryOverride: true,
      requires_manual_review: false,
    });

    expect(enrichTransaction(row, index).requires_manual_review).toBe(true);
    for (const lock of [
      { is_locked: true },
      { manualCategory: true },
      { reviewed: true, categoryOverride: true },
    ]) {
      const locked = booking("Kontoführung", { ...lock, category: "Shopping" });
      expect(enrichTransaction(locked, index)).toEqual({
        ...locked,
        is_locked: true,
      });
    }
  });

  it("does not reuse a learned refund category for a debit transfer", () => {
    const row = booking("SEPA Überweisung an Alex");
    const state = createSeed();
    state.merchantRules = [
      { key: merchantRuleKey(row), category: "Rückerstattungen" },
    ];
    expect(
      enrichTransaction(row, index, createAccountMerchantResolver(state)),
    ).toMatchObject({
      category: "Prüfen",
      requires_manual_review: true,
    });
  });

  it.each([
    ["Vollkasko Dauerauftrag", "Versicherungen"],
    ["Dauerauftrag Miete", "Miete"],
    ["SEPA Überweisung Leasingrate", "Leasing"],
    ["Überweisung an Alex Stromrechnung", "Energie & Nebenkosten"],
    ["Dauerauftrag Mobilfunkrechnung", "Telefon & Internet"],
  ])(
    "uses an explicit payment purpose, not a merchant guess: %s",
    (description, category) => {
      const row = enrichTransaction(booking(description), index);
      expect(row).toMatchObject({
        category,
        categoryOverride: true,
        requires_manual_review: false,
        merchantLogo: false,
      });
      expect(row.merchantId).toBeUndefined();
      expect(classify(row)).toMatchObject({ category, isTransfer: false });
      expect(isMerchantTransfer(row)).toBe(true);
    },
  );

  it("keeps conflicting purposes and unclear OCR amounts open", () => {
    expect(
      enrichTransaction(booking("Dauerauftrag Miete und Vollkasko"), index),
    ).toMatchObject({ category: "Prüfen", requires_manual_review: true });
    expect(
      bankOperation({ description: "Kontoführung", amount: null }),
    ).toEqual({ kind: "ambiguous", category: "Prüfen" });
  });

  it("leaves recognised salary and named own-account transfers on their existing paths", () => {
    const row = booking("SEPA Überweisung von Arbeitgeber Gehalt", {
      amount: 2000,
    });
    expect(enrichTransaction(row, index)).toEqual(row);
    expect(classify(row).category).toBe("Gehalt");
    expect(classify(booking("Überweisung Jannis Brühl")).isTransfer).toBe(true);
  });

  it("routes deterministic one-off fees automatically and external payments into import review", () => {
    const state = {
      ...createSeed(),
      transactions: [],
      financeRows: [],
      reviewQueue: [],
    };
    const fee = enrichTransaction(booking("Rücklastschriftgebühr"), index);
    const payment = enrichTransaction(
      booking("SEPA Überweisung an Alex"),
      index,
    );
    const prepared = prepareStatementImport(
      [
        {
          file: "bank.csv",
          source: "Raiffeisen",
          rows: [fee, payment],
          skipped: 0,
          issues: [],
        },
      ],
      state,
    );
    expect(prepared.automatic).toEqual([
      expect.objectContaining({
        id: fee.id,
        category: "Rücklastschriftgebühren",
      }),
    ]);
    expect(prepared.review).toHaveLength(1);
  });
});

describe("unambiguous PP payment syntax", () => {
  it.each([
    ["PP*BILLA 1234 Wien", "at-billa"],
    ["POS PP*SPOTIFY", "spotify"],
    ["PP / NETFLIX.COM", "netflix"],
    ["PP*Amazon Mktp", "amazon"],
  ])("extracts the actual merchant from %s", (text, id) => {
    expect(index.match(text)).toMatchObject({
      method: "exact",
      merchant: { id },
      requiresManualReview: false,
    });
  });

  it.each([
    "PP",
    "PP BILLA",
    "ID: PP*BILLA",
    "PayPal Referenz: PP*BILLA",
    "PP*BILLA / PP*PENNY",
  ])("requires review instead of inventing identity for %s", (text) => {
    expect(enrichTransaction(booking(text), index).requires_manual_review).toBe(
      true,
    );
  });

  it("normalizes an explicit PP prefix like its PayPal equivalent without changing the source", () => {
    expect(normalizeMerchantDescriptor("PP*SPOTIFY")).toBe(
      normalizeMerchantDescriptor("PayPal*SPOTIFY"),
    );
    const original = booking("PP*SPOTIFY");
    expect(enrichTransaction(original, index)).toMatchObject({
      description: original.description,
      merchantAlias: "Spotify",
      category: "Abonnements",
    });
  });
});
