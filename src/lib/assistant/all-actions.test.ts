import { describe, expect, it } from "vitest";
import { calculateDashboard } from "@/lib/calc";
import { detectContracts } from "@/lib/contracts";
import { savingsGoals } from "@/lib/goals";
import { queueLedgerReview } from "@/lib/import/review";
import { heldPayslips } from "@/lib/payroll-budget";
import { synchronizePlan } from "@/lib/planning";
import { appStateSchema, type AppState, type ContractDraft, type Transaction } from "@/lib/types";
import { defaultBudgetAmount, variableBudgetLines, type VariableBudgetId } from "@/lib/variable-budgets";
import { payrollEmployer, payrollFixture } from "../../../tests/fixtures/payroll-state";
import { executeTool, type AgentResult } from "./agent";
import { splitQuestion } from "./combined";
import { continueContractDraft, contractDraftOperation } from "./contract-draft";
import { fixedReply, type FixedReply } from "./fixed-replies";
import { mergeDraft, missingField, parseAssistantMessage } from "./intent";
import { applyOperations, recordChange, undoChange } from "./operations";
import { detectTool, type AssistantTool } from "./tools";

/**
 * Every manual action of the app said in many ways: routed, previewed, applied to the data and undone again.
 * The state is a small household with subscriptions, a manual contract, a savings goal and payslips.
 */
const asOf = "2026-11-11";
let counter = 0;
const booking = (date: string, description: string, amount: number, category: Transaction["category"]): Transaction =>
  ({ id: `m-${++counter}`, date, bank: "Raiffeisen", pocket: "Girokonto", description, amount, category, includeInPlan: true, reviewed: true });

function world(extra: Partial<AppState> = {}): AppState {
  const state = payrollFixture() as AppState;
  const monthly = ["07", "08", "09", "10"].flatMap((month, index) => [
    booking(`2026-${month}-05`, "NETFLIX.COM", -13.99, "Abonnements"), booking(`2026-${month}-12`, "Spotify AB", -10.99, "Abonnements"),
    booking(`2026-${month}-20`, "Magenta Mobil", -25, "Telefon & Internet"), booking(`2026-${month}-03`, "FITINN Fitnessstudio", -24.9, "Sport & Fitness"),
    booking(`2026-${month}-08`, "BILLA DANKT 1234", -(52 + index * 7), "Lebensmittel"), booking(`2026-${month}-10`, "SHELL 1234 WIEN", -(58 + index), "Tanken"),
  ]);
  const single = [booking("2026-10-24", "MediaMarkt Wien", -249, "Shopping"), booking("2026-10-11", "Pizzeria Da Mario", -38, "Restaurants"),
    booking("2026-10-14", "AMAZON EU SARL", -89.9, "Shopping"), booking("2026-10-02", "Disney Plus", -9.99, "Abonnements"),
    booking("2026-10-18", "Lieferando.at", -27, "Lieferdienste")];
  return settle(appStateSchema.parse({
    ...state, transactions: [...(state.transactions ?? []), ...monthly, ...single],
    financeRows: [...state.financeRows, { id: "trip", label: "Urlaub", kind: "fixed", values: { "2026-12": 100 } },
      { id: "power", label: "Strom", kind: "fixed", values: { "2026-11": 60, "2026-12": 60, "2027-01": 60 } }],
    contracts: [{ id: "manual:hausrat", manual: true, name: "Hausratversicherung", amount: 12, interval: "monthly", nextDate: "2026-12-01", category: "Versicherungen", updatedAt: 1 }],
    settings: { ...state.settings, asOf }, ...extra,
  }));
}
// What the app's provider does after every update: review queue and month plan (budget lines) are brought up to date.
const settle = (state: AppState) => appStateSchema.parse(synchronizePlan(queueLedgerReview(state)));

const base = world();
// A payslip whose numbers contradict each other stays out of the budget until it is confirmed.
const held = world({ payslips: (base.payslips ?? []).map((entry) => entry.year === 2026 && entry.month === 9 && entry.employer === payrollEmployer ? { ...entry, netPay: 99_999 } : entry) });

const names = (state: AppState) => [...savingsGoals(state).map((goal) => goal.name), ...(state.plannedOneOffs ?? []).map((item) => item.name)];
const ask = (state: AppState, text: string): { tool?: AssistantTool; result?: AgentResult } => {
  const tool = detectTool(text, names(state));
  return { tool, result: tool ? executeTool(tool, text, { state, dashboard: calculateDashboard(state), asOf }) : undefined };
};
// Undo restores the content; empty lists, booking order and the pinned pocket balances of goal edits may differ in form.
function comparable(state: AppState) {
  const { assistantChanges: _log, pocketOpeningBalances: _pinned, ...rest } = state;
  void _log; void _pinned;
  const plain = JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(plain)) if (value && typeof value === "object" && !Object.keys(value).length) delete plain[key];
  plain.transactions = [...state.transactions].sort((a, b) => a.id.localeCompare(b.id)).map((row) => JSON.parse(JSON.stringify(row)));
  return plain;
}

