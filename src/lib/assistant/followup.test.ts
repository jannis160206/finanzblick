import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { currency } from "@/lib/format";
import type { AppState, Transaction } from "@/lib/types";
import { executeTool } from "./agent";
import { compareSelection, findPeriod, monthsIn, queryMetric, weeklyBriefing } from "./answers";
import { isFollowUp, resolveFollowUp, resolvePronoun } from "./followup";
import { detectTool } from "./tools";

const asOf = "2026-11-05";
const row = (id: string, date: string, bank: string, description: string, amount: number, category: Transaction["category"]): Transaction =>
  ({ id, date, bank, pocket: bank === "Amex" ? "AMEX Jannis" : "Raiffeisen Giro", description, amount, category, includeInPlan: true });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.transactions = [
    row("o1", "2026-10-03", "Raiffeisen", "BILLA", -80, "Lebensmittel"),
    row("o2", "2026-10-10", "Amex", "PIZZERIA", -60, "Restaurants"),
    row("o3", "2026-10-12", "Raiffeisen", "MEDIAMARKT", -300, "Shopping"),
    row("s1", "2026-09-04", "Raiffeisen", "BILLA", -50, "Lebensmittel"),
    row("s2", "2026-09-20", "Amex", "PIZZERIA", -20, "Restaurants"),
    row("a1", "2026-08-08", "Amex", "PIZZERIA", -45, "Restaurants"),
  ];
  return state;
}

// Runs a chat the way the client does: follow-ups reuse the earlier questions.
function chat(state: AppState, texts: string[]) {
  const dashboard = calculateDashboard(state);
  const users: string[] = [];
  return texts.map((text) => {
    const follow = resolveFollowUp(text, users);
    const tool = follow?.tool ?? detectTool(text);
    users.push(text);
    return { tool, follow: Boolean(follow), ...executeTool(tool!, text, { state, dashboard, asOf, previous: follow?.previous }) };
  });
}

describe("follow-up questions", () => {
  it("recognises short add-on questions only", () => {
    for (const text of ["und im September?", "Und mit Amex?", "was ist mit Restaurants?", "wie schaut es im August aus?", "warum so viel?", "Mehr als im Vormonat?"])
      expect(isFollowUp(text), text).toBe(true);
    for (const text of ["Wie viel hab ich im Oktober ausgegeben?", "und 500 € fürs Auto bitte", "Ich will bis Juli 2027 3.000 € für Japan sparen"])
      expect(isFollowUp(text), text).toBe(false);
  });

  it("keeps category, bank and month across a chain", () => {
    const [first, september, amex, compare, why] = chat(fixture(), [
      "Wie viel hab ich im Oktober fürs Essen ausgegeben?", "und im September?", "und mit Amex?", "Mehr als im Vormonat?", "warum so viel?"]);
    expect(first).toMatchObject({ tool: "query", follow: false, card: { total: 140 } });
    expect(september).toMatchObject({ follow: true, card: { title: "Essen · September 2026", total: 70 } });
    expect(amex).toMatchObject({ card: { title: "Amex · Essen · September 2026", total: 20 } });
    expect(compare.card).toMatchObject({ title: "Vergleich · Amex · Essen · September 2026 vs August 2026", total: -25 });
    expect(compare.text).toContain(`${currency(25)} weniger als im August 2026`);
    expect(why.card).toMatchObject({ title: "Größte Ausgaben · September 2026", total: 20 });
  });

  it("does not hijack new requests or start without a base question", () => {
    expect(resolveFollowUp("und im September?", [])).toBeUndefined();
    expect(resolveFollowUp("und im September?", ["Ich will 3.000 € für Japan sparen"])).toBeUndefined();
    expect(resolveFollowUp("und was bleibt mir diesen Monat?", ["Wie viel ging im Oktober weg?"])).toBeUndefined();
    expect(resolveFollowUp("und im Dezember?", ["Was bleibt mir diesen Monat übrig?"])).toMatchObject({ tool: "budget" });
  });
});

