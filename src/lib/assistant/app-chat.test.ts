import { describe, expect, it } from "vitest";
import { calculateDashboard } from "@/lib/calc";
import { addMonthsToDate, detectContracts } from "@/lib/contracts";
import { currency } from "@/lib/format";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { bonusRequest, contractDraftResult, executeTool } from "./agent";
import { confirmDraft, continueContractDraft, contractDraftOperation, leavesDraft, startContractDraft } from "./contract-draft";
import { undoChange } from "./operations";
import { fixedReply } from "./fixed-replies";
import { applyOperations } from "./operations";
import { detectTool, type AssistantTool } from "./tools";

const asOf = "2026-09-11";
let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"] = "Abonnements"): Transaction => ({
  id: `b${++counter}`, date, bank: "Raiffeisen", pocket: "Testkonto", description, amount, category, includeInPlan: true,
});
function fixture(): AppState {
  const monthly = (description: string, amount: number, start: string, category: Transaction["category"] = "Abonnements") =>
    [0, 1, 2].map((index) => row(addMonthsToDate(start, index), description, -amount, category));
  return appStateSchema.parse({
    ...createSeed(), financeRows: [{ id: "rent", label: "Miete", kind: "fixed", values: { "2026-09": 650 } }], merchantRules: [], fixedReceipts: [],
    fixedAmountDecisions: [], ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [],
    transactions: [...monthly("Streamflix Abo", 9.99, "2026-06-15"), ...monthly("Magenta Mobil", 25, "2026-06-20", "Telefon & Internet"),
      row("2026-08-24", "MediaMarkt Wien", -249, "Shopping"), row("2026-08-10", "Hotel Malaga", -300, "Urlaub"), row("2026-08-12", "Tapas Bar Malaga", -40, "Restaurants"),
      row("2026-08-02", "BILLA DANKT", -30, "Lebensmittel"), row("2026-08-09", "BILLA DANKT", -45, "Lebensmittel")],
  });
}
const run = (state: AppState, text: string, tool?: AssistantTool) => {
  const picked = tool ?? detectTool(text);
  expect(picked, text).toBeDefined();
  return executeTool(picked!, text, { state, dashboard: calculateDashboard(state), asOf });
};

describe("routing app actions", () => {
  it.each<[string, AssistantTool]>([
    ["Leg einen neuen Vertrag an", "contract_new"], ["Neues Abo: Disney+ 9,99 € im Monat", "contract_new"], ["Ich habe einen neuen Handyvertrag", "contract_new"],
    ["Netflix ist gekündigt zum 31.12.", "contract_edit"], ["Bestätige Streamflix", "contract_edit"], ["Spotify ist kein Vertrag", "contract_edit"],
    ["Kündigungsfrist von Magenta ist 3 Monate", "contract_edit"], ["Magenta hat 1 Monat Kündigungsfrist", "contract_edit"], ["Verwirf meine Änderungen an Spotify", "contract_edit"],
    ["Lösch die Buchung vom 24.8. über 249 €", "booking"], ["Tagge die Buchungen vom 10. bis 12.8. mit Malaga 2026", "booking"], ["Entferne den Tag Malaga 2026", "booking"],
    ["Füg eine Position Fitnessstudio hinzu", "edit"], ["Setz die Miete im Dezember auf 700 €", "edit"], ["Lösch die Kontoregel für Sparkonto", "account_rule"],
    ["Sparkonto ist für alle Ausgaben", "account_rule"], ["Setz den Successbonus auf 120 %", "payroll"],
    // Questions stay questions.
    ["Kündige Netflix", "cancel"], ["Wann läuft Netflix aus?", "contracts"], ["Welche Abos habe ich?", "contracts"],
    // Found in the chat test: spending questions, a new billing rhythm and sharing a booking.
    ["Wie viel gebe ich für Versicherungen aus?", "query"], ["Netflix wird ab Jänner jährlich abgerechnet", "contract_edit"],
    ["Teile die Buchung vom 24.8. mit Raphael", "booking"], ["Die MediaMarkt Buchung war nicht mit Raphael geteilt", "booking"], ["Was schuldet mir Raphael?", "shared"],
  ])("%s → %s", (text, tool) => expect(detectTool(text)).toBe(tool));
});