let logs = 0;
/** Applies the previewed change like the confirm button, checks the result is valid data and that undo restores the state. */
function confirm(state: AppState, text: string): AppState {
  const { tool, result } = ask(state, text);
  expect(result?.change, `${text} → ${tool}: ${result?.text}`).toBeDefined();
  const applied = applyOperations(state, result!.change!.operations, { asOf, now: 1_800_000_000_000, id: () => "rule-1" });
  const logId = `log-${++logs}`;
  const logged = settle(recordChange(state, applied, { id: logId, at: 1, title: result!.change!.title }));
  const undone = comparable(settle(undoChange(logged, logId, 2))), before = comparable(state);
  const differs = [...new Set([...Object.keys(undone), ...Object.keys(before)])].filter((key) => JSON.stringify(undone[key]) !== JSON.stringify(before[key]))
    .map((key) => `${key}: ${JSON.stringify(before[key])?.slice(0, 400)} => ${JSON.stringify(undone[key])?.slice(0, 400)}`);
  expect(differs, `${text}: undo`).toEqual([]);
  return logged;
}

const contract = (state: AppState, pattern: RegExp) => detectContracts(state, asOf).find((item) => pattern.test(item.name));
const rowsOf = (state: AppState, pattern: RegExp) => state.transactions.filter((row) => pattern.test(row.description));
const one = (state: AppState, pattern: RegExp) => rowsOf(state, pattern)[0];
const goal = (state: AppState) => savingsGoals(state).find((item) => item.id === savingsGoals(base).find((entry) => /motorrad/i.test(entry.name))!.id);
const budget = (state: AppState, id: VariableBudgetId) =>
  Math.max(0, defaultBudgetAmount(variableBudgetLines.find((line) => line.id === id)!, "2026-11", state.holidayRanges ?? []) + (state.budgetAdjustments?.[id] ?? 0));
const planRow = (state: AppState, label: string) => state.financeRows.find((row) => row.label === label);

type Expectation = {
  tool?: AssistantTool;
  change?: (next: AppState, before: AppState) => void;
  reply?: RegExp;
  choices?: boolean;
  draft?: (draft: ContractDraft) => void;
  fixed?: (reply: FixedReply) => void;
  on?: AppState;
};
const changes = (check: Expectation["change"], tool?: AssistantTool): Expectation => ({ change: check, tool });
const says = (reply: RegExp, tool?: AssistantTool): Expectation => ({ reply, tool });

function verify(text: string, expected: Expectation) {
  const state = expected.on ?? base;
  if (expected.fixed) {
    const reply = fixedReply(text);
    expect(reply, text).toBeDefined();
    expected.fixed(reply!);
    return;
  }
  const { tool, result } = ask(state, text);
  if (expected.tool) expect(tool, text).toBe(expected.tool);
  if (expected.change) {
    const next = confirm(state, text);
    expected.change(next, state);
    return;
  }
  expect(result, `${text} → ${tool}`).toBeDefined();
  expect(result!.change, `${text} must not change anything: ${result!.change?.title}`).toBeUndefined();
  if (expected.reply) expect(result!.text, text).toMatch(expected.reply);
  if (expected.choices) expect(result!.choices?.length, `${text}: ${result!.text}`).toBeGreaterThan(0);
  if (expected.draft) {
    expect(result!.contractDraft, `${text}: ${result!.text}`).toBeDefined();
    expected.draft(result!.contractDraft!);
  }
}

