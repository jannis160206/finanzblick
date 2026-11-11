import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { savingsGoals } from "@/lib/goals";
import { plannedOneOffSchema, savingsGoalSchema, type AppState } from "@/lib/types";
import { executeTool, parseMemory, parseRule } from "./agent";
import { mergeDraft, parseAssistantMessage } from "./intent";
import { extractMemories } from "./memory";
import { normalizeMessage } from "./normalize";
import { applyOperations } from "./operations";
import { detectTool } from "./tools";

const asOf = "2026-10-07";
const names = ["Japan", "Pickerl"];
function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = asOf;
  state.savingsGoals = [savingsGoalSchema.parse({ id: "japan", name: "Japan", pocket: "Japan", target: 3000, date: "2027-07-31", funding: { monthly: 250, extras: {} } })];
  state.plannedOneOffs = [plannedOneOffSchema.parse({ id: "pickerl", name: "Pickerl", date: "2027-03-01", amount: 400, installments: 1, pocket: "Giro" })];
  return state;
}
const context = (state: AppState) => ({ state, dashboard: calculateDashboard(state), asOf });
const draftOf = (text: string) => mergeDraft(undefined, parseAssistantMessage(text, asOf), {}, text, asOf);

describe("casual phrasing", () => {
  it("normalizes slang, ascii umlauts, abbreviations and short numbers", () => {
    expect(normalizeMessage("wv hab ich im okt fuer essen bezahlt")).toBe("wie viel hab ich im oktober für essen bezahlt");
    expect(normalizeMessage("Japan Reise 3k bis Juli 27, 500 hab ich schon")).toBe("Japan Reise 3000 bis Juli 2027, 500 hab ich schon");
    expect(normalizeMessage("kann ich mir nen tv kaufen")).toBe("kann ich mir einen Fernseher kaufen");
    expect(normalizeMessage("how much did I spend on food in October")).toBe("how much did I spend on food in Oktober");
    expect(normalizeMessage("how much may I spend")).toBe("how much may I spend");
    expect(normalizeMessage("lieferando = lieferdienste")).toBe("lieferando ist immer lieferdienste");
    expect(normalizeMessage("Im Mai 25 € mehr")).toBe("Im Mai 25 € mehr");
    const once = normalizeMessage("wieviel kohle ist im okt. fuers essen draufgegangen, 1,5k?");
    expect(normalizeMessage(once)).toBe(once);
  });

  const cases: [string, string][] = [
    ["wieviel kohle ist im oktober fürs essen draufgegangen", "query"], ["essen oktober wie viel", "query"], ["Ausgaben Essen Oktober?", "query"],
    ["wie viel geld hab ich letzten monat beim essen gelassen", "query"], ["was hat mich essen im oktober gekostet", "query"],
    ["wv hab ich im okt für lebensmittel bezahlt", "query"], ["was kosten mich meine abos", "query"], ["wo geht mein geld hin", "query"],
    ["was hab ich für die versicherung bezahlt", "query"],
    ["möchte bis juli 2027 3000€ für japan zurücklegen, hab schon 500 am sparkonto", "savings_goal"],
    ["Japan Reise 3k bis Juli 27, 500 hab ich schon", "savings_goal"], ["spar mir 3000 euro für japan an bis 07/2027", "savings_goal"],
    ["neues sparziel japan 3000 bis juli 2027", "savings_goal"], ["ich brauche bis juli 2027 3000 € für japan", "savings_goal"],
    ["für ein auto will ich bis dezember 2027 2000 € zur seite legen, die ersten zwei monate je 60 vom sparkonto", "savings_goal"],
    ["geht sich im mai ein fernseher um 900 aus?", "funds"], ["kann ich mir im mai nen tv für 900€ kaufen", "funds"],
    ["ist ein 900 € fernseher im mai drin?", "funds"], ["reicht mein geld im mai für einen fernseher um 900", "funds"],
    ["Fernseher 900 € im Mai, leistbar?", "funds"],
    ["japan auf 4000 hoch", "edit"], ["mach japan 4000", "edit"], ["japan ziel 4000 €", "edit"], ["japan soll 4000 sein", "edit"], ["stell japan auf 4k", "edit"],
    ["gib japan 3 monate lang je 50 extra aus dem notgroschen", "edit"], ["pickerl erst im april", "edit"],
    ["hilf mir 200 € im monat einzusparen", "coach"], ["wo kann ich 200 euro sparen", "coach"], ["ich möchte jeden monat 200 mehr übrig haben", "coach"],
    ["lieferando gehört zu lieferdienste", "rule"], ["lieferando = lieferdienste", "rule"], ["mach lieferando zu lieferdienste", "rule"],
    ["lieferando soll unter lieferdienste laufen", "rule"], ["Spar ist immer Lebensmittel", "rule"],
    ["lass immer 500 € als reserve übrig", "remember"], ["ich krieg mein gehalt am 25.", "remember"],
    ["100 im monat anlegen 10 jahre was kommt raus", "depot"], ["was kann ich von der steuer absetzen", "tax"],
    ["home office sachen steuer zurück", "homeoffice"], ["was geht alles im dashboard", "explain"], ["wie läuft das mit den sparzielen", "explain"],
    ["nimm das zurück", "undo"], ["was weisst du ueber mich", "memory"],
  ];
  it.each(cases)("%s → %s", (text, tool) => expect(detectTool(text, names)).toBe(tool));

  it("fills goal and affordability drafts from casual messages", () => {
    expect(draftOf("Japan Reise 3k bis Juli 27, 500 hab ich schon")).toMatchObject({ action: "savings_goal", name: "Japan", amount: 3000, date: "2027-07-31", startCapital: 500 });
    expect(draftOf("neues sparziel japan 3000 bis juli 2027")).toMatchObject({ name: "Japan", amount: 3000 });
    expect(draftOf("für ein auto will ich bis dezember 2027 2000 € zur seite legen, die ersten zwei monate je 60 vom sparkonto"))
      .toMatchObject({ name: "Auto", amount: 2000, extra: { amount: 60, months: 2, from: "Sparkonto" } });
    for (const text of ["ist ein 900 € fernseher im mai drin?", "kann ich mir im mai nen tv für 900€ kaufen", "geht sich im mai ein fernseher um 900 aus?"])
      expect(draftOf(text)).toMatchObject({ action: "affordability", name: "Fernseher", amount: 900, date: "2027-05-01" });
  });

  it("executes short commands on existing items", () => {
    const state = fixture();
    for (const text of ["mach japan 4000", "japan soll 4000 sein", "stell japan auf 4k"]) {
      const preview = executeTool("edit", text, context(state));
      expect(savingsGoals(applyOperations(state, preview.change!.operations, { asOf }).state)[0].target).toBe(4000);
    }
    const moved = executeTool("edit", "pickerl erst im april", context(state));
    expect(applyOperations(state, moved.change!.operations, { asOf }).state.plannedOneOffs?.[0].date.slice(0, 7)).toBe("2027-04");
    expect(parseRule("mach lieferando zu lieferdienste")).toEqual({ merchant: "lieferando", category: "lieferdienste" });
    expect(parseRule("lieferando soll unter lieferdienste laufen")).toEqual({ merchant: "lieferando", category: "lieferdienste" });
    expect(parseMemory("lass immer 500 € als reserve übrig")).toMatchObject({ key: "buffer", value: 500 });
    expect(parseMemory("ich krieg mein gehalt am 25.")).toMatchObject({ key: "salaryDay", value: 25 });
  });
});