describe("contracts by chat", () => {
  it("creates a contract step by step like the wizard and saves only the confirmed preview", () => {
    const state = fixture();
    const id = "manual:test-1234";
    let draft = startContractDraft("Leg einen neuen Vertrag an", state, asOf, id);
    expect(contractDraftResult(state, draft, asOf)).toMatchObject({ text: expect.stringMatching(/Wie heißt er\?/), contractDraft: { step: "name" } });
    const answers: [string, string][] = [["Fitness Park", "amount"], ["39,90", "category"], ["Sport & Fitness", "notice"], ["1 Monat", "term"],
      ["Bis 31.3.2027", "interval"], ["Monatlich", "nextDate"], ["Am 1.10.2026", "preview"]];
    for (const [answer, step] of answers) {
      const next = continueContractDraft(draft, answer, state, asOf);
      expect(next.understood, answer).toBe(true);
      expect(next.draft.step, answer).toBe(step);
      draft = next.draft;
    }
    expect(continueContractDraft(draft, "blabla", state, asOf).understood).toBe(false);
    expect(confirmDraft("Ja")).toBe(true);
    expect(confirmDraft("Ja, aber nimm lieber Abonnements")).toBe(false);
    const result = contractDraftResult(state, draft, asOf);
    expect(result.text).toMatch(/^So würde ich „Fitness Park“ anlegen: 39,90/);
    expect(result.change?.diffs.map((diff) => diff.label)).toEqual(["Neuer Vertrag", "Fitness Park: nächste Abbuchung", "Fitness Park: Kategorie",
      "Fitness Park: Kündigungsfrist", "Fitness Park: Mindestlaufzeit bis"]);
    // Nothing is stored until the change is applied.
    expect(state.contracts ?? []).toEqual([]);
    const saved = applyOperations(state, result.change!.operations, { asOf }).state;
    expect(detectContracts(saved, asOf).find((contract) => contract.id === id)).toMatchObject({ name: "Fitness Park", amount: 39.9, status: "active", category: "Sport & Fitness" });
  });

  it("takes everything said at once and asks for the automatic assignment when bookings match", () => {
    const state = fixture();
    const draft = startContractDraft("Neues Abo: Streamflix Abo 9,99 € im Monat, Kategorie Abonnements", state, asOf, "manual:test-5678");
    expect(draft).toMatchObject({ step: "notice", name: "Streamflix Abo", amount: 9.99, interval: "monthly", category: "Abonnements" });
    let next = continueContractDraft(draft, "Keine", state, asOf).draft;
    next = continueContractDraft(next, "Keine Mindestlaufzeit", state, asOf).draft;
    next = continueContractDraft(next, "Am 15.9.2026", state, asOf).draft;
    expect(next.step).toBe("match");
    next = continueContractDraft(next, "Ja", state, asOf).draft;
    expect(contractDraftOperation(next)).toMatchObject({ op: "contract_create", match: { text: "Streamflix Abo" }, nextDate: "2026-09-15" });
  });

  it("changes, confirms and cancels detected contracts only after a preview", () => {
    const state = fixture();
    const cancelled = run(state, "Streamflix ist gekündigt zum 31.12.");
    expect(cancelled.change?.diffs).toEqual([{ label: "Streamflix Abo: Status", before: "Vorschlag", after: "gekündigt, endet 31.12.2026" }]);
    expect(run(state, "Kündigungsfrist von Magenta ist 3 Monate").change?.diffs.map((diff) => diff.after)).toEqual(["3 Monate", "bestätigt"]);
    expect(run(state, "Bestätige alle Vertragsvorschläge").change?.operations).toHaveLength(2);
    expect(run(state, "Ist kein Vertrag", "contract_edit")).toMatchObject({ choices: expect.arrayContaining(["Streamflix Abo ist kein Vertrag"]) });
    expect(run(state, "Lösch den Vertrag Streamflix").text).toMatch(/Entfernen geht nur bei selbst angelegten Verträgen/);
    // The cancellation letter offers to mark the contract as cancelled, with the date that was asked for.
    expect(run(state, "Kündige Streamflix zum 31.12.").suggestions?.[0]).toBe("Streamflix Abo ist gekündigt zum 31.12.");
    // Named without the word "Vertrag": the general edit finds the contract.
    expect(run(state, "Ändere den Streamflix Betrag auf 12,99 €", "edit").change?.title).toBe("Vertrag „Streamflix Abo“ ändern");
  });

  it("takes a minimum term as a duration", () => {
    const state = fixture();
    const draft = { ...startContractDraft("Neuer Vertrag Fitness Park 39 € monatlich", state, asOf, "manual:test-9"), step: "term" as const, notice: { value: 1, unit: "months" as const } };
    expect(continueContractDraft(draft, "12 Monate", state, asOf).draft.termEnd).toBe("2027-09-11");
    expect(continueContractDraft(draft, "2 Jahre", state, asOf).draft.termEnd).toBe("2028-09-11");
  });

  it("leaves an open draft for greetings, other topics and new questions, but not for short answers", () => {
    for (const text of ["Hallo", "Wie geht es dir?", "Was denkst du über die Politik in Österreich?", "Kannst du mir ein Rezept für Pizza geben?",
      "Was bleibt mir diesen Monat?", "Erzähl mir einen Witz"]) expect(leavesDraft(text), text).toBe(true);
    for (const text of ["Ja", "ok", "500 €", "bis Juni 2027", "Geht das bis Juni?", "keine Ahnung", "Urlaub in Japan"]) expect(leavesDraft(text), text).toBe(false);
    // While a name is asked for, any word may be the name.
    expect(leavesDraft("Musik Streaming", true)).toBe(false);
  });
});