const contractCases: [string, Expectation][] = [
  ["lösche den Netflix-Vertrag", { ...changes((next) => expect(contract(next, /netflix/i)?.status).toBe("ignored"), "contract_edit"), reply: undefined }],
  ["lösch ma den netflix vertrag", changes((next) => expect(contract(next, /netflix/i)?.status).toBe("ignored"))],
  ["Netflix ist kein Vertrag", changes((next) => expect(contract(next, /netflix/i)?.status).toBe("ignored"))],
  ["Spotify ist kein Abo", changes((next) => expect(contract(next, /spotify/i)?.status).toBe("ignored"))],
  ["entferne Spotify aus meinen Verträgen", changes((next) => expect(contract(next, /spotify/i)?.status).toBe("ignored"))],
  ["lösch den Vertrag Hausratversicherung", changes((next) => expect(contract(next, /hausrat/i)).toBeUndefined())],
  ["Entferne die Hausratversicherung", changes((next) => expect(contract(next, /hausrat/i)).toBeUndefined())],
  ["Spotify ist gekündigt", changes((next) => expect(contract(next, /spotify/i)?.status).toBe("cancelled"))],
  ["markier FITINN als gekündigt zum 31.1.2027", changes((next) => expect(contract(next, /fitinn/i)).toMatchObject({ status: "cancelled" }))],
  ["Netflix wurde zum 31.12. gekündigt", changes((next) => expect(contract(next, /netflix/i)?.status).toBe("cancelled"))],
  ["ich hab fitinn gekündigt", changes((next) => expect(contract(next, /fitinn/i)?.status).toBe("cancelled"))],
  ["ändere den Netflix Betrag auf 15,99 €", changes((next) => expect(contract(next, /netflix/i)?.amount).toBe(15.99))],
  ["netflix kostet jetzt 17,99", changes((next) => expect(contract(next, /netflix/i)?.amount).toBe(17.99))],
  ["Spotify kostet ab jetzt 12,99 €", changes((next) => expect(contract(next, /spotify/i)?.amount).toBe(12.99))],
  ["Spotify wird ab jetzt jährlich abgerechnet", changes((next) => expect(contract(next, /spotify/i)?.interval).toBe("yearly"))],
  ["stell das Intervall von Netflix auf jährlich", changes((next) => expect(contract(next, /netflix/i)?.interval).toBe("yearly"))],
  ["Hausratversicherung ist vierteljährlich", changes((next) => expect(contract(next, /hausrat/i)?.interval).toBe("quarterly"))],
  ["FITINN zahle ich jetzt vierteljährlich", changes((next) => expect(contract(next, /fitinn/i)?.interval).toBe("quarterly"))],
  ["die kündigungsfrist von fitinn ist 3 monate", changes((next) => expect(contract(next, /fitinn/i)?.notice).toEqual({ value: 3, unit: "months" }))],
  ["FITINN hat 1 Monat Kündigungsfrist", changes((next) => expect(contract(next, /fitinn/i)?.notice).toEqual({ value: 1, unit: "months" }))],
  ["Notiz zum Netflix Vertrag: Familienabo mit Lisa", changes((next) => expect(contract(next, /netflix/i)?.note).toBe("Familienabo mit Lisa"))],
  ["nächste Abbuchung von Spotify ist am 12.12.", changes((next) => expect(contract(next, /spotify/i)?.nextDate).toBe("2026-12-12"))],
  ["Vertrag Netflix Kategorie Unterhaltung", changes((next) => expect(contract(next, /netflix/i)?.category).toBe("Entertainment"))],
  ["Mindestlaufzeit von FITINN bis 31.12.2027", changes((next) => expect(contract(next, /fitinn/i)?.termEnd).toBe("2027-12-31"))],
  ["Bestätige Netflix", changes((next) => expect(contract(next, /netflix/i)?.status).toBe("active"))],
  ["bestätige alle verträge", changes((next) => expect(detectContracts(next, asOf).filter((item) => item.status === "review")).toHaveLength(0))],
  ["Benenne den Vertrag Hausratversicherung in Haushaltsversicherung um", changes((next) => expect(contract(next, /haushaltsversicherung/i)).toBeDefined())],
  ["Die Amazon Buchung vom 14.10. gehört zum Vertrag Hausratversicherung",
    changes((next) => expect(contract(next, /hausrat/i)?.charges.map((charge) => charge.id)).toContain(one(next, /AMAZON/).id))],
  ["Verknüpfe die MediaMarkt Buchung mit dem Hausrat Vertrag",
    changes((next) => expect(contract(next, /hausrat/i)?.charges.map((charge) => charge.id)).toContain(one(next, /MediaMarkt/).id))],
  ["nimm die Buchung vom 5.10. aus dem Netflix-Vertrag",
    changes((next) => expect(contract(next, /netflix/i)?.charges.map((charge) => charge.id)).not.toContain(rowsOf(next, /NETFLIX/).find((row) => row.date === "2026-10-05")!.id))],
  ["Ordne die Buchung vom 2.10. dem Vertrag Disney Plus zu", { reply: /gibt es noch nicht/, choices: true }],
  ["Lösche den Vertrag Gibtsnicht", says(/„Gibtsnicht“ finde ich nicht/)],
  ["kündige Spotify zum 31.12.", { tool: "cancel", reply: /Spotify/ }],
  ["mach den fitinn vertrag weg", changes((next) => expect(contract(next, /fitinn/i)?.status).toBe("ignored"))],
  ["netflix is gekündigt", changes((next) => expect(contract(next, /netflix/i)?.status).toBe("cancelled"), "contract_edit")],
  ["Mach aus Spotify einen jährlichen Vertrag", changes((next) => expect(contract(next, /spotify/i)?.interval).toBe("yearly"))],
  ["Verknüpf die Disney Buchung mit Netflix", changes((next) => expect(contract(next, /netflix/i)?.charges.map((charge) => charge.id)).toContain(one(next, /Disney/).id))],
  ["spotfy kostet jetz 12,99", { choices: true, tool: "contract_edit" }],
  ["kannst du verträge löschen?", { tool: "help" }],
  ["Das monatliche Netflix-Abo ist gekündigt", changes((next) => expect(contract(next, /netflix/i)?.status).toBe("cancelled"))],
  ["Mein Jahresabo bei Spotify ist gekündigt", changes((next) => expect(contract(next, /spotify/i)).toMatchObject({ status: "cancelled", interval: "monthly" }))],
  ["Nimm die Disney Buchung vom 2.10. in den Netflix-Vertrag auf", changes((next) => expect(contract(next, /netflix/i)?.charges.map((charge) => charge.id)).toContain(one(next, /Disney/).id))],
  ["FITINN ist wieder aktiv", says(/nicht gekündigt/)],
];

