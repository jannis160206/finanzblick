import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard, classify } from "@/lib/calc";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { executeTool } from "./agent";
import { bookingFilter, cleanupPlan, resolveMerchants } from "./cleanup";
import { applyOperations, recordChange, undoChange } from "./operations";
import { detectTool } from "./tools";

const asOf = "2026-11-08";
const booking = (id: string, date: string, description: string, amount: number, category: Transaction["category"] = "Prüfen", bank = "Raiffeisen"): Transaction =>
  ({ id, date, bank, pocket: `${bank} Giro`, description, amount, category, includeInPlan: true });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.settings.baselineDate = "2026-09-11";
  state.transactions = [
    booking("tr-1", "2026-11-03", "TRADE REPUBLIC BANK GMBH SPARPLAN", -200),
    booking("tr-2", "2026-10-03", "TRADE REPUBLIC BANK GMBH SPARPLAN", -200, "Sonstiges"),
    booking("tr-own", "2026-11-01", "Zinsgutschrift Trade Republic", 6.09, "Einkommen", "Trade Republic"),
    booking("billa", "2026-11-04", "BILLA DANKT", -23),
    booking("spar", "2026-11-05", "SPAR DANKT 1234", -30, "Sonstiges"),
    booking("amazon-big", "2026-11-06", "AMAZON EU", -150, "Sonstiges"),
    booking("amazon-small", "2026-11-06", "AMAZON EU", -20, "Sonstiges"),
    booking("cafe-old", "2026-10-02", "CAFE KORB", -8, "Cafés & Snacks"),
    booking("cafe-new", "2026-11-02", "CAFE KORB", -9),
    booking("market", "2026-07-10", "2Day Supermarket", -10.75),
    booking("unknown", "2026-11-07", "XQZ 4711", -12),
  ];
  const draft = booking("draft-1", "2026-11-07", "WIENER LINIEN GMBH", -6, "Prüfen");
  state.reviewQueue = [{ kind: "booking", id: "draft-1", draft, message: "Händlerzuordnung unsicher – bitte prüfen." }];
  return appStateSchema.parse(state);
}

const context = (state: AppState) => ({ state, dashboard: calculateDashboard(state), asOf });
const category = (state: AppState, id: string) => state.transactions.find((row) => row.id === id)!.category;

describe("bulk rules", () => {
  it("finds the merchant behind filler words and splits several merchants", () => {
    const state = fixture();
    expect(resolveMerchants(state, "Buchung Trade Republic")).toEqual(["Trade Republic"]);
    expect(resolveMerchants(state, "Billa und Spar")).toEqual(["Billa", "Spar"]);
    expect(resolveMerchants(state, "Amazon Buchungen über 100 €")).toEqual(["Amazon"]);
  });

  it("reads dates and amounts", () => {
    expect(bookingFilter("die Buchung vom 3.11. über 200 € ist Transfer intern", asOf)).toEqual({ date: "2026-11-03", exact: 200 });
    expect(bookingFilter("alle Amazon Buchungen über 100 € sind Shopping", asOf)).toEqual({ min: 100 });
    expect(bookingFilter("Billa ist Lebensmittel", asOf)).toEqual({});
  });

  it("moves payments to a broker to internal transfers and remembers it, but not the broker's own bookings", () => {
    const state = fixture();
    const command = "Buchung Trade Republic ist immer Transfer intern";
    expect(detectTool(command)).toBe("rule");
    const result = executeTool("rule", command, context(state));
    expect(result.text).toContain("merke mir das");
    const next = applyOperations(state, result.change!.operations, { asOf }).state;
    expect(category(next, "tr-1")).toBe("Transfer intern");
    expect(category(next, "tr-2")).toBe("Transfer intern");
    expect(category(next, "tr-own")).toBe("Einkommen");
    expect(next.merchantRules?.length).toBeGreaterThan(0);
  });

  it("assigns several merchants at once", () => {
    const state = fixture();
    const result = executeTool("rule", "Billa und Spar sind immer Restaurants", context(state));
    const next = applyOperations(state, result.change!.operations, { asOf }).state;
    expect([classify(next.transactions.find((row) => row.id === "billa")!).category, classify(next.transactions.find((row) => row.id === "spar")!).category]).toEqual(["Restaurants", "Restaurants"]);
    expect(category(next, "tr-1")).toBe("Prüfen");
  });

  it("changes only the booking picked by date and amount, without a rule", () => {
    const state = fixture();
    const command = "die Buchung vom 3.11. über 200 € ist Transfer intern";
    expect(detectTool(command)).toBe("rule");
    const result = executeTool("rule", command, context(state));
    expect(result.change!.operations).toEqual([expect.objectContaining({ ids: ["tr-1"], learn: false })]);
  });

  it("limits a merchant rule to an amount range", () => {
    const state = fixture();
    const command = "alle Amazon Buchungen über 100 € sind Urlaub";
    expect(detectTool(command)).toBe("rule");
    const result = executeTool("rule", command, context(state));
    expect(result.change!.operations).toEqual([expect.objectContaining({ ids: ["amazon-big"], learn: false })]);
  });

  it("checks off every unchecked booking", () => {
    const state = fixture();
    const result = executeTool("booking", "hak alle buchungen ab", context(state));
    const next = applyOperations(state, result.change!.operations, { asOf }).state;
    expect(next.transactions.every((row) => row.reviewed)).toBe(true);
  });
});

describe("cleanup", () => {
  it.each(["arbeite alle Prüfen-Buchungen ab", "ordne alle offenen Buchungen zu", "kategorisiere alle ungeprüften buchungen"])("routes %s", (command) => {
    expect(detectTool(command)).toBe("cleanup");
  });

  it("settles the review list and open bookings in one undoable step", () => {
    const state = fixture();
    const plan = cleanupPlan(state);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.open).toBe(1);
    const result = executeTool("cleanup", "arbeite alle Prüfen-Buchungen ab", context(state));
    expect(result.text).toContain("bleiben offen");
    const applied = applyOperations(state, result.change!.operations, { asOf });
    const logged = appStateSchema.parse(recordChange(applied.state, applied, { id: "log-1", at: 1, title: result.change!.title }));
    expect((logged.reviewQueue ?? []).map((item) => item.id)).not.toContain("draft-1");
    expect(classify(logged.transactions.find((row) => row.description === "WIENER LINIEN GMBH")!).category).toBe("Öffentliche Verkehrsmittel");
    expect(category(logged, "cafe-new")).toBe("Cafés & Snacks");
    expect(category(logged, "market")).toBe("Lebensmittel");
    expect(category(logged, "unknown")).toBe("Prüfen");

    const reverted = undoChange(logged, "log-1", 2);
    expect(reverted.reviewQueue?.map((item) => item.id)).toContain("draft-1");
    expect(reverted.transactions.map((row) => row.id).sort()).toEqual(state.transactions.map((row) => row.id).sort());
    expect(category(reverted, "cafe-new")).toBe("Prüfen");
  });

  it("says so when nothing is open", () => {
    const state = fixture();
    state.transactions = state.transactions.filter((row) => row.category !== "Prüfen");
    state.reviewQueue = [];
    expect(executeTool("cleanup", "arbeite alle Prüfen-Buchungen ab", context(state)).text).toContain("nichts offen");
  });
});