describe("bookings, plan, accounts and payroll by chat", () => {
  it("deletes one clearly named booking and asks when several match", () => {
    const state = fixture();
    expect(run(state, "Lösch die Buchung vom 24.8. über 249 €").change?.operations).toEqual([{ op: "transaction_delete", ids: [state.transactions.find((item) => item.amount === -249)!.id] }]);
    const both = run(state, "Lösch die Buchung bei Billa");
    expect(both.change).toBeUndefined();
    expect(both.choices).toEqual([`Lösch die Buchung vom 9.8.2026 über ${currency(45)}`, `Lösch die Buchung vom 2.8.2026 über ${currency(30)}`]);
    expect(run(state, "Lösch die Buchung").text).toMatch(/^Welche Buchung soll ich löschen\?/);
  });

  it("tags a span of days and removes the tag again", () => {
    const state = fixture();
    const tagged = run(state, "Tagge die Buchungen vom 10. bis 12.8. mit Malaga 2026");
    expect(tagged.change?.operations).toEqual([expect.objectContaining({ op: "transaction_tag", tag: "Malaga 2026", ids: expect.any(Array) })]);
    const after = applyOperations(state, tagged.change!.operations, { asOf }).state;
    expect(after.transactions.filter((item) => item.tags?.includes("Malaga 2026")).map((item) => item.description).sort()).toEqual(["Hotel Malaga", "Tapas Bar Malaga"]);
    expect(run(after, "Entferne den Tag Malaga 2026").change?.diffs[0]).toMatchObject({ after: "entfernt" });
  });

  it("shares a booking with Raphael only after a preview, and explains that it cannot be unshared", () => {
    const state = fixture();
    const shared = run(state, "Teile die Buchung vom 24.8. mit Raphael");
    expect(shared.change?.diffs).toEqual([{ label: "1 Buchung: mit Raphael geteilt", before: "nein", after: "ja, du zahlst die Hälfte" }]);
    const applied = applyOperations(state, shared.change!.operations, { asOf });
    expect(applied.state.transactions.find((item) => item.amount === -249)?.sharedWithRaphael).toBe(true);
    const undone = undoChange({ ...applied.state, assistantChanges: [{ id: "c1", at: 1, title: "Teilen", summary: [], undo: applied.undo }] }, "c1");
    expect(undone.transactions.find((item) => item.amount === -249)?.sharedWithRaphael).toBeUndefined();
    expect(run(state, "Die MediaMarkt Buchung war nicht mit Raphael geteilt").text).toMatch(/nicht wieder auf ungeteilt/);
  });

  it("edits month-plan positions and values", () => {
    const state = fixture();
    // A budget line with a month is a value of that month, like editing the cell.
    expect(run(state, "Setz die Miete im Dezember auf 700 €", "budget_plan").change?.operations).toEqual([{ op: "plan_value", rowId: "rent", months: ["2026-12"], value: 700 }]);
    expect(run(state, "Setz die Miete im Dezember auf 700 €").change?.operations).toEqual([{ op: "plan_value", rowId: "rent", months: ["2026-12"], value: 700 }]);
    expect(run(state, "Füg eine Position Fitnessstudio hinzu").change?.diffs).toEqual([{ label: "Neue Position im Monatsplan", before: "–", after: "Fitnessstudio (Fixkosten)" }]);
    expect(run(state, "Lösch die Position Miete").change?.operations).toEqual([{ op: "plan_row_delete", rowId: "rent" }]);
    expect(run(state, "Lösch die Position Strom").text).toBe("Eine Position „Strom“ finde ich im Monatsplan nicht. Vorhanden sind „Miete“.");
  });

  it("asks before saving account rules and the successbonus", () => {
    const state = fixture();
    const ruled = { ...state, accountRules: [{ id: "r1", account: "Raiffeisen Giro", use: "any" as const, purposes: [], at: 1 }] };
    expect(run(ruled, "Lösch die Kontoregel für Girokonto").change?.operations).toEqual([{ op: "account_rule_delete", ruleId: "r1" }]);
    const missing = run(state, "Erhöhe das Sparziel Urlaub in Japan auf 3500 €", "edit");
    expect(missing.change).toBeUndefined();
    expect(missing.text).toMatch(/^Ein Sparziel „Urlaub in Japan“ finde ich nicht/);
    expect(run(state, "Sparkonto ist für alle Ausgaben").change?.diffs).toEqual([{ label: "Konto Sparkonto", before: "keine Regel", after: "für alle Ausgaben" }]);
    expect(state.accountRules ?? []).toEqual([]);
    expect(bonusRequest("Setz den Successbonus auf 120 %")).toBe(120);
    expect(bonusRequest("Schalte den Successbonus aus")).toBe(0);
    expect(bonusRequest("Wie hoch ist mein Successbonus?")).toBeUndefined();
    expect(run(state, "Setz den Successbonus auf 120 %").change?.operations).toEqual([{ op: "bonus_percent", value: 120 }]);
  });

  it("points to the page for logins, files and browser permissions", () => {
    for (const text of ["Verbinde mein Revolut-Konto", "Trenn die Verbindung zu Google Drive", "Lade meine Lohnabrechnung hoch", "Aktivier die Benachrichtigungen", "Mach ein Backup"])
      expect(fixedReply(text)?.card?.page?.href, text).toMatch(/^\/(?:einstellungen|umsaetze)$/);
    expect(fixedReply("Wie verbinde ich mein Bankkonto?")).toBeUndefined();
  });
});