const draftCases: [string, Expectation][] = [
  ["Leg einen neuen Vertrag an", { tool: "contract_new", draft: (draft) => expect(draft.step).toBe("name") }],
  ["ich will einen Vertrag anlegen", { tool: "contract_new", draft: (draft) => expect(draft.step).toBe("name") }],
  ["erstelle vertrag", { tool: "contract_new", draft: (draft) => expect(draft.step).toBe("name") }],
  ["neuer vertrag disney plus 9,99 monatlich", { draft: (draft) => expect(draft).toMatchObject({ name: "Disney Plus", amount: 9.99, interval: "monthly" }) }],
  ["mach mir einen Vertrag für Netflix", { draft: (draft) => expect(draft).toMatchObject({ name: "Netflix", step: "amount" }) }],
  ["Neues Abo: Disney+ 9,99 € im Monat", { draft: (draft) => expect(draft).toMatchObject({ name: "Disney+", amount: 9.99, interval: "monthly" }) }],
  ["neuer Vertrag für Spotify, 10,99 im Monat", { draft: (draft) => expect(draft).toMatchObject({ name: "Spotify", amount: 10.99 }) }],
  ["Trag meinen Handyvertrag bei A1 ein", { draft: (draft) => expect(draft.name).toBe("Handyvertrag A1") }],
  ["Markiere die Disney Plus Buchung als Vertrag", { tool: "contract_new",
    draft: (draft) => expect(draft).toMatchObject({ name: "Disney Plus", amount: 9.99, bookingIds: [one(base, /Disney/).id] }) }],
  ["Mach aus der Amazon Buchung einen Vertrag", { draft: (draft) => expect(draft.bookingIds).toEqual([one(base, /AMAZON/).id]) }],
  ["die mediamarkt buchung ist ein vertrag", { draft: (draft) => expect(draft.bookingIds).toEqual([one(base, /MediaMarkt/).id]) }],
  ["Markiere die Netflix Buchung als Vertrag", says(/schon zum Vertrag/)],
];

const bookingCases: [string, Expectation][] = [
  ["Lösche die Buchung MediaMarkt vom 24.10.", changes((next) => expect(rowsOf(next, /MediaMarkt/)).toHaveLength(0), "booking")],
  ["lösch die pizzeria buchung", changes((next) => expect(rowsOf(next, /Pizzeria/)).toHaveLength(0))],
  ["die buchung vom 24.10. über 249 € löschen", changes((next) => expect(rowsOf(next, /MediaMarkt/)).toHaveLength(0))],
  ["kannst du die mediamarkt buchung löschen?", changes((next) => expect(rowsOf(next, /MediaMarkt/)).toHaveLength(0))],
  ["Lösch alle Netflix Buchungen", changes((next) => expect(rowsOf(next, /NETFLIX/)).toHaveLength(0))],
  ["Lösch die Netflix Buchungen", { choices: true }],
  ["Lösche die Buchung vom 1.1.2020", says(/finde keine Buchung/)],
  ["Notiz zur Buchung MediaMarkt vom 24.10.: Fernseher fürs Wohnzimmer", changes((next) => expect(one(next, /MediaMarkt/).note).toBe("Fernseher fürs Wohnzimmer"))],
  ["schreib zur pizzeria buchung dazu dass das ein geburtstagsessen war", changes((next) => expect(one(next, /Pizzeria/).note).toBe("das ein geburtstagsessen war"))],
  ["Füg der Amazon Buchung die Notiz Weihnachtsgeschenk für Mama hinzu", changes((next) => expect(one(next, /AMAZON/).note).toBe("Weihnachtsgeschenk für Mama"))],
  ["Lösch die Notiz bei der MediaMarkt Buchung", says(/keine Notiz/, "booking")],
  ["Tagge die Pizzeria Buchung mit Geburtstag", changes((next) => expect(one(next, /Pizzeria/).tags).toEqual(["Geburtstag"]))],
  ["Ignoriere die Amazon Buchung", changes((next) => expect(one(next, /AMAZON/).ignored).toBe(true))],
  ["bitte die pizzeria-buchung ignorieren", changes((next) => expect(one(next, /Pizzeria/).ignored).toBe(true))],
  ["die MediaMarkt Buchung soll nicht im plan zählen", changes((next) => expect(one(next, /MediaMarkt/).includeInPlan).toBe(false))],
  ["Teile die Pizzeria Buchung mit Raphael", changes((next) => expect(one(next, /Pizzeria/).sharedWithRaphael).toBe(true))],
  ["benenne die buchung AMAZON EU SARL in Amazon um", changes((next) => expect(one(next, /AMAZON/).merchantAlias).toBe("Amazon"))],
  ["nenn SHELL 1234 WIEN ab jetzt Shell", changes((next) => expect(rowsOf(next, /SHELL/).every((row) => row.merchantAlias === "Shell")).toBe(true))],
  ["ändere den Namen von FITINN auf Fitnessstudio", changes((next) => expect(contract(next, /^Fitnessstudio$/)).toBeDefined())],
  ["MediaMarkt Buchung ist eine Fixkosten Buchung", changes((next) => expect(one(next, /MediaMarkt/).fixedCost).toBe(true))],
  ["Die Amazon Buchung vom 14.10. ist Haushalt", changes((next) => expect(one(next, /AMAZON/).category).not.toBe("Shopping"), "rule")],
  ["Kategorisiere die Amazon Buchung als Haushalt", changes((next) => expect(one(next, /AMAZON/).category).not.toBe("Shopping"))],
  ["Pizzeria Da Mario ist immer Lieferdienste", changes((next) => expect(one(next, /Pizzeria/).category).toBe("Lieferdienste"))],
  ["ändere die kategorie der pizzeria buchung auf lieferdienste", changes((next) => expect(one(next, /Pizzeria/).category).toBe("Lieferdienste"))],
  ["ändere die kategorie der lieferando buchung auf restaurants", changes((next) => expect(one(next, /Lieferando/).category).toBe("Restaurants"))],
  ["Kategorisiere die MediaMarkt Buchung als Elektronik", says(/„Elektronik“ gehört in Finanzblick zur Kategorie Shopping/)],
  ["billa ist immer lebensmittel", says(/schon Lebensmittel/)],
  ["streich die pizzeria buchung vom 11.10.", changes((next) => expect(rowsOf(next, /Pizzeria/)).toHaveLength(0))],
  ["die buchung von amazon am 14.10 is eigentlich ein geschenk", changes((next) => expect(one(next, /AMAZON/).category).toBe("Geschenke & Spenden"), "rule")],
  ["die mediamarkt sache vom oktober gehört eigentlich zu elektronik", says(/gehört in Finanzblick zur Kategorie Shopping/)],
  ["Benenne die Netflix Buchungen in Netflix um", changes((next) => expect(rowsOf(next, /NETFLIX/).every((row) => row.merchantAlias === "Netflix")).toBe(true))],
  ["Lösch die Buchung von Gibtsnicht", says(/„Gibtsnicht“ finde ich nicht/)],
];

