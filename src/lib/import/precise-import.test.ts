import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { actualBookings, actualPockets, bookingMonth, calculateDashboard, classify } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { parseAmexText } from "./amex-pdf";
import { statementFingerprint } from "./identity";
import { merchantRuleKey } from "./merchant-rules";
import { commitStatementImport, prepareStatementImport, queueLedgerReview } from "./review";
import { parseStatementCsv, type StatementResult } from "./statements";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/precise-${name}`, import.meta.url), "utf8");
const row = (description: string, amount = -8, extra: Partial<Transaction> = {}): Transaction => ({
  id: crypto.randomUUID(), date: "2026-09-14", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
  description, amount, category: "Prüfen", includeInPlan: true, ...extra,
});
const result = (rows: Transaction[]): StatementResult => ({ source: "Raiffeisen", file: "test.csv", rows, skipped: 0, issues: [] });
const save = (state: AppState, parsed: StatementResult[]) => {
  const prepared = prepareStatementImport(parsed, state);
  return queueLedgerReview(commitStatementImport(state, prepared.automatic, [], prepared.metadata).state);
};

describe("precise statement facts", () => {
  it("reads headerless Giro facts and gives POS clocks precedence over booking timestamps", () => {
    const parsed = parseStatementCsv(fixture("raiffeisen.csv"));
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows).toHaveLength(9);
    expect(parsed.rows[0]).toMatchObject({ description: "Martin Auer", date: "2026-09-04", amount: -8.4,
      bank: "Raiffeisen", time: "16:55:00", category: "Cafés & Snacks", bankReference: "05.09.2026 08:02:01:001" });
    expect(parsed.rows[0].rawDescription).toContain("MARTIN AUER ATRIOVIL VILLACH 9500");
    expect(parsed.rows[1]).toMatchObject({ description: "SPAR 2361", time: "12:10:00", category: "Mittagessen" });
    expect(parsed.rows[2]).toMatchObject({ category: "Mittagessen", date: "2026-09-13" });
    expect(parsed.rows[3]).toMatchObject({ category: "Lebensmittel", amount: -10.38, time: "16:29:00" });
    expect(parsed.rows[4].category).toBe("Shopping");
    expect(parsed.rows[5]).toMatchObject({ amount: -700, category: "Transfer intern", time: "10:03:12" });
    expect(parsed.rows[7]).toMatchObject({ amount: -1529.58, category: "Leasing" });
    expect(parsed.rows[8]).toMatchObject({ amount: 2576.43, category: "Gehalt" });
    expect(bookingMonth(parsed.rows[8])).toBe("2026-09");
  });

  it("retains pocket movements but skips totals, zero FX accounts and tax dividends/lots", () => {
    const parsed = parseStatementCsv(fixture("revolut.csv"));
    expect(parsed.issues).toEqual([]);
    expect(parsed.rows.map((item) => item.amount)).toEqual([700, -100, -0.47, 0.47]);
    expect(parsed.rows.every((item) => item.category === "Transfer intern" && !item.includeInPlan)).toBe(true);
    expect(parsed.rows.map((item) => item.pocket)).toEqual(["Persönliches Konto", "Persönliches Konto", "Persönliches Konto", "Sparen"]);
    expect(classify(parsed.rows[2]).isRoundUp).toBe(true);
    const seed = createSeed(); seed.settings.asOf = "2026-09-16";
    const state = save(seed, [parsed]);
    expect(actualPockets(state).Sparkonto).toBeCloseTo(state.settings.balances.Sparkonto + 0.47, 2);
  });

  it("pairs round-ups one-for-one only with their savings credit, never another pocket", () => {
    const state = createSeed(); state.settings.asOf = "2026-09-16";
    state.transactions = [
      row("Auszahlung bei Pocket", -0.47, { bank: "Revolut", pocket: "Persönliches Konto" }),
      row("einstecken", 0.47, { bank: "Revolut", pocket: "Urlaub", bankReference: "OTHER-POCKET" }),
      row("einstecken", 0.47, { bank: "Revolut", pocket: "Sparen", bankReference: "ROUNDUP-CREDIT" }),
      row("einstecken", 0.47, { bank: "Revolut", pocket: "Sparen", bankReference: "EXTRA-CREDIT" }),
    ];
    expect(actualPockets(state).Sparkonto).toBeCloseTo(state.settings.balances.Sparkonto + 0.94, 2);
    expect(actualPockets(state).Urlaub).toBeCloseTo(state.settings.balances.Urlaub + 0.47, 2);
    expect(state.transactions).toHaveLength(4);
    state.pocketSnapshots = [{ bank: "Revolut", pocket: "Sparkonto", date: "2026-09-13", balance: 100 }];
    expect(actualPockets(state).Sparkonto).toBe(100.94);
  });

  it("keeps Amex continuation text and Raphael charges, skips payment CR, and counts Giro settlement only once", () => {
    const amex = parseAmexText([fixture("amex.txt")]);
    expect(amex.issues).toEqual([]);
    expect(amex.skipped).toBe(1);
    expect(amex.rows).toHaveLength(2);
    expect(amex.rows[0]).toMatchObject({ description: "McDonalds VILLACH", date: "2026-09-14", amount: -12, category: "Restaurants" });
    expect(amex.rows[1]).toMatchObject({ pocket: "AMEX Raphael", amount: -20, includeInPlan: false });
    const giro = parseStatementCsv(fixture("raiffeisen.csv"));
    const settlement = result([giro.rows[6]]);
    let state = createSeed(); state.settings.asOf = "2026-09-16";
    state = save(state, [amex, settlement]);
    expect(actualBookings(state)).toHaveLength(3);
    // Raphael remains real ledger spending, but never enters Jannis's plan.
    expect(calculateDashboard(state).current.actualSpending).toBe(32);
    const own = save({ ...createSeed(), settings: state.settings }, [result(amex.rows.filter((item) => item.pocket === "AMEX Jannis")), settlement]);
    expect(calculateDashboard(own).current.actualSpending).toBe(12);
    expect(actualBookings(save(state, [amex, settlement]))).toHaveLength(3);
  });

  it.each(["ANDERER INHABER", "JANNIS MUSTERMANN", "RAPHAEL MUSTERMANN"])("does not assign unrecognized Amex holder %s to Jannis or Raphael", (holder) => {
    const parsed = parseAmexText([fixture("amex.txt").replace("Neue Belastungen für HERRN JANNIS BRUEHL", `Neue Belastungen für HERRN ${holder}`)]);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0].draft).toMatchObject({ amount: -12, pocket: "AMEX ungeklärt" });
    expect(parsed.rows[0].pocket).toBe("AMEX Raphael");
  });

  it.each([true, false])("preserves two equal same-day McDonalds charges across reimport (bank references: %s)", (references) => {
    const csv = `Raiffeisen\nDatum;Beschreibung;Betrag${references ? ";Referenz" : ""}\n14.09.2026;McDonalds;-12,00${references ? ";TEST-A" : ""}\n14.09.2026;McDonalds;-12,00${references ? ";TEST-B" : ""}`;
    const parsed = parseStatementCsv(csv);
    expect(new Set(parsed.rows.map(statementFingerprint)).size).toBe(2);
    const state = save(createSeed(), [parsed, parseStatementCsv(csv)]);
    expect(state.transactions).toHaveLength(2);
    expect(save(state, [parseStatementCsv(csv)]).transactions).toHaveLength(2);
  });
});

describe("high-confidence merchant policy", () => {
  it.each([
    ["BIPA", "Mittagessen"], ["Hotspot", "Mittagessen"], ["Mensa", "Mittagessen"],
    ["Trafik Haas", "Shopping"], ["SHELL FURNITZ", "Mobilität"], ["OMV", "Mobilität"], ["ENI", "Mobilität"],
    ["McD", "Restaurants"], ["Burger King", "Restaurants"], ["Pizzeria", "Restaurants"], ["Bauernhof Gams", "Restaurants"],
    ["Sakura", "Restaurants"], ["Wolt", "Lieferdienste"], ["MARTIN AUER", "Cafés & Snacks"], ["DM-FIL", "Drogerie"],
    ["Porsche Bank", "Leasing"], ["Allianz", "Versicherungen"], ["Vollkasko", "Versicherungen"], ["A1", "Telefon & Internet"],
  ])("silently files %s as %s even on Sunday", (description, category) => {
    const parsed = prepareStatementImport([result([row(description, -8, { date: "2026-09-13" })])], createSeed());
    expect(parsed.review).toEqual([]);
    expect(parsed.automatic[0].category).toBe(category);
  });

  it.each(["BILLA", "SPAR", "PENNY"])("uses the exact calendar/clock/amount limits for %s", (description) => {
    expect(classify(row(description, -10, { time: "14:00:00" })).category).toBe("Mittagessen");
    for (const extra of [{ time: "14:00:01" }, { time: "10:59:59" }, {}, { date: "2026-10-10", time: "12:00:00" },
      { date: "2026-10-26", time: "12:00:00" }, { date: "2026-09-13", time: "12:00:00" }, { amount: -10.01, time: "12:00:00" }])
      expect(classify(row(description, -10, extra)).category).toBe("Lebensmittel");
  });

  it.each(["AMZN", "AMZ-SHOP", "PRIME", "Amazon"])("never creates a synthetic savings movement for %s", (description) => {
    const booking = row(description, -80);
    expect(classify(booking)).toMatchObject({ category: "Shopping", includeInPlan: false, pocket: null, isTransfer: false });
    const state = createSeed(); state.transactions = [booking];
    expect(actualPockets(state)).toEqual(state.settings.balances);
  });

  it.each(["Unbekannter Laden", "BIPA / SHELL", "BILLA / DM", "Amazon / Pizzeria", "POS 8,40 AT D1 14.09. 12:00", "BANKOMAT"])("leaves %s open rather than choosing the first signal", (description) => {
    const prepared = prepareStatementImport([result([row(description)])], createSeed());
    expect(prepared.automatic).toEqual([]);
    expect(prepared.review).toHaveLength(1);
  });

  it("uses learned ATM choices, but automatically recognizes only twenty euros", () => {
    expect(classify(row("BANKOMAT", -20)).category).toBe("Körperpflege");
    const state = createSeed(); state.merchantRules = [{ key: "raiffeisen|bankomat", category: "Shopping" }];
    expect(prepareStatementImport([result([row("BANKOMAT", -50)])], state).automatic[0].category).toBe("Shopping");
  });

  it.each(["REVOLUT** ePAYMENT", "Gesendet von Revolut", "Online Banking IBAN: LT250000000000000000", "Online Banking IBAN: AT201910000010195000", "AMERICAN EXPRESS EUROPE"])("keeps proven transfer %s out of spending, including stale manual choices", (description) => {
    expect(classify(row(description, -700, { category: "Shopping", categoryOverride: true })))
      .toMatchObject({ category: "Transfer intern", isTransfer: true, includeInPlan: false });
  });

  it("does not convert Raphael inbound or the confirmed June special payment into a new salary", () => {
    expect(classify(row("Raphael Piber", 50, { category: "Gehalt" })).category).not.toBe("Gehalt");
    const special = row("TTS Gehalt 6/2026", 5506.72, { date: "2026-06-29", category: "Gehalt", categoryOverride: true });
    expect(classify(special).category).toBe("Einkommen");
    expect(bookingMonth(special)).toBe("2026-06");
    const state = createSeed();
    expect(save(state, [result([special])]).financeRows).toEqual(state.financeRows);
    expect(classify({ ...special, description: "Anderer Arbeitgeber Gehalt 6/2026" }).category).toBe("Gehalt");
    expect(classify({ ...special, amount: 5700 }).category).toBe("Gehalt");
  });
});

describe("stable identity and persisted repair", () => {
  it.each([
    ["MARTIN AUER ATRIOVIL VILLACH 9500", "Martin Auer"],
    ["BILLA DANKT 1234 D1 14.09. 12:00", "BILLA Filiale 1234 D1 15.09. 13:00"],
    ["SPAR 2361 D1 14.09. 12:00", "SPAR Fil. 2361 D1 15.09. 13:00"],
    ["SHELL FURNITZ D1 14.09. 12:00", "Shell Furnitz"],
    ["BIPA DANKT 042 D1 14.09. 12:00", "BIPA Filiale 042 D1 15.09. 13:00"],
    ["TRAFIK WARUM D1 14.09. 12:00", "Trafik Warum"], ["TRAFIK HAAS D1 14.09. 12:00", "Trafik Haas"],
  ])("normalizes %s without including the POS clock", (first, next) => {
    expect(merchantRuleKey(row(first))).toBe(merchantRuleKey(row(next)));
    expect(merchantRuleKey(row("SPAR 2361"))).not.toBe(merchantRuleKey(row("SPAR 9999")));
  });

  it("repairs stored rawDetails without changing occurrence, signed amount, reference or existing time", () => {
    const old = row("POS 8,40 AT D1 04.09. 16:55", -8.4, { date: "2026-09-04", category: "Sonstiges",
      bankReference: "TEST-OLD", occurrence: 2, rawDetails: ["Verwendungszweck: MARTIN AUER ATRIOVIL VILLACH 9500"], time: "16:54:00" });
    const state = createSeed(); state.transactions = [old];
    const restored = queueLedgerReview(appStateSchema.parse(JSON.parse(JSON.stringify(state))));
    expect(restored.transactions[0]).toMatchObject({ id: old.id, date: old.date, amount: -8.4, bank: old.bank, pocket: old.pocket,
      bankReference: "TEST-OLD", occurrence: 2, time: "16:54:00", description: "Martin Auer", category: "Cafés & Snacks" });
    expect(statementFingerprint(restored.transactions[0])).toBe(statementFingerprint(old));
    expect(restored.reviewQueue).toEqual([]);
    expect(queueLedgerReview(restored)).toEqual(restored);
    expect(old.description).toContain("POS");
  });

  it("leaves conflicting raw merchant details in review", () => {
    const state = createSeed(); state.transactions = [row("POS 8,40 AT D1 14.09. 12:00", -8.4,
      { rawDetails: ["Verwendungszweck: BILLA", "Verwendungszweck: SPAR"] })];
    expect(queueLedgerReview(state).reviewQueue).toHaveLength(1);
  });

  it("applies one merchant answer to all open twins and future imports, including known merchants", () => {
    let state = save(createSeed(), [result([row("NEUER LADEN"), row("neuer laden", -16)])]);
    const choice = state.reviewQueue?.[0];
    if (!choice || choice.kind !== "booking") throw new Error("Expected review");
    state = queueLedgerReview(commitStatementImport(state, [{ ...choice.draft, amount: -8, category: "Freizeit", categoryOverride: true }]).state);
    expect(state.transactions).toHaveLength(2);
    expect(state.reviewQueue).toEqual([]);
    expect(prepareStatementImport([result([row("NEUER LADEN", -30)])], state).automatic[0].category).toBe("Freizeit");
    state.merchantRules = [{ key: "raiffeisen|martin auer", category: "Shopping" }];
    expect(prepareStatementImport([result([row("Martin Auer", -9)])], state).automatic[0].category).toBe("Shopping");
  });

  it.each(["PayPal", "PayPal Europe", "PayPal Europe S.a.r.l. et Cie S.C.A", "Revolut", "POS"])("does not propagate or persist a blanket %s rule", (description) => {
    let state = createSeed();
    state.transactions = [row(description), row(description, -15)];
    state.merchantRules = [{ key: merchantRuleKey(state.transactions[0]), category: "Shopping" }];
    state = queueLedgerReview(state);
    state = queueLedgerReview(commitStatementImport(state, [{ ...state.transactions[0], category: "Shopping", categoryOverride: true }]).state);
    expect(state.transactions[1].categoryOverride).not.toBe(true);
    expect(state.merchantRules ?? []).toEqual([]);
    expect(prepareStatementImport([result([row(description, -25)])], state).review).toHaveLength(1);
  });
});
