import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSeed } from "@/lib/seed";
import { appStateSchema, assistantCardSchema, type AppState, type Transaction } from "@/lib/types";
import { ordersAnswer } from "@/lib/assistant/orders";
import { detectTool } from "@/lib/assistant/tools";
import { orderTotal, parseOrderMail, type OrderMail, type ParsedCancel, type ParsedOrder } from "./orders";
import { reconcileOrders, type MailOrder } from "./reconcile";

let counter = 0;
const mail = (from: string, subject: string, text: string, date = "2026-11-02"): OrderMail => ({ messageId: `<m${++counter}@test>`, from, subject, text, date });
const row = (date: string, description: string, amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id: `t${++counter}`, date, bank: "Raiffeisen", pocket: "Giro", description, amount, category: "Shopping", includeInPlan: true, ...extra,
});
const stateWith = (transactions: Transaction[] = [], extra: Partial<AppState> = {}): AppState => appStateSchema.parse({
  ...createSeed(), transactions, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [], plannedOneOffs: [],
  ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [], ...extra,
});
const asOrder = (value: ReturnType<typeof parseOrderMail>) => value as ParsedOrder;

const amazon = mail("Amazon.de <bestellbestaetigung@amazon.de>", "Bestellt: „Logitech MX Master 3S“ und 1 weiterer Artikel",
  "Bestellnummer 302-1234567-7654321\nZwischensumme: 89,99 €\nVersand: 0,00 €\nGesamtbetrag: 94,98 €\nZahlungsart: Visa •••• 1234");

describe("Bestellmails erkennen", () => {
  it("reads shop, product, order number, total and card due date", () => {
    const order = asOrder(parseOrderMail(amazon));
    expect(order).toMatchObject({ kind: "order", shop: "Amazon", product: "Logitech MX Master 3S", orderNumber: "302-1234567-7654321",
      amount: 94.98, method: "card", orderDate: "2026-11-02", dueDate: "2026-11-04", installments: 1 });
    expect(order.bill).toBeUndefined();
  });

  it("plans Klarna pay later after 30 days and uses an explicit due date when given", () => {
    const later = asOrder(parseOrderMail(mail("Klarna <noreply@klarna.com>", "Deine Bestellung bei Zalando", "Gesamtbetrag 59,95 €. Bezahle mit Klarna in 30 Tagen.")));
    expect(later).toMatchObject({ shop: "Zalando", amount: 59.95, method: "klarna", dueDate: "2026-12-02" });
    const explicit = asOrder(parseOrderMail(mail("Klarna <noreply@klarna.com>", "Deine Bestellung bei Zalando", "Betrag: 59,95 €\nFällig am 20.11.2026")));
    expect(explicit.dueDate).toBe("2026-11-20");
    const rates = asOrder(parseOrderMail(mail("Klarna <noreply@klarna.com>", "Dein Zahlungsplan bei MediaMarkt", "Gesamtbetrag: 300,00 €\nDu zahlst in 3 Raten")));
    expect(rates).toMatchObject({ method: "klarna", installments: 3, amount: 300, dueDate: "2026-11-02" });
  });

  it("gives invoices 14 days and flags plain bills from non-shops", () => {
    const invoice = asOrder(parseOrderMail(mail("Shop Muster <info@muster-shop.at>", "Ihre Bestellung 4711", "Bestellnummer: AB12345\nZu zahlen: 120,00 €\nKauf auf Rechnung")));
    expect(invoice).toMatchObject({ method: "invoice", dueDate: "2026-11-16", amount: 120 });
    const bill = asOrder(parseOrderMail(mail("Magenta <rechnung@magenta.at>", "Ihre Rechnung", "Rechnungsbetrag: 25,00 €")));
    expect(bill.bill).toBe(true);
  });

  it("ignores shipping, marketing and payment-received mails and detects cancellations", () => {
    expect(parseOrderMail(mail("Amazon.de <versand@amazon.de>", "Versandt: Deine Bestellung", "Gesamtbetrag 94,98 €"))).toBeUndefined();
    expect(parseOrderMail(mail("Zalando <news@zalando.at>", "Sale: 30 % Rabatt auf deine Bestellung", "Nur heute 19,99 €"))).toBeUndefined();
    expect(parseOrderMail(mail("PayPal <service@paypal.at>", "Zahlung erhalten", "Betrag: 10,00 €"))).toBeUndefined();
    const cancel = parseOrderMail(mail("Amazon.de <x@amazon.de>", "Stornierung Ihrer Bestellung", "Bestellnummer 302-1234567-7654321")) as ParsedCancel;
    expect(cancel).toMatchObject({ kind: "cancel", shop: "Amazon", orderNumber: "302-1234567-7654321" });
  });

  it("skips subtotals and shipping when picking the total", () => {
    expect(orderTotal("Zwischensumme 10,00 €\nVersandkosten 4,99 €\nGesamtsumme 14,99 €")).toBe(14.99);
    expect(orderTotal("Summe EUR 1.234,50")).toBe(1234.5);
  });
});