const goalCases: [string, Expectation][] = [
  ["Lösche das Sparziel Motorrad", changes((next) => expect(goal(next)).toBeUndefined(), "edit")],
  ["lösch mein sparziel Gibtsnicht", says(/„Gibtsnicht“ finde ich nicht/)],
  ["Erhöhe das Sparziel Motorrad auf 9000 €", changes((next) => expect(goal(next)?.target).toBe(9000))],
  ["das motorrad ziel soll bis dezember 2027 gehen", changes((next) => expect(goal(next)?.date.slice(0, 7)).toBe("2027-12"))],
  ["spar monatlich 300 für das Motorrad", changes((next) => expect(goal(next)?.funding?.monthly).toBe(300))],
  ["Motorrad Rate auf 250 €", changes((next) => expect(goal(next)?.funding?.monthly).toBe(250))],
  ["Das Sparziel Motorrad soll auf dem Sparkonto liegen", changes((next) => expect(goal(next)?.pocket).toBe("Sparkonto"))],
  ["spare fürs motorrad vom Urlaubskonto", says(/Wie viel soll ich vom Urlaub/)],
  ["im jänner 200 extra fürs motorrad", changes((next) => expect(goal(next)?.funding?.extras["2027-01"]).toBe(200))],
  ["Im Dezember 150 € extra vom Sparkonto fürs Motorrad", changes((next) => expect(goal(next)?.funding?.extras["2026-12"]).toBe(150))],
  ["Die ersten 2 Monate je 60 € vom Sparkonto fürs Motorrad", changes((next) => expect(goal(next)?.funding?.extras["2026-12"]).toBe(60))],
  ["benenne das sparziel motorrad in Vespa um", changes((next) => expect(goal(next)?.name).toBe("Vespa"))],
  ["Benenne Motorrad in Sparkonto um", says(/kann ich nicht verwenden/)],
  ["Motorrad ist erreicht", changes((next) => expect(goal(next)?.completedAt).toBeDefined())],
  ["Pausiere das Motorrad Sparziel im Dezember", changes((next) => expect(goal(next)?.funding?.paused).toContain("2026-12"))],
  ["Setz die Motorrad-Rate im Jänner aus", changes((next) => expect(goal(next)?.funding?.paused).toContain("2027-01"))],
  ["Erhöhe das Sparziel Motorrad auf -500", says(/größer als null/)],
  ["Setz Motorrad auf 0 €", says(/größer als null/)],
  ["Setz den Notgroschen auf 6000 €", changes((next) => expect(next.settings.emergencyTarget).toBe(6000))],
  ["Sparziel für Urlaub in den Einstellungen auf 2000", changes((next) => expect(next.settings.vacationTarget).toBe(2000))],
  ["Ich möchte ein Sparziel anlegen", { tool: "savings_goal" } as Expectation],
  ["neues sparziel auto 5000 bis ende 2027", { tool: "savings_goal" } as Expectation],
  ["spar für japan 3000 € bis juni 2027", { tool: "savings_goal" } as Expectation],
];