describe("automatic memory", () => {
  it("keeps lasting facts from any message", () => {
    const state = fixture();
    expect(extractMemories("Kann ich mir im Mai einen Fernseher um 900 € leisten? Mein Gehalt kommt immer am 25.", state, "affordability"))
      .toEqual([expect.objectContaining({ key: "salaryDay", value: 25 })]);
    expect(extractMemories("Ich will nie unter 500 € kommen", state)).toEqual([expect.objectContaining({ key: "buffer", value: 500 })]);
    expect(extractMemories("Ich wohne in Wien und teile mir die Miete mit Raphael.", state)).toEqual([expect.objectContaining({ key: "note", text: "Ich wohne in Wien und teile mir die Miete mit Raphael" })]);
    expect(extractMemories("Meine Miete ist 650 € warm", state)).toEqual([expect.objectContaining({ key: "note" })]);
  });

  it("ignores questions, plans, one-off events and known facts", () => {
    const state = fixture();
    for (const text of ["Wie viel hab ich im Oktober fürs Essen ausgegeben?", "Ich will bis Juli 2027 3.000 € für Japan sparen, 500 € liegen schon am Sparkonto.",
      "Kann ich mir im Mai einen Fernseher um 900 € leisten?", "Erhöhe Japan auf 4.000 €", "Ich will 200 € mehr im Monat sparen.", "Ich habe gestern 50 € bei Spar bezahlt",
      "Ich bekomme im Mai 500 € Bonus", "mach japan 4000", "Lieferando ist immer Lieferdienste", "Ich brauche bis Dezember 2.000 €",
      "Ich bin gestresst wegen Geld", "Ich bin echt überfordert mit meinen Finanzen"])
      expect(extractMemories(text, state), text).toEqual([]);
    expect(extractMemories("Merk dir: Puffer immer 500 €", state, "remember")).toEqual([]);
    const known = applyOperations(state, [{ op: "memory_add", key: "salaryDay", value: 25, text: "Gehalt kommt am 25." },
      { op: "memory_add", key: "note", text: "Ich wohne in Wien" }], { asOf }).state;
    expect(extractMemories("Mein Gehalt kommt am 25. Ich wohne in Wien.", known)).toEqual([]);
  });
});
