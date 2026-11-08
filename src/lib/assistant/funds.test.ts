import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import type { AppState } from "@/lib/types";
import { executeTool } from "./agent";
import { checkFunds, parseAccountRules, servesPurpose, storeAccountRules } from "./funds";
import { detectTool } from "./tools";

const asOf = "2026-11-08";
const teach = "sparkonto ist für alle ausgaben was ich will und traderepublic nur für max autowerkstatt ölwechsel etc. usw.";

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.accountSnapshots = [
    { bank: "Bank Austria", name: "Tagesgeld", date: "2026-11-07", balance: 900 },
    { bank: "Trade Republic", name: "Verrechnungskonto", date: "2026-11-07", balance: 3000 },
  ];
  state.accountRules = storeAccountRules(undefined, parseAccountRules("Tagesgeld ist für alle Ausgaben und Trade Republic nur für Autowerkstatt, Ölwechsel", ["Tagesgeld", "Verrechnungskonto"], 1));
  return state;
}

describe("account usage rules", () => {
  it("reads the user's own sentence", () => {
    const rules = parseAccountRules(teach, ["Sparkonto"], 1);
    expect(rules).toEqual([
      expect.objectContaining({ account: "Sparkonto", use: "any", purposes: [] }),
      expect.objectContaining({ account: "Trade Republic", use: "only", purposes: ["autowerkstatt", "ölwechsel"] }),
    ]);
    expect(parseAccountRules("Notgroschen nicht angreifen", ["Notgroschen"], 1)).toEqual([expect.objectContaining({ account: "Notgroschen", use: "never" })]);
  });

  it("keeps only the latest rule per account", () => {
    const first = parseAccountRules("Sparkonto nur für Urlaub", ["Sparkonto"], 1);
    const second = parseAccountRules("Sparkonto ist für alles", ["Sparkonto"], 2);
    expect(storeAccountRules(first, second)).toEqual([expect.objectContaining({ account: "Sparkonto", use: "any" })]);
  });

  it("knows which spending belongs to a car purpose", () => {
    expect(servesPurpose(["autowerkstatt", "ölwechsel"], "Reifen")).toBe(true);
    expect(servesPurpose(["autowerkstatt"], "Ölwechsel")).toBe(true);
    expect(servesPurpose(["autowerkstatt", "ölwechsel"], "Fernseher")).toBe(false);
  });
});

describe("funds check", () => {
  it("pays general spending from the free account and says OK", () => {
    const state = fixture();
    const check = checkFunds(state, calculateDashboard(state), { amount: 850, purpose: "Kaffeemaschine" }, asOf);
    expect(check.ok).toBe(true);
    expect(check.pay).toEqual([expect.objectContaining({ name: "Tagesgeld (Bank Austria)", amount: 850, after: 50 })]);
  });

  it("says not OK when only a restricted account would cover it", () => {
    const state = fixture();
    const check = checkFunds(state, calculateDashboard(state), { amount: 2000, purpose: "Fernseher" }, asOf);
    expect(check.ok).toBe(false);
    expect(check.missing).toBeCloseTo(1100);
    expect(check.blocked.join(" ")).toContain("Verrechnungskonto");
  });

  it("uses the restricted account for its own purpose", () => {
    const state = fixture();
    const result = executeTool(detectTool("Ölwechsel 120 € ok?")!, "Ölwechsel 120 € ok?", { state, dashboard: calculateDashboard(state), asOf });
    expect(result.text).toMatch(/^✅ OK/);
    expect(result.text).toContain("Verrechnungskonto");
  });

  it("routes questions and rules without opening a plan", () => {
    expect(detectTool("Kann ich mir eine Kaffeemaschine um 850 € leisten?")).toBe("funds");
    expect(detectTool("Ölwechsel 120 € ok?")).toBe("funds");
    expect(detectTool("geht sich ein service beim auto um 300 aus")).toBe("funds");
    expect(detectTool(teach)).toBe("account_rule");
    expect(detectTool("Notgroschen nicht angreifen")).toBe("account_rule");
  });
});