describe("references to the previous answer", () => {
  it("keeps 'davon' with the contracts and names the contract for 'Kündige das'", () => {
    expect(resolveFollowUp("Was davon ist am teuersten?", ["Welche Abos habe ich?"])).toEqual({ tool: "contracts", previous: ["Welche Abos habe ich?"] });
    expect(resolvePronoun("Kündige das", { kind: "contracts", title: "Magenta Mobil" })).toBe("Kündige Magenta Mobil");
    expect(resolvePronoun("Kündige das", { kind: "cancel", title: "Kündigungshilfe · Spotify AB" })).toBe("Kündige Spotify AB");
    expect(resolvePronoun("Kündige das", { kind: "contracts", title: "Verträge & Abos" })).toBe("Kündige das");
    expect(resolvePronoun("Kündige das", { kind: "answer", title: "Gehalt · September 2026" })).toBe("Kündige das");
  });
});

describe("month comparison", () => {
  it("routes and selects the months in reading order", () => {
    for (const text of ["Vergleich Oktober mit September", "Hab ich im Oktober mehr ausgegeben als im September?", "Oktober vs September Ausgaben", "Ausgaben diesen Monat verglichen mit dem Vormonat"])
      expect([text, detectTool(text), queryMetric(text)]).toEqual([text, "query", "compare"]);
    expect(monthsIn("Vergleich Oktober mit September", asOf).map((item) => item.month)).toEqual(["2026-10", "2026-09"]);
    expect(compareSelection("Wie viel mehr als im Vormonat?", asOf, []).map((item) => item.month)).toEqual(["2026-11", "2026-10"]);
    expect(compareSelection("mehr als im August?", asOf, ["Wie viel im Oktober?"]).map((item) => item.month)).toEqual(["2026-10", "2026-08"]);
    expect(detectTool("Vergleich die Sparziel-Varianten 200 vs 300 €")).not.toBe("query");
  });

  it("explains the difference with the biggest change", () => {
    const [result] = chat(fixture(), ["Vergleich Oktober mit September"]);
    expect(result.card).toMatchObject({ total: 370 });
    expect(result.card?.lines.slice(0, 3)).toMatchObject([{ label: "Oktober 2026", value: 440 }, { label: "September 2026", value: 70 }, { label: "Shopping", value: 300 }]);
    expect(result.text).toBe(`Im Oktober 2026 hast du ${currency(440)} ausgegeben, ${currency(370)} mehr als im September 2026 (${currency(70)}). Am meisten dazu kam bei Shopping (+${currency(300)}).`);
  });
});

describe("periods and coach routing", () => {
  it("finds explicit periods only", () => {
    expect(findPeriod("Wie viel fürs Essen?", asOf)).toBeUndefined();
    expect(findPeriod("Was hab ich heuer ausgegeben?", asOf)).toMatchObject({ from: "2026-01-01", to: asOf });
  });

  it("sends cutting questions to the coach", () => {
    for (const text of ["Wo könnte ich kürzen?", "Wo spare ich am besten?", "Wo sollte ich am ehesten ansetzen?"]) expect(detectTool(text), text).toBe("coach");
  });
});

describe("weekly briefing warnings", () => {
  it("mentions an open Amex transfer and a negative month", () => {
    const state = fixture();
    const dashboard = calculateDashboard(state);
    const briefing = weeklyBriefing(state, { ...dashboard, amex: { ...dashboard.amex, shortfall: 210, outstanding: 400, reserved: 190 },
      current: { ...dashboard.current, surplus: -55 } }, asOf);
    expect(briefing.text).toContain(`für die Amex fehlen noch ${currency(210)}`);
    expect(briefing.text).toContain(`der Monat liegt ${currency(55)} im Minus`);
    expect(briefing.card.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Noch auf Amex-Rückzahlung überweisen", value: 210, tone: "warn" }),
      expect.objectContaining({ value: -55, tone: "bad" })]));
  });
});
