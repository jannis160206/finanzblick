import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { prepareStatementImport, commitStatementImport } from "./review";
import { deduplicateStatements, detectStatementSource, parseStatementCsv } from "./statements";
import { isTradeRepublicHeader } from "./trade-republic";

const header = ["datetime", "date", "account_type", "category", "type", "asset_class", "name", "symbol", "shares", "price",
  "amount", "fee", "tax", "currency", "original_amount", "original_currency", "fx_rate", "description", "transaction_id",
  "counterparty_name", "counterparty_iban", "payment_reference", "mcc_code"];
type Row = Partial<Record<(typeof header)[number], string>>;
const csv = (rows: Row[]) => [header, ...rows.map((row) => header.map((name) => row[name] ?? ""))]
  .map((cells) => cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(",")).join("\n");
const cash = (row: Row): Row => ({ account_type: "DEFAULT", category: "CASH", currency: "EUR", ...row });

const fixture: Row[] = [
  cash({ datetime: "2026-01-02T09:00:00.000Z", date: "2026-01-02", type: "TRANSFER_INSTANT_INBOUND", amount: "1000.000000",
    description: "Incoming transfer from Jannis Bruhl (LT000000000000000001)", transaction_id: "t-in" }),
  cash({ datetime: "2026-01-03T09:00:00.000Z", date: "2026-01-03", type: "TRANSFER_INSTANT_INBOUND", amount: "40.000000",
    description: "Incoming transfer from Max Muster (AT000000000000000002)", transaction_id: "t-ext" }),
  { datetime: "2026-01-05T14:00:00.000Z", date: "2026-01-05", account_type: "DEFAULT", category: "TRADING", type: "BUY",
    asset_class: "FUND", name: "Test World ETF", symbol: "IE0000000001", shares: "2", price: "100", amount: "-200.000000",
    fee: "-1.00", currency: "EUR", description: "Buy trade IE0000000001 Test World ETF, quantity: 2", transaction_id: "t-buy" },
  cash({ datetime: "2026-01-10T11:00:00.000Z", date: "2026-01-10", type: "CARD_TRANSACTION", name: "Testshop|Wien|AT",
    amount: "-25.500000", description: "Testshop|Wien|AT", transaction_id: "t-card", mcc_code: "5411" }),
  cash({ datetime: "2026-01-12T12:00:00.000Z", date: "2026-01-12", type: "CARD_TRANSACTION_INTERNATIONAL", name: "AIRPORT ATM",
    amount: "-50.000000", fee: "-1.00", original_amount: "-2500.00", original_currency: "EGP", fx_rate: "0.02",
    description: "AIRPORT ATM, 2.500,00 EGP, exchange rate: 0,02, ATM fee: 1,00 €", transaction_id: "t-atm", mcc_code: "6011" }),
  cash({ datetime: "2026-01-13T12:00:00.000Z", date: "2026-01-13", type: "CARD_TRANSACTION_INTERNATIONAL", name: "HOLD SHOP",
    amount: "-80.000000", description: "HOLD SHOP", transaction_id: "t-hold", mcc_code: "5999" }),
  cash({ datetime: "2026-01-13T12:00:01.000Z", date: "2026-01-13", type: "CARD_TRANSACTION_INTERNATIONAL", name: "HOLD SHOP",
    amount: "80.000000", description: "HOLD SHOP", transaction_id: "t-hold-back", mcc_code: "5999" }),
  cash({ datetime: "2026-01-20T08:00:00.000Z", date: "2026-01-20", type: "CARD_ORDERING_FEE", amount: "0.000000", fee: "-50.00",
    description: "Trade Republic Card", transaction_id: "t-cardfee" }),
  cash({ datetime: "2026-01-31T23:30:00.000Z", date: "2026-02-01", type: "INTEREST_PAYMENT", amount: "4.000000", tax: "-1.00",
    description: "Your interest payment", transaction_id: "t-int" }),
  cash({ datetime: "2026-02-01T01:00:00.000Z", date: "2026-02-01", type: "BENEFITS_SAVEBACK", amount: "0.800000", tax: "-0.20",
    description: "Saveback cash reward", transaction_id: "t-save" }),
  cash({ datetime: "2026-02-02T10:00:00.000Z", date: "2026-02-02", type: "TRANSFER_INSTANT_OUTBOUND", amount: "-100.000000",
    description: "Outgoing transfer for Jannis Brühl (AT000000000000000003)", transaction_id: "t-out" }),
];