describe("Bestellungen abgleichen", () => {
  const today = "2026-11-03";
  const order = asOrder(parseOrderMail(amazon));

  it("plans an open order once and settles it when the debit arrives", () => {
    const first = reconcileOrders(stateWith(), [], [order, order], today);
    expect(first.added).toBe(1);
    expect(first.state.plannedOneOffs).toEqual([expect.objectContaining({ id: `mail-${order.id}`, amount: 94.98, date: "2026-11-04", pocket: "Giro" })]);
    const booked = stateWith([row("2026-11-04", "AMAZON EU SARL", -94.98)], { plannedOneOffs: first.state.plannedOneOffs });
    const second = reconcileOrders(booked, first.orders, [], "2026-11-05");
    expect(second.paid).toBe(1);
    expect(second.orders[0].status).toBe("paid");
    expect(second.state.plannedOneOffs).toEqual([]);
  });

  it("removes cancelled orders and respects orders the user deleted", () => {
    const first = reconcileOrders(stateWith(), [], [order], today);
    const cancel = parseOrderMail(mail("Amazon.de <x@amazon.de>", "Stornierung", "Bestellnummer 302-1234567-7654321")) as ParsedCancel;
    const cancelled = reconcileOrders(first.state, first.orders, [cancel], today);
    expect(cancelled.cancelled).toBe(1);
    expect(cancelled.state.plannedOneOffs).toEqual([]);
    const dismissed = reconcileOrders(stateWith(), first.orders, [], today);
    expect(dismissed.orders[0].status).toBe("dismissed");
    expect(reconcileOrders(dismissed.state, dismissed.orders, [order], today).state.plannedOneOffs).toEqual([]);
  });

  it("rolls overdue payments forward, expires stale ones and keeps own planned items", () => {
    const own = { id: "urlaub", name: "Urlaub", date: "2026-12-01", amount: 500, pocket: "Giro" as const, installments: 1 };
    const first = reconcileOrders(stateWith([], { plannedOneOffs: [own] }), [], [order], today);
    const later = reconcileOrders(first.state, first.orders, [], "2026-11-10");
    expect(later.state.plannedOneOffs?.find((item) => item.id.startsWith("mail-"))?.date).toBe("2026-11-11");
    const stale = reconcileOrders(later.state, later.orders, [], "2026-12-01");
    expect(stale.orders[0].status).toBe("expired");
    expect(stale.state.plannedOneOffs).toEqual([own]);
  });

  it("does not double-plan monthly bills that are already fixed costs", () => {
    const bill = asOrder(parseOrderMail(mail("Magenta <rechnung@magenta.at>", "Ihre Rechnung", "Rechnungsbetrag: 25,00 €")));
    const state = stateWith([row("2026-10-05", "MAGENTA TELEKOM", -25, { fixedCost: true })]);
    expect(reconcileOrders(state, [], [bill], today).added).toBe(0);
    expect(reconcileOrders(stateWith(), [], [bill], today).added).toBe(1);
  });
});

describe("Assistent: offene Bestellungen", () => {
  it("routes order questions and lists open mail orders", () => {
    for (const text of ["Welche Bestellungen sind noch offen?", "was muss ich bei klarna noch zahlen", "offene Rechnungen"])
      expect(detectTool(text), text).toBe("orders");
    expect(detectTool("Wie viel kann ich heute noch ausgeben?")).toBe("pulse");
    const order = asOrder(parseOrderMail(amazon));
    const { state } = reconcileOrders(stateWith(), [], [order], "2026-11-03");
    const answer = ordersAnswer(state, "2026-11-03");
    expect(assistantCardSchema.parse(answer.card).lines[0]).toMatchObject({ value: -94.98 });
    expect(answer.text).toContain("94,98");
    expect(ordersAnswer(stateWith(), "2026-11-03").text).toContain("Gmail");
  });
});

describe("Gmail-Sync", () => {
  let directory = "";
  afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

  it("stores the link without exposing the password and plans orders from fetched mails", async () => {
    const { AccountDatabase } = await import("@/lib/server/database");
    const { connectMail, mailStatus, syncMail, disconnectMail } = await import("./sync");
    directory = await mkdtemp(join(tmpdir(), "mail-"));
    const database = new AccountDatabase(join(directory, "db.sqlite"));
    try {
      const userId = (await database.register("mailtest", "ein-sicheres-passwort-123")).user.id;
      database.putFinance(userId, stateWith(), 0);
      const fetcher = async () => [amazon];
      const result = await connectMail(database, userId, "Name@Gmail.com", "abcd efgh ijkl mnop", fetcher);
      expect(result).toMatchObject({ connected: true, email: "name@gmail.com", added: 1 });
      expect(JSON.stringify(await mailStatus(database, userId))).not.toContain("abcdefgh");
      expect(database.getFinance(userId).state?.plannedOneOffs).toHaveLength(1);
      expect((await syncMail(database, userId, fetcher)).added).toBe(0);
      await disconnectMail(database, userId);
      expect(database.getFinance(userId).state?.plannedOneOffs).toEqual([]);
      expect((await mailStatus(database, userId)).connected).toBe(false);
      await expect(connectMail(database, userId, "x@outlook.com", "abcdefghijkl", fetcher)).rejects.toThrow("Gmail");
    } finally {
      database.close();
    }
  });
});

export type { MailOrder };