const budgetCases: [string, Expectation][] = [
  ["Ändere das Lebensmittelbudget auf 400 €", changes((next) => expect(budget(next, "food")).toBe(400), "budget_plan")],
  ["lebensmittel budget 450", changes((next) => expect(budget(next, "food")).toBe(450))],
  ["mach das Spritbudget 220", changes((next) => expect(budget(next, "fuel")).toBe(220))],
  ["Lebensmittelbudget soll 300 sein", changes((next) => expect(budget(next, "food")).toBe(300))],
  ["budget fürs tanken auf 190 bitte", changes((next) => expect(budget(next, "fuel")).toBe(190))],
  ["erhöhe das tankbudget um 40", changes((next, before) => expect(budget(next, "fuel")).toBe(budget(before, "fuel") + 40))],
  ["erhöh mal das lebensmittel budget um 50 euro", changes((next, before) => expect(budget(next, "food")).toBe(budget(before, "food") + 50))],
  ["senk das Freizeitbudget um 10 €", changes((next, before) => expect(budget(next, "leisure")).toBe(budget(before, "leisure") - 10))],
  ["schichte 30 € von Tanken zu Restaurants um", changes((next, before) => {
    expect(budget(next, "fuel")).toBe(budget(before, "fuel") - 30);
    expect(budget(next, "going-out")).toBe(budget(before, "going-out") + 30);
  })],
  ["nimm 20 € vom Puffer für Geschenke", changes((next, before) => expect(budget(next, "gifts")).toBe(budget(before, "gifts") + 20))],
  ["verschiebe 10 € von Freizeit nach Essen", changes((next, before) => expect(budget(next, "food")).toBe(budget(before, "food") + 10))],
  ["verschiebe 50 € von Freizeit nach Essen", says(/hat nur/)],
  ["verschieb 50 € von Freizeit nach Mallorca", says(/kein Budget/)],
  ["setz das Lebensmittelbudget zurück", says(/schon auf dem Standard/)],
  ["lebensmittelbudget auf -50 setzen", says(/nicht negativ/)],
  ["erhö das lebensmittlbudget um 20", changes((next, before) => expect(budget(next, "food")).toBe(budget(before, "food") + 20))],
  ["Tankbudget minus 30 €", changes((next, before) => expect(budget(next, "fuel")).toBe(budget(before, "fuel") - 30))],
  ["Leg eine Position Geschenke mit 200 € im Dezember an", { reply: /gibt es schon als Budget/, choices: true }],
  ["budget für einhörner auf 100", says(/„Einhörner“ gibt es nicht/)],
  ["Leg eine Position Urlaub mit 200 € im Dezember an", says(/gibt es schon/)],
  ["neue Budgetzeile Haustier 40 € monatlich", changes((next) => expect(planRow(next, "Haustier")).toMatchObject({ kind: "fixed", values: { "2026-12": 40 } }), "edit")],
  ["neue position hund 30 euro monatlich variabel", { ...changes((next) => expect(planRow(next, "hund") ?? planRow(next, "Hund")).toMatchObject({ kind: "fixed" })),
    reply: undefined }],
  ["Füg eine Position Fitnessstudio hinzu, Fixkosten, 39,90 € ab Dezember", changes((next) => expect(planRow(next, "Fitnessstudio")?.values["2027-01"]).toBe(39.9))],
  ["Benenne die Position Urlaub in Reise um", changes((next) => expect(planRow(next, "Reise")).toBeDefined())],
  ["Lösche die Position Urlaub", changes((next) => expect(planRow(next, "Urlaub")).toBeUndefined())],
  ["setz Urlaub im Dezember auf 300 €", changes((next) => expect(planRow(next, "Urlaub")?.values["2026-12"]).toBe(300))],
  ["Die Position Urlaub gehört zur Kategorie Urlaub", changes((next) => expect(planRow(next, "Urlaub")?.planCategory).toBe("Urlaub"))],
  ["Mach die Position Strom zu Einnahmen", changes((next) => expect(planRow(next, "Strom")?.kind).toBe("income"))],
  ["Mach die Position Strom variabel", says(/Einnahme oder Fixkosten/)],
  ["verschiebe 20 € von Strom zu Urlaub im Dezember", changes((next) => {
    expect(planRow(next, "Strom")?.values["2026-12"]).toBe(40);
    expect(planRow(next, "Urlaub")?.values["2026-12"]).toBe(120);
  })],
  ["verschiebe 500 € von Strom zu Urlaub im Dezember", says(/nur 60,00/)],
  ["verschiebe 100 € von Geschenke zu Urlaub im Dezember", says(/ist ein Budget und gilt für jeden Monat gleich/)],
  ["setz Tanken im Dezember auf 150 €", { reply: /gilt für jeden Monat gleich/, choices: true }],
  ["Tanken ab Jänner auf 120 € pro Monat", { reply: /gilt für jeden Monat gleich/, choices: true }],
  ["Setz das Budget Tanken auf 120 €", changes((next) => expect(budget(next, "fuel")).toBe(120))],
  ["Miete im Dezember 700", { reply: /„Miete“ gibt es im Monatsplan nicht/, choices: true }],
];

const payrollCases: [string, Expectation][] = [
  ["Prüf meine Lohnabrechnungen nochmal", says(/Abrechnungen sind geprüft/, "payroll")],
  ["gibt es probleme mit meinen abrechnungen?", says(/Abrechnungen sind geprüft/)],
  ["Ist mein Budget aktuell zum Gehalt?", says(/Budget/, "payroll")],
  ["Sind meine Abrechnungen in Ordnung?", { on: held, reply: /halte ich aus dem Budget heraus/, choices: true }],
  ["übernimm die abrechnung vom september ins budget", { on: held, tool: "payroll_action", change: (next) => expect(heldPayslips(next)).toHaveLength(0) }],
  ["Gib die Septemberabrechnung frei", { on: held, change: (next) => expect(heldPayslips(next)).toHaveLength(0) }],
  ["übernimm die abrechnung vom september ins budget", says(/schon im Budget/)],
  ["Lösche die Lohnabrechnung vom Jänner", { tool: "payroll_action", reply: /2 Abrechnungen/, choices: true }],
  ["Lösch die Abrechnung Jänner 2026 von Fabelwald", changes((next) => expect(next.payslips?.some((entry) => entry.month === 1 && entry.year === 2026 && entry.employer === payrollEmployer)).toBe(false))],
  ["entferne die gehaltsabrechnung märz 2026", changes((next) => expect(next.payslips?.some((entry) => entry.month === 3 && entry.year === 2026)).toBe(false))],
  ["Lösch die letzte Lohnabrechnung", changes((next, before) => expect(next.payslips).toHaveLength((before.payslips ?? []).length - 1))],
  ["Lösch eine Lohnabrechnung", { choices: true }],
  ["Aktualisiere das Budget mit den Lohnzetteln", changes((next) => expect(next.payrollBudget?.at).toBeDefined(), "payroll_action")],
  ["gleich das Budget mit meinem Gehalt ab", changes((next) => expect(next.payrollBudget?.at).toBeDefined())],
  ["Setz den Successbonus auf 15 %", changes((next) => expect(next.settings.successBonusPercent).toBe(15), "payroll")],
  ["schalte den successbonus aus", changes((next) => expect(next.settings.successBonusPercent).toBe(0))],
];