describe("Trade Republic transaction export", () => {
  it("recognizes the export header", () => {
    expect(isTradeRepublicHeader(header)).toBe(true);
    expect(detectStatementSource([header])).toBe("Trade Republic");
  });

  it("maps cash, card, fee and depot rows and computes the cash balance", () => {
    const result = parseStatementCsv(csv(fixture), "Transaktionsexport.csv");
    expect(result.source).toBe("Trade Republic");
    expect(result.issues).toEqual([]);
    // The reversed authorisation pair is not imported.
    expect(result.skipped).toBe(2);
    expect(result.rows.every((row) => row.bank === "Trade Republic" && row.pocket === "Verrechnungskonto")).toBe(true);
    const by = (reference: string) => result.rows.find((row) => row.bankReference === reference)!;
    expect(by("t-in")).toMatchObject({ amount: 1000, includeInPlan: false });
    expect(by("t-in").category).toMatch(/^Transfer/);
    expect(by("t-out").category).toMatch(/^Transfer/);
    expect(by("t-ext")).toMatchObject({ description: "Überweisung von Max Muster", amount: 40 });
    expect(by("t-buy")).toMatchObject({ amount: -200, category: "Transfer intern", includeInPlan: false });
    expect(by("t-buy:fee")).toMatchObject({ amount: -1, category: "Bankgebühren" });
    expect(by("t-card")).toMatchObject({ description: "Testshop", amount: -25.5, time: "12:00:00" });
    expect(by("t-card").rawDetails).toEqual(expect.arrayContaining(["Ort: Wien, AT", "MCC: 5411"]));
    expect(by("t-atm")).toMatchObject({ description: "Bargeldbehebung AIRPORT ATM", amount: -50 });
    expect(by("t-atm").rawDetails).toEqual(expect.arrayContaining(["MCC: 6011", "Originalbetrag (EGP): -2500.00"]));
    expect(by("t-atm:fee")).toMatchObject({ amount: -1, category: "Bankgebühren" });
    expect(by("t-cardfee")).toMatchObject({ description: "Kartengebühr Trade Republic Card", amount: -50, category: "Bankgebühren" });
    expect(by("t-int")).toMatchObject({ description: "Zinsgutschrift Trade Republic", amount: 3, category: "Einkommen", date: "2026-02-01" });
    expect(by("t-save")).toMatchObject({ amount: 0.6, category: "Einkommen" });
    expect(result.rows.some((row) => row.bankReference?.startsWith("t-hold"))).toBe(false);
    // 1000 + 40 - 201 - 25.5 - 51 - 50 + 3 + 0.6 - 100
    expect(result.trBalances).toEqual([{ date: "2026-02-02", balance: 616.1 }]);
  });

  it("deduplicates a re-imported export by transaction id", () => {
    const first = parseStatementCsv(csv(fixture), "a.csv");
    const second = parseStatementCsv(csv(fixture), "b.csv");
    expect(deduplicateStatements(second.rows, first.rows)).toMatchObject({ rows: [], duplicates: first.rows.length });
  });

  it("does not derive a balance from an export with unreadable rows", () => {
    const result = parseStatementCsv(csv([...fixture, cash({ datetime: "2026-02-03T10:00:00Z", date: "2026-02-03",
      type: "CARD_TRANSACTION", name: "Broken", amount: "-1,5", transaction_id: "t-bad" })]), "x.csv");
    expect(result.issues).toHaveLength(1);
    expect(result.trBalances).toBeUndefined();
  });

  it("stores the derived balance without overwriting a manual entry of the same day", () => {
    const result = parseStatementCsv(csv(fixture), "Transaktionsexport.csv");
    const manual = { ...createEmptyAccountState(), trBalances: [{ date: "2026-02-02", balance: 600 }] };
    const prepared = prepareStatementImport([result], manual);
    expect(prepared.metadata.trBalances).toEqual([{ date: "2026-02-02", balance: 616.1 }]);
    const committed = commitStatementImport(manual, prepared.automatic, [], prepared.metadata);
    expect(committed.state.trBalances).toEqual([{ date: "2026-02-02", balance: 600 }]);
    const empty = createEmptyAccountState();
    const fresh = prepareStatementImport([result], empty);
    expect(commitStatementImport(empty, fresh.automatic, [], fresh.metadata).state.trBalances)
      .toEqual([{ date: "2026-02-02", balance: 616.1 }]);
  });
});