const settingsCases: [string, Expectation][] = [
  ["Stell das Design auf Weihnachten", changes((next) => expect(next.seasonalTheme).toMatchObject({ mode: "fixed", theme: "christmas" }), "settings")],
  ["Halloween-Design bitte aktivieren", changes((next) => expect(next.seasonalTheme).toMatchObject({ mode: "fixed", theme: "halloween" }))],
  ["Design wieder automatisch nach Jahreszeit", { on: world({ seasonalTheme: { mode: "fixed", theme: "christmas" } }), change: (next) => expect(next.seasonalTheme?.mode).toBe("auto") }],
  ["weihnachtsdesign aus", changes((next) => expect(next.seasonalTheme).toMatchObject({ mode: "fixed", theme: "default" }))],
  ["Halloween-Design ausschalten", changes((next) => expect(next.seasonalTheme).toMatchObject({ mode: "fixed", theme: "default" }))],
  ["Deaktivier das Weihnachtsdesign", changes((next) => expect(next.seasonalTheme).toMatchObject({ mode: "fixed", theme: "default" }))],
  ["Schalte das Nachschlagen unbekannter Abrechnungsbegriffe aus", changes((next) => expect(next.settings.payslipTermLookup).toBe(false))],
  ["Begriffserklärung wieder einschalten", { on: world({ settings: { ...base.settings, payslipTermLookup: false } }), change: (next) => expect(next.settings.payslipTermLookup).toBe(true) }],
  ["Schalte den Dunkelmodus ein", { fixed: (reply) => expect(reply.theme).toBe("dark") }],
  ["mach es hell", { fixed: (reply) => expect(reply.theme).toBe("light") }],
  ["dark mode bitte", { fixed: (reply) => expect(reply.theme).toBe("dark") }],
  ["Schalte die Benachrichtigungen aus", { fixed: (reply) => expect(reply.device).toEqual({ notifications: false }) }],
  ["Benachrichtigungen an", { fixed: (reply) => expect(reply.device).toEqual({ notifications: true }) }],
  ["Aktivier die Benachrichtigungen", { fixed: (reply) => expect(reply.device).toEqual({ notifications: true }) }],
  ["Mach die Töne aus", { fixed: (reply) => expect(reply.device).toEqual({ sounds: false }) }],
  ["sounds wieder an", { fixed: (reply) => expect(reply.device).toEqual({ sounds: true }) }],
  ["Sichtschutz an", { fixed: (reply) => expect(reply.device).toEqual({ privacy: true }) }],
  ["Beträge wieder anzeigen", { fixed: (reply) => expect(reply.device).toEqual({ privacy: false }) }],
  ["Zeig die Beträge wieder", { fixed: (reply) => expect(reply.device).toEqual({ privacy: false }) }],
  ["Benachrichtigungen bitte ausschalten", { fixed: (reply) => expect(reply.device).toEqual({ notifications: false }) }],
  ["Töne an", { fixed: (reply) => expect(reply.device).toEqual({ sounds: true }) }],
  ["Stell den Stichtag auf heute", { fixed: (reply) => expect(reply.text).toMatch(/automatisch/) }],
  ["Verbinde mein Bankkonto", { fixed: (reply) => expect(reply.card?.page?.href).toBe("/einstellungen") }],
  ["Mach ein Backup", { fixed: (reply) => expect(reply.card?.page?.href).toBe("/einstellungen") }],
];

const multiCases: [string, Expectation][] = [
  ["erhöhe tanken um 20 und senke freizeit um 10", changes((next, before) => {
    expect(budget(next, "fuel")).toBe(budget(before, "fuel") + 20);
    expect(budget(next, "leisure")).toBe(budget(before, "leisure") - 10);
  }, "batch")],
  ["Ignoriere die Amazon Buchung und tagge die Pizzeria Buchung mit Party", changes((next) => {
    expect(one(next, /AMAZON/).ignored).toBe(true);
    expect(one(next, /Pizzeria/).tags).toEqual(["Party"]);
  })],
  ["Lösch die Pizzeria Buchung und kategorisiere MediaMarkt als Elektronik", changes((next) => expect(rowsOf(next, /Pizzeria/)).toHaveLength(0))],
];

describe("every manual action by chat", () => {
  it.each(contractCases)("contracts: %s", verify);
  it.each(draftCases)("new contract: %s", verify);
  it.each(bookingCases)("bookings: %s", verify);
  it.each(goalCases)("savings goals: %s", verify);
  it.each(budgetCases)("budget: %s", verify);
  it.each(payrollCases)("payroll: %s", verify);
  it.each(settingsCases)("settings: %s", verify);
  it.each(multiCases)("several at once: %s", verify);

  it("answers in two parts when a second change of another kind follows", () => {
    const { result } = ask(base, "Leg einen Vertrag für Netflix an und lösch die Position Geschenke");
    expect(result?.contractDraft?.name).toBe("Netflix");
    expect(result?.suggestions?.[0]).toBe("Lösch die Position Geschenke");
    expect(splitQuestion("kündige spotify und zeig mir mein budget")?.map((part) => part.tool)).toEqual(["cancel", "budget"]);
  });

  it("walks through a new contract step by step and saves it", () => {
    let draft = ask(base, "Leg einen neuen Vertrag an").result!.contractDraft!;
    for (const answer of ["Fitness Park", "39 €", "Sport & Fitness", "1 Monat", "Keine Mindestlaufzeit", "Monatlich", "Am 1.12."])
      draft = continueContractDraft(draft, answer, base, asOf).draft;
    expect(draft.step).toBe("preview");
    const next = applyOperations(base, [contractDraftOperation(draft)!], { asOf }).state;
    expect(contract(next, /Fitness Park/)).toMatchObject({ amount: 39, interval: "monthly", category: "Sport & Fitness", nextDate: "2026-12-01" });
  });

  it("makes a contract from a booking, with that booking assigned", () => {
    let draft = ask(base, "Markiere die Disney Plus Buchung als Vertrag").result!.contractDraft!;
    const answers: Partial<Record<ContractDraft["step"], string>> = { notice: "Keine", term: "Keine Mindestlaufzeit", interval: "Monatlich", match: "Ja" };
    for (let step = 0; step < 6 && draft.step !== "preview"; step++) draft = continueContractDraft(draft, answers[draft.step] ?? "Abbrechen", base, asOf).draft;
    expect(draft).toMatchObject({ step: "preview", nextDate: "2026-12-02" });
    const next = applyOperations(base, [contractDraftOperation(draft)!], { asOf }).state;
    expect(contract(next, /Disney Plus/)?.charges.map((charge) => charge.id)).toContain(one(base, /Disney/).id);
  });

  it("asks the savings goal step by step and never takes a zero or negative amount", () => {
    const step = (draft: ReturnType<typeof mergeDraft>, text: string) => mergeDraft(draft, parseAssistantMessage(text, asOf), {}, text, asOf);
    let draft = step(undefined, "Ich möchte ein Sparziel anlegen");
    for (const text of ["Neues E-Bike", "2500 €", "bis Juni 2027"]) draft = step(draft, text);
    expect(draft).toMatchObject({ name: "E-Bike", amount: 2500, date: "2027-06-30" });
    expect(missingField(draft!)).toBe("startCapital");
    // Another goal while one is open starts over; 0 € is no amount, so it is asked.
    const other = step(draft, "Sparziel Urlaub 0 € bis Juni");
    expect(other).toMatchObject({ name: "Urlaub", date: "2027-06-30" });
    expect(missingField(other!)).toBe("amount");
    expect(step(undefined, "Sparziel Japan -500 € bis Juni")?.amount).toBeUndefined();
  });

  it("leaves other requests alone that only share a word with an action", () => {
    for (const [text, not] of [["Lösch die Buchung Nebenkostenabrechnung vom 3.10.", "payroll_action"], ["Prüf meine Amex-Abrechnung", "payroll"],
      ["Übernimm die Amex-Abrechnung ins Budget", "payroll_action"], ["Ich möchte mehr zum Thema ETF wissen", "settings"],
      ["Bitte erklär mir das Thema Notgroschen", "settings"], ["Nenn mir einfach meine größten Ausgaben im Oktober", "contract_edit"],
      ["Nenn mir einfach meine größten Ausgaben im Oktober", "booking"]] as const) expect(detectTool(text, names(base)), text).not.toBe(not);
    for (const text of ["Ich bekomme keine Benachrichtigungen", "Erinnere mich mit einer Benachrichtigung an die Kündigung von Netflix", "Warum sind die Töne aus?"])
      expect(fixedReply(text)?.device, text).toBeUndefined();
  });

  it("takes the category the user wrote over the model's hint", () => {
    const text = "ändere die kategorie der lieferando buchung auf restaurants";
    const result = executeTool("rule", text, { state: base, dashboard: calculateDashboard(base), asOf, hints: { category: "Lieferdienste" } });
    expect(result.change?.operations).toEqual([expect.objectContaining({ op: "categorize", category: "Restaurants" })]);
  });

  it("removes a note again, and never deletes the booking for it", () => {
    const noted = confirm(base, "Notiz zur Buchung MediaMarkt vom 24.10.: Fernseher fürs Wohnzimmer");
    const cleared = confirm(noted, "Lösch die Notiz bei der MediaMarkt Buchung");
    expect(one(cleared, /MediaMarkt/)).toBeDefined();
    expect(one(cleared, /MediaMarkt/).note).toBeUndefined();
  });

  it("undoes status changes by chat as well", () => {
    const cancelled = confirm(base, "Spotify ist gekündigt");
    expect(contract(confirm(cancelled, "Spotify ist wieder aktiv"), /spotify/i)?.status).toBe("active");
    expect(contract(confirm(cancelled, "spotify läuft doch wieder"), /spotify/i)?.status).toBe("active");
    const hidden = confirm(base, "Netflix ist kein Vertrag");
    expect(contract(confirm(hidden, "Netflix wieder einblenden"), /netflix/i)?.status).not.toBe("ignored");
    const priced = confirm(base, "netflix kostet jetzt 17,99");
    expect(contract(confirm(priced, "Verwirf meine Änderungen an Netflix"), /netflix/i)?.amount).toBe(13.99);
    const fuel = confirm(base, "erhöhe das tankbudget um 40");
    expect(budget(confirm(fuel, "setz das Tankbudget zurück"), "fuel")).toBe(budget(base, "fuel"));
  });
});
