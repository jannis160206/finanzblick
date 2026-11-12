import { classify, type Dashboard } from "@/lib/calc";
import { canonicalCategory, type Category } from "@/lib/categories";
import { currency, dateLabel } from "@/lib/format";
import { savingsGoals } from "@/lib/goals";
import type { AppState, AssistantCard, AssistantChange, AssistantKnowledge, AssistantOperation, ContractDraft, PlannedOneOff, SavingsGoal } from "@/lib/types";
import { financialCheck } from "./check";
import { answerQuestion, depotProjection, findCategories, goalProgressQuestion, goalsStatus, namedGoal, parsePeriod, savingsCoach, taxDeductibles, weeklyBriefing } from "./answers";
import { accountBalances, amexQuestion, amexSettlement, balances, monthBudget, goalsQuestion } from "./accounts";
import { explainDashboard } from "./explain";
import { loanAnswer, parseReminder, reminderList, reminderListQuestion, reminderRequest, yearReview } from "./extras";
import { homeOfficeStart } from "./homeoffice";
import { addMonth, parseAmount, parseAssistantMessage, resolveDate } from "./intent";
import { knowledgeAnswer, knowledgeList, knowledgeListQuestion } from "./knowledge";
import { marketAnswer, realValue, type MarketSnapshot } from "./market";
import { normalizeMessage } from "./normalize";
import { applyOperations, OperationError } from "./operations";
import { detectTool, matchName, splitCommands, type AssistantTool } from "./tools";
import { bookingEdit } from "./bookings";
import { cancelAnswer } from "./cancel";
import { whyAnswer } from "./why";
import { forecastAnswer } from "./forecast";
import { budgetLineAnswer, pulseAnswer } from "./pulse";
import { payrollAnswer } from "./payroll";
import { ordersAnswer } from "./orders";
import { fundsAnswer, giroTopUp, parseAccountRules, rulesResult, topUpText } from "./funds";
import { bookingAction, bookingActionRequest } from "./booking-actions";
import { contractEdit } from "./contract-actions";
import { detectContracts } from "@/lib/contracts";
import { contractDraftOperation, contractStepReply, startContractDraft } from "./contract-draft";
import { planRowAction } from "./plan-rows";
import { whatIfAnswer } from "./whatif-answer";
import { parseBudgetPlan } from "./budget-plan";
import { bookingFilter, cleanupPlan, filterLabel, hasFilter, matchesFilter, merchantRows, resolveMerchants } from "./cleanup";
import { monthReview, netWorthAnswer, refundAnswer, securityCheck, sharedAnswer } from "./essentials";
import { contextAnswer, contractsAnswer, insightsAnswer, trendAnswer, trendQuestion } from "./copilot";
import type { AssistantPageContext } from "@/lib/assistant-context";
import type { CopilotInsight } from "@/lib/copilot-insights";

export type AgentHints = { goal?: string; planned?: string; category?: string; merchant?: string };
export type AgentResult = { text: string; card?: AssistantCard; change?: AssistantChange; undoId?: string; suggestions?: string[]; choices?: string[];
  /** A contract the chat is creating step by step; the message keeps it until it is saved or dropped. */
  contractDraft?: ContractDraft };
type Context = { state: AppState; dashboard: Dashboard; asOf: string; hints?: AgentHints; previous?: string[]; market?: MarketSnapshot;
  knowledge?: { found: AssistantKnowledge[]; fresh?: string[]; offline?: boolean };
  /** What the user is looking at (route, filters, selection); stays in the browser. */
  page?: AssistantPageContext | null;
  /** Proactive hints already computed for the dashboard. */
  insights?: CopilotInsight[] };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const plannedTotal = (item: PlannedOneOff) => item.total ?? Math.round(item.amount * item.installments * 100) / 100;

export function memoryValue(state: AppState, key: "buffer" | "salaryDay") {
  return (state.assistantMemory ?? []).findLast((entry) => entry.key === key)?.value;
}

// Dry-runs the operations so the preview shows exactly what a click would change.
export function previewChange(state: AppState, operations: AssistantOperation[], title: string, asOf: string): AgentResult {
  try {
    const { diffs } = applyOperations(state, operations, { asOf, id: () => "preview" });
    return { text: `${title}. Bitte prüfen und bestätigen:`, change: { title, operations, diffs: diffs.slice(0, 80) } };
  } catch (error) {
    if (error instanceof OperationError) return { text: error.message };
    throw error;
  }
}

function amountsIn(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(/(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d{1,2}))?\s*(k\b|tsd|tausend)?/gi)) {
    const value = parseAmount(`${match[1]}${match[2] ? `,${match[2]}` : ""}`);
    if (value === undefined) continue;
    values.push(match[3] ? value * 1000 : value);
  }
  return values;
}

function editAmount(text: string, current: number): number | undefined {
  const lower = text.toLowerCase();
  const relative = /\bum\s+(\d[\d.\s]*(?:,\d{1,2})?)\s*(k\b|tsd|tausend)?/.exec(lower);
  if (relative) {
    const raw = parseAmount(relative[1].trim());
    if (raw === undefined) return undefined;
    const delta = relative[2] ? raw * 1000 : raw;
    const down = /senk|reduzier|verringer|weniger|runter/.test(lower);
    return Math.round((down ? current - delta : current + delta) * 100) / 100;
  }
  const absolute = /\bauf\s+(\d[\d.\s]*(?:,\d{1,2})?)\s*(k\b|tsd|tausend)?/.exec(lower);
  if (absolute) {
    const raw = parseAmount(absolute[1].trim());
    return raw === undefined ? undefined : absolute[2] ? raw * 1000 : raw;
  }
  const values = amountsIn(text).filter((value) => value < 2020 || value > 2100);
  return values.length === 1 ? values[0] : undefined;
}

const settingKeys = [
  [/notgroschen|notfall/, "emergencyTarget", "Notgroschen-Ziel"],
  [/urlaubs?(?:ziel|topf|konto|budget|geld)|\burlaub\b/, "vacationTarget", "Urlaubs-Ziel"],
  [/sparkonto/, "savingsTarget", "Sparkonto-Ziel"],
] as const;

function editGoal(goal: SavingsGoal, text: string, asOf: string): { operations: AssistantOperation[]; title: string } | string {
  const lower = text.toLowerCase();
  const parsed = parseAssistantMessage(text, asOf);
  if (/lösch|loesch|entfern|streich|brauch\w* (?:ich )?(?:nicht|kein)/.test(lower)) return { operations: [{ op: "goal_delete", goalId: goal.id }], title: `Sparziel „${goal.name}“ löschen` };
  if (/erreicht|geschafft|abgeschlossen|abschließ|erledigt|fertig gespart/.test(lower)) return { operations: [{ op: "goal_complete", goalId: goal.id }], title: `„${goal.name}“ als erreicht markieren` };
  if (/aussetz|pausier|überspring|ueberspring|ausfallen|fortsetz|wieder aufnehm|wieder zahl|doch zahl/.test(lower)) {
    const resume = /fortsetz|wieder aufnehm|wieder zahl|doch zahl/.test(lower);
    const months = parsed.date ? [parsed.date.month] : [asOf.slice(0, 7)];
    const span = /(\d{1,2})\s+monate?/.exec(lower);
    if (span && !resume) for (let index = 1; index < Math.min(12, Number(span[1])); index++) months.push(addMonth(months[0], index));
    return { operations: months.map((month) => ({ op: "goal_pause" as const, goalId: goal.id, month, ...(resume ? { resume } : {}) })),
      title: `${resume ? "Rate wieder aufnehmen" : "Rate aussetzen"}: ${goal.name}` };
  }
  const extrasNow = Object.entries(goal.funding?.extras ?? {}).filter(([month, value]) => value > 0 && month >= asOf.slice(0, 7)).map(([month]) => month).sort();
  if (/(?:keine|ohne)\s+extra|extras?\s+(?:lösch|loesch|entfern|streich|weg)|extra-?beträge\s+(?:lösch|loesch|entfern|weg)/.test(lower)) {
    if (!extrasNow.length) return `„${goal.name}“ hat keine geplanten Extra-Beträge.`;
    const span = (Number(extrasNow.at(-1)!.slice(0, 4)) - Number(extrasNow[0].slice(0, 4))) * 12 + Number(extrasNow.at(-1)!.slice(5)) - Number(extrasNow[0].slice(5)) + 1;
    return { operations: [{ op: "goal_extras", goalId: goal.id, start: extrasNow[0], months: Math.min(24, span), amount: 0 }], title: `Extra-Beträge für „${goal.name}“ entfernen` };
  }
  if (parsed.extra) {
    const start = parsed.date && /\bab\b/.test(lower) ? parsed.date.month : addMonth(asOf.slice(0, 7), 1);
    return { operations: [{ op: "goal_extras", goalId: goal.id, start, months: parsed.extra.months, amount: parsed.extra.amount,
      ...(parsed.extra.from ? { from: parsed.extra.from } : {}) }], title: `Extra-Beträge für „${goal.name}“` };
  }
  const rename = /(?:umbenennen|benenn\w*|nenn\w*)\b.*?\b(?:in|zu)\s+[„"']?([^"“”'.,!?]{2,60})/i.exec(text);
  if (rename) return { operations: [{ op: "goal_update", goalId: goal.id, name: rename[1].trim() }], title: `„${goal.name}“ umbenennen` };
  const update: Extract<AssistantOperation, { op: "goal_update" }> = { op: "goal_update", goalId: goal.id };
  if (parsed.date && /schieb|verleg|bis|datum|termin|später|früher|auf\s+(?:jänner|januar|feber|februar|märz|april|mai|juni|juli|august|september|oktober|november|dezember|\d{1,2}[./])/.test(lower))
    update.date = resolveDate(parsed.date, "savings_goal", asOf);
  if (/\brate\b|monatlich|pro monat|im monat|sparrate|monatsrate/.test(lower)) {
    const value = editAmount(text.replace(/pro monat|im monat|monatlich/gi, ""), goal.funding?.monthly ?? 0);
    if (value !== undefined) update.monthly = value;
  } else if (/erhöh|erhoeh|senk|reduzier|ziel|betrag|auf\s+\d|um\s+\d|\bmach|\bsoll\b|\bstell|statt|insgesamt|gesamt|\bhoch\b|\brauf\b|\brunter\b/.test(lower) && !update.date) {
    const value = editAmount(text, goal.target);
    if (value !== undefined) update.target = value;
  }
  if (Object.keys(update).length === 2) return `Was soll ich bei „${goal.name}“ ändern? Zum Beispiel „Erhöhe ${goal.name} auf ${currency(Math.ceil(goal.target * 1.2 / 100) * 100)}“, „Schieb ${goal.name} auf Juni“ oder „Setz die ${goal.name}-Rate im Mai aus“.`;
  if (update.target !== undefined && update.target <= 0 || update.monthly !== undefined && update.monthly < 0) return "Der neue Betrag muss größer als null sein.";
  return { operations: [update], title: `Sparziel „${goal.name}“ ändern` };
}

function editPlanned(item: PlannedOneOff, text: string, asOf: string): { operations: AssistantOperation[]; title: string } | string {
  const lower = text.toLowerCase();
  const parsed = parseAssistantMessage(text, asOf);
  if (/lösch|loesch|entfern|streich|fällt weg|faellt weg|brauch\w* (?:ich )?(?:nicht|kein)|erledigt|aus (?:dem plan|der planung)/.test(lower))
    return { operations: [{ op: "planned_delete", plannedId: item.id }], title: `„${item.name}“ aus der Planung nehmen` };
  const rename = /(?:umbenennen|benenn\w*|nenn\w*)\b.*?\b(?:in|zu)\s+[„"']?([^"“”'.,!?]{2,60})/i.exec(text);
  if (rename) return { operations: [{ op: "planned_update", plannedId: item.id, name: rename[1].trim() }], title: `„${item.name}“ umbenennen` };
  const update: Extract<AssistantOperation, { op: "planned_update" }> = { op: "planned_update", plannedId: item.id };
  if (/(?:vom|übers|ueber|über das|aus dem|mit dem|von meinem)\s+sparkonto/.test(lower)) update.pocket = "Sparkonto";
  else if (/(?:vom|übers|ueber|über das|aus dem|mit dem|von meinem)\s+giro(?:konto)?/.test(lower)) update.pocket = "Giro";
  if (/raphael/.test(lower)) update.shared = !/\bnicht\b|\bohne\b|allein|alleine|selber|selbst/.test(lower);
  if (parsed.date) update.date = resolveDate(parsed.date, "expense", asOf);
  if (parsed.installments) update.installments = parsed.installments;
  const amountText = text.replace(/\b\d{1,3}\s*(?:monats)?raten\b/gi, "");
  if (/kostet|teurer|billiger|erhöh|erhoeh|senk|betrag|preis|euro|€|auf\s+\d|um\s+\d/.test(lower) && !(parsed.date && !/€|euro|kostet|betrag|preis|um\s+\d/.test(lower))) {
    const value = editAmount(amountText, plannedTotal(item));
    if (value !== undefined && value >= 1) update.total = value;
  }
  if (Object.keys(update).length === 2) return `Was soll ich bei „${item.name}“ ändern? Zum Beispiel „Schieb ${item.name} auf April“, „${item.name} kostet 450 €“, „${item.name} in 3 Raten“ oder „Zahl ${item.name} vom Sparkonto“.`;
  return { operations: [update], title: `Geplante Ausgabe „${item.name}“ ändern` };
}

// The open step of a new contract, or its preview with the change to confirm.
export function contractDraftResult(state: AppState, draft: ContractDraft, asOf: string): AgentResult {
  const reply = contractStepReply(draft, state, asOf);
  const operation = draft.step === "preview" ? contractDraftOperation(draft) : undefined;
  if (!operation) return { ...reply, contractDraft: draft };
  const preview = previewChange(state, [operation], `Vertrag „${operation.name}“ anlegen`, asOf);
  return preview.change ? { ...preview, text: reply.text, contractDraft: draft } : { ...preview, contractDraft: { ...draft, step: "name" } };
}

function planRows(state: AppState, text: string, asOf: string): AgentResult | undefined {
  const plan = planRowAction(state, text, asOf);
  if (!plan) return undefined;
  return "operations" in plan ? previewChange(state, plan.operations, plan.title, asOf) : plan;
}

function edit({ state, asOf, hints }: Context, text: string): AgentResult {
  // "Füg eine Position Fitnessstudio hinzu", "Lösch die Position Strom": the month plan.
  if (/\b(?:plan)?position\b/i.test(text)) {
    const positions = planRows(state, text, asOf);
    if (positions) return positions;
  }
  const goals = savingsGoals(state).filter((goal) => !goal.completedAt || /lösch|entfern/.test(text.toLowerCase()));
  const planned = (state.plannedOneOffs ?? []).filter((item) => item.date.slice(0, 7) >= asOf.slice(0, 7) || item.installments > 1);
  const hinted = `${text} ${hints?.goal ?? ""} ${hints?.planned ?? ""}`;
  const goal = matchName(text, goals, (item) => item.name) ?? (hints?.goal ? matchName(hinted, goals, (item) => item.name) : undefined);
  const item = matchName(text, planned, (entry) => entry.name) ?? (hints?.planned ? matchName(hinted, planned, (entry) => entry.name) : undefined);
  const lower = text.toLowerCase();
  // "Erhöhe das Sparziel Urlaub in Japan auf 3500 €": a named goal that does not exist is not the vacation setting.
  const namedGoal = /\b[Ss]parziel\s+[„"]?(\p{Lu}[\p{L}\d-]*(?:\s+(?:in|für|nach|\p{Lu}[\p{L}\d-]*))+)/u.exec(text)?.[1];
  if (!goal && !item && namedGoal) {
    const names = goals.map((entry) => entry.name);
    return names.length ? { text: `Ein Sparziel „${namedGoal}“ finde ich nicht. Welches meinst du? Zur Auswahl: ${names.join(", ")}.`, choices: names }
      : { text: `Ein Sparziel „${namedGoal}“ gibt es noch nicht. Soll ich es anlegen? Sag zum Beispiel „Ich möchte ein Sparziel ${namedGoal} anlegen“.`,
        suggestions: [`Ich möchte ein Sparziel ${namedGoal} anlegen`] };
  }
  if (!goal && !item) {
    const setting = settingKeys.find(([pattern]) => pattern.test(lower));
    if (setting) {
      const value = editAmount(text, state.settings[setting[1]]);
      if (value === undefined || value < 0) return { text: `Auf welchen Betrag soll ich das ${setting[2]} setzen? Aktuell sind es ${currency(state.settings[setting[1]])}.` };
      return previewChange(state, [{ op: "setting", key: setting[1], value }], `${setting[2]} ändern`, asOf);
    }
    // "Setz die Sparrate im Mai aus" without a name: only clear when exactly one goal has a fixed rate.
    const funded = goals.filter((entry) => entry.funding && entry.funding.monthly > 0);
    if (/\brate\b|sparrate/.test(lower) && funded.length === 1) return run(state, editGoal(funded[0], text, asOf), asOf);
    // "Setz die Miete im Dezember auf 700 €": a position of the month plan.
    const positions = planRows(state, text, asOf);
    if (positions) return positions;
    // "Ändere den Netflix Betrag auf 15,99 €": a contract, named without the word "Vertrag".
    if (matchName(text, detectContracts(state, asOf), (contract) => contract.name)) {
      const change = contractEdit(state, text, asOf);
      return "operations" in change ? previewChange(state, change.operations, change.title, asOf) : change;
    }
    const names = [...goals.map((entry) => entry.name), ...planned.slice(0, 8).map((entry) => entry.name)];
    const rows = state.financeRows.slice(0, 6).map((row) => `„${row.label}“`);
    const known = rows.length ? ` Im Monatsplan gibt es die Positionen ${rows.join(", ")}.` : "";
    return names.length ? { text: `Welches meinst du? Zur Auswahl: ${names.join(", ")}.${known}`, choices: names }
      : { text: `Ich finde kein Sparziel, keine geplante Ausgabe und keine Position, die dazu passt.${known}` };
  }
  const goalFirst = goal && (!item || /sparziel|ziel|rate|spar/.test(lower) || goal.name.length >= item.name.length);
  return run(state, goalFirst ? editGoal(goal!, text, asOf) : editPlanned(item!, text, asOf), asOf);
}

function run(state: AppState, plan: { operations: AssistantOperation[]; title: string } | string, asOf: string): AgentResult {
  return typeof plan === "string" ? { text: plan } : previewChange(state, plan.operations, plan.title, asOf);
}

function booking({ state, asOf, hints }: Context, text: string): AgentResult {
  if (bookingActionRequest(text)) {
    const action = bookingAction(state, text, asOf, hints?.merchant);
    if (!("operations" in action)) return action;
    const preview = previewChange(state, action.operations, action.title, asOf);
    return { ...preview, card: action.card, text: preview.change ? `${action.title}. Bitte prüfen und bestätigen:` : preview.text };
  }
  const plan = bookingEdit(state, text, asOf, hints?.merchant);
  if (typeof plan === "string") return { text: plan };
  const preview = previewChange(state, plan.operations, plan.title, asOf);
  return { ...preview, card: plan.card, text: preview.change ? `${plan.title}. Bitte prüfen und bestätigen:` : preview.text };
}

const nameList = (state: AppState, asOf: string) => [...savingsGoals(state).filter((goal) => !goal.completedAt).map((goal) => goal.name),
  ...(state.plannedOneOffs ?? []).filter((item) => item.date.slice(0, 7) >= asOf.slice(0, 7) || item.installments > 1).map((item) => item.name)];

// "Sparkonto ist für alle Ausgaben", "Lösch die Kontoregel für Trade Republic": shown as a change and saved only after confirming.
function accountRule({ state, dashboard, asOf }: Context, text: string): AgentResult {
  const lower = text.toLowerCase();
  const rules = state.accountRules ?? [];
  if (/\b(?:lösch|loesch|entfern|vergiss|streich)\w*/.test(lower)) {
    // "Girokonto" means the account the rule was saved for ("Raiffeisen Giro"), like when the rule was set.
    const alias = parseAccountRules(`${text.replace(/\b(?:lösch|loesch|entfern|vergiss|streich)\w*|\bkontoregel\w*|\bregel\w*|\bdie\b|\bfür\b|\bvom\b|\bdas\b/gi, " ").trim()} ist für alle Ausgaben`,
      balances(state, dashboard).map((item) => item.name))[0]?.account;
    const rule = matchName(text.replace(/\bkontoregel\w*|\bregel\w*/gi, " "), rules, (item) => item.account)
      ?? (alias ? rules.find((item) => item.account.toLowerCase() === alias.toLowerCase()) : undefined);
    if (!rule) return rules.length ? { text: `Welche Kontoregel soll ich löschen? Es gibt Regeln für ${rules.map((item) => item.account).join(", ")}.`,
      choices: rules.slice(0, 4).map((item) => `Lösch die Kontoregel für ${item.account}`) } : { text: "Es gibt noch keine Kontoregeln." };
    return previewChange(state, [{ op: "account_rule_delete", ruleId: rule.id }], `Kontoregel für ${rule.account} löschen`, asOf);
  }
  const names = [...balances(state, dashboard).map((item) => item.name), ...savingsGoals(state).map((goal) => goal.name)];
  const parsed = parseAccountRules(text, names);
  if (!parsed.length) {
    const list = rulesResult(state, dashboard, asOf);
    return { ...list, text: `Welches Konto meinst du und wofür darf es verwendet werden? Zum Beispiel „Sparkonto ist für alle Ausgaben“ oder „Trade Republic nur für Autowerkstatt, Ölwechsel“. ${list.text}`.slice(0, 2000) };
  }
  return previewChange(state, parsed.slice(0, 20).map((rule) => ({ op: "account_rule" as const, account: rule.account, use: rule.use, purposes: rule.purposes })),
    parsed.length === 1 ? `Kontoregel für ${parsed[0].account}` : `${parsed.length} Kontoregeln`, asOf);
}

// "Setz den Successbonus auf 120 %", "Schalte den Successbonus aus": the payroll model setting.
export function bonusRequest(text: string): number | undefined {
  const lower = text.toLowerCase();
  if (!/\b(?:success\s?bonus|erfolgsbonus|bonus)\b/.test(lower) || /\?\s*$|^(?:wie|was|wann|warum|wieso|wird|ist|bekomm)/.test(lower)) return undefined;
  if (/\b(?:aus(?:schalten)?|abschalten|deaktivier\w*|kein(?:en)?)\b/.test(lower) && !/\d/.test(lower)) return 0;
  const value = /(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:%|prozent)/.exec(lower);
  if (!value || !/\b(?:setz\w*|stell\w*|änder\w*|aender\w*|trag\w*|auf|beträgt|betraegt|ist|liegt|mach\w*)\b/.test(lower)) return undefined;
  const number = Number(value[1].replace(",", "."));
  return number >= 0 && number <= 500 ? number : undefined;
}

// Several commands in one message become one preview and one undo step.
function batch(context: Context, text: string): AgentResult {
  const { state, asOf } = context;
  const names = nameList(state, asOf);
  const parts = splitCommands(text, names);
  if (!parts) return edit(context, text);
  const operations: AssistantOperation[] = [];
  const titles: string[] = [];
  for (const part of parts) {
    const tool = detectTool(part, names);
    const result = tool && tool !== "batch" ? executeTool(tool, part, { ...context, hints: undefined }) : { text: "Das verstehe ich nicht." } as AgentResult;
    if (!result.change) return { text: `Bei „${part}“ hänge ich: ${result.text}`.slice(0, 2000), ...(result.choices ? { choices: result.choices } : {}) };
    operations.push(...result.change.operations);
    titles.push(result.change.title);
  }
  if (operations.length > 20) return { text: "Das sind zu viele Änderungen auf einmal. Bitte teil sie auf zwei Nachrichten auf." };
  const preview = previewChange(state, operations, `${titles.length} Änderungen: ${[...new Set(titles)].join(" · ")}`.slice(0, 200), asOf);
  return preview.change ? { ...preview, text: `${titles.length} Änderungen auf einmal, mit einem Klick bestätigt und mit einem Klick rückgängig:` } : preview;
}

// "Lieferando ist immer Essen", "Ordne Spar Lebensmittel zu", "Kategorisiere Amazon als Shopping".
export function parseRule(text: string): { merchant?: string; category?: string } {
  const clean = (value: string) => value.replace(/^(?:alle|die|der|das|den|buchungen|umsätze|zahlungen|von|bei|vom)\s+/gi, "")
    .replace(/^(?:alle|die|der|das|den|buchungen|umsätze|zahlungen|von|bei|vom)\s+/gi, "").replace(/[„“"'.,!?]+/g, "").trim();
  const patterns = [
    /^(?:und\s+)?(.+?)\s+(?:ist|sind|gehört|gehören|zählt|zählen)\s+(?:ab jetzt\s+|künftig\s+|immer\s+|auch\s+)*(?:als\s+|zu\s+|in\s+)?(.+)$/i,
    /^(?:bitte\s+)?(?:ordne|buche|verbuche|stell)\s+(.+?)\s+(?:immer\s+|künftig\s+|ab jetzt\s+)*(?:als\s+|der kategorie\s+|in die kategorie\s+|zu\s+|unter\s+)?(.+?)\s+(?:zu|ein|um)\s*[.!]?$/i,
    /^(?:bitte\s+)?kategorisier\w*\s+(.+?)\s+(?:immer\s+)?(?:als|zu|in)\s+(.+)$/i,
    /^(.+?)\s+(?:immer\s+)?(?:als|unter)\s+(.+?)\s+(?:verbuchen|buchen|einordnen|zuordnen|kategorisieren)/i,
    /^(.+?)\s+soll(?:en)?\s+(?:immer\s+)?(?:unter|in|als|zu)\s+(.+?)(?:\s+(?:laufen|fallen|stehen|landen|gehen|sein|gebucht|verbucht))?\s*[.!]?$/i,
    /^(?:bitte\s+)?(?:mach|pack|steck|tu)\w*\s+(.+?)\s+(?:immer\s+)?(?:zu|in|unter)\s+(.+?)\s*[.!]?$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text.trim());
    if (match) return { merchant: clean(match[1]), category: clean(match[2]).replace(/^(?:kategorie|immer|als)\s+/i, "") };
  }
  return {};
}

function rule({ state, asOf, hints }: Context, text: string): AgentResult {
  const parsed = parseRule(text);
  const categoryText = [parsed.category, hints?.category].filter(Boolean).join(" ");
  const found = findCategories(categoryText || text);
  const filter = bookingFilter(text, asOf);
  const specific = hasFilter(filter);
  const names = (parsed.merchant ? resolveMerchants(state, parsed.merchant) : undefined) ??
    (hints?.merchant && merchantRows(state, hints.merchant).rows.length ? [hints.merchant] : undefined);
  if (!names && !specific) return { text: parsed.merchant ? `Ich finde keine Buchungen von „${parsed.merchant}“. Wie heißt der Händler in den Umsätzen?`
    : "Welcher Händler soll in welche Kategorie? Zum Beispiel „Lieferando ist immer Lieferdienste“." };
  const merchant = names ? names.join(" & ") : `Buchung ${filterLabel(filter)}`;
  if (!found) return { text: `In welche Kategorie soll ${merchant}? Zum Beispiel Lebensmittel, Restaurants oder Transfer intern.` };
  const lower = text.toLowerCase();
  const period = !filter.date && /\b(?:im|in|seit|letzten|diesen|dieses|heuer|20\d\d)\b/.test(lower) && !/\bimmer\b/.test(lower) ? parsePeriod(text, asOf) : undefined;
  const pools = names ? names.map((name) => merchantRows(state, name)) : [{ rows: state.transactions, strict: true }];
  const seen = new Set<string>();
  // A loose match (bank or account name) must not pull in transfers; a named merchant may be moved out of them.
  const rows = pools.flatMap((pool) => pool.rows.filter((row) => (pool.strict || !classify(row).isTransfer))).filter((row) =>
    !seen.has(row.id) && seen.add(row.id) && matchesFilter(row, filter) && (!period || (row.date >= period.from && row.date <= period.to)));
  if (!rows.length) return { text: `Ich finde keine Buchung ${[names && `von ${merchant}`, filterLabel(filter)].filter(Boolean).join(" ")}.` };
  // A group like "Essen" becomes the category these bookings mostly have already, otherwise its first entry.
  let category: Category = found.categories[0];
  if (found.categories.length > 1) {
    const counts = new Map<Category, number>();
    for (const row of rows) {
      const current = canonicalCategory(classify(row).category);
      if (found.categories.includes(current)) counts.set(current, (counts.get(current) ?? 0) + 1);
    }
    category = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? category;
  }
  const changing = rows.filter((row) => canonicalCategory(classify(row).category) !== category);
  // A rule remembers the merchant, not a date or an amount, so filtered picks change only these bookings.
  const learn = !specific && !!names && (!period || /\bimmer\b|künftig|ab jetzt|in zukunft/.test(lower));
  const card: AssistantCard = { kind: "rule", title: `${merchant} → ${category}`, total: rows.length,
    lines: rows.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12).map((row) => ({
      label: `${dateLabel(row.date)} · ${row.merchantAlias || row.description.slice(0, 60)}`, value: row.amount,
      detail: `${canonicalCategory(classify(row).category)}${canonicalCategory(classify(row).category) === category ? "" : ` → ${category}`}`, transactionIds: [row.id] })),
    transactionIds: changing.slice(0, 50).map((row) => row.id),
    note: learn ? "Künftige Buchungen dieses Händlers werden automatisch so zugeordnet." : "Gilt nur für diese Buchungen, keine Regel für später." };
  if (!changing.length) return { text: `${rows.length === 1 ? "Die Buchung" : `Alle ${rows.length} Buchungen`} ${[names && `von ${merchant}`, filterLabel(filter)].filter(Boolean).join(" ")} ${rows.length === 1 ? "ist" : "sind"} schon ${category}.`, card };
  const preview = previewChange(state, [{ op: "categorize", ids: changing.map((row) => row.id).slice(0, 2000), category, learn }],
    `${merchant} als ${category} zuordnen`, asOf);
  return { ...preview, card, text: preview.change ? `${plural(changing.length, "Buchung", "Buchungen")} ${[names && `von ${merchant}`, names && specific ? filterLabel(filter) : !names && filterLabel(filter)].filter(Boolean).join(" ")} ${changing.length === 1 ? "würde" : "würden"} zu ${category}${learn ? " – und ich merke mir das für künftige Buchungen" : ""}. Bitte bestätigen:` : preview.text };
}

export function parseMemory(input: string): Extract<AssistantOperation, { op: "memory_add" }> | undefined {
  const text = normalizeMessage(input);
  const lower = text.toLowerCase();
  const buffer = /(?:puffer|reserve|polster|nie unter|nicht unter)\D{0,40}?(\d[\d.\s]*(?:,\d{1,2})?)\s*(?:€|euro)?/.exec(lower) ??
    /(\d[\d.\s]*(?:,\d{1,2})?)\s*(?:€|euro)?\s*(?:als\s+)?(?:puffer|reserve|polster)/.exec(lower);
  if (buffer) {
    const value = parseAmount(buffer[1].trim());
    if (value !== undefined) return { op: "memory_add", key: "buffer", value, text: `Puffer: immer ${currency(value)} pro Monat übrig lassen` };
  }
  const salary = /(?:gehalt|lohn)\D{0,30}?\b(?:am|zum|jeweils am)\s+(\d{1,2})\.?/.exec(lower) ?? /\bam\s+(\d{1,2})\.?\s+(?:kommt|gibt'?s)\s+(?:mein|das)\s+(?:gehalt|lohn)/.exec(lower);
  if (salary && Number(salary[1]) >= 1 && Number(salary[1]) <= 31)
    return { op: "memory_add", key: "salaryDay", value: Number(salary[1]), text: `Gehalt kommt am ${Number(salary[1])}.` };
  const note = text.replace(/^\s*(?:bitte\s+)?(?:merk(?:e)?\s+dir|vergiss nicht|denk(?:e)?\s+da?ran|notier(?:e)?(?:\s+dir)?)\s*[,:]?\s*(?:dass\s+)?/i, "").trim();
  if (note.length < 3) return undefined;
  return { op: "memory_add", key: "note", text: note.charAt(0).toUpperCase() + note.slice(1, 200) };
}

function forget({ state, asOf }: Context, text: string): AgentResult {
  const memory = state.assistantMemory ?? [];
  if (!memory.length) return { text: "Ich habe mir noch nichts gemerkt." };
  const lower = text.toLowerCase();
  const all = /\balles\b/.test(lower);
  const byKey = /puffer/.test(lower) ? memory.filter((entry) => entry.key === "buffer") : /gehalt/.test(lower) ? memory.filter((entry) => entry.key === "salaryDay")
    : /erinnerungen\b/.test(lower) && all ? memory.filter((entry) => entry.key === "reminder") : [];
  const pool = /erinnerung/.test(lower) ? memory.filter((entry) => entry.key === "reminder") : memory;
  const byText = byKey.length ? byKey : all ? memory : [matchName(text.replace(/\b(?:vergiss|vergessen|bitte|dass|das|den|die|erinnerung(?:en)?|lösch\w*|an|zu)\b/gi, " "), pool, (entry) => entry.text)].filter((entry) => entry !== undefined);
  // "Vergiss das wieder" right after "Merk dir …" means the latest entry.
  if (!byText.length && /\b(?:das|es)\b/.test(lower) && !/\balles\b/.test(lower)) byText.push(memory.at(-1)!);
  if (!byText.length) return { text: `Was soll ich vergessen? Gemerkt habe ich: ${memory.map((entry) => `„${entry.text}“`).join(", ")}.` };
  return previewChange(state, byText.slice(0, 20).map((entry) => ({ op: "memory_delete" as const, memoryId: entry.id })), byText.length > 1 ? `${byText.length} Einträge vergessen` : "Eintrag vergessen", asOf);
}

function memoryCard(state: AppState): AgentResult {
  const memory = state.assistantMemory ?? [];
  return { text: memory.length ? `Ich habe mir ${plural(memory.length, "Sache", "Dinge")} gemerkt. Du kannst jeden Eintrag unter „Gedächtnis“ löschen.` : "Ich habe mir noch nichts gemerkt. Sag zum Beispiel „Merk dir: Puffer immer 500 €“.",
    card: { kind: "memory", title: "Das habe ich mir gemerkt", lines: memory.slice(-40).map((entry) => ({ label: entry.text, detail: new Date(entry.at).toLocaleDateString("de-AT") })) } };
}

function changesCard(state: AppState): AgentResult {
  const changes = [...(state.assistantChanges ?? [])].reverse();
  return { text: changes.length ? `Ich habe ${plural(changes.length, "Änderung", "Änderungen")} gemacht. Jede lässt sich unter „Änderungen“ rückgängig machen.` : "Ich habe noch nichts geändert.",
    card: { kind: "changes", title: "Änderungen durch den Assistenten", lines: changes.slice(0, 40).map((entry) => ({
      label: entry.title, detail: `${new Date(entry.at).toLocaleString("de-AT", { dateStyle: "short", timeStyle: "short" })}${entry.undoneAt ? " · rückgängig gemacht" : ""} · ${entry.summary.slice(0, 2).join("; ")}`.slice(0, 300),
      tone: entry.undoneAt ? "info" as const : "good" as const })) } };
}

function undo({ state }: Context): AgentResult {
  const last = (state.assistantChanges ?? []).findLast((entry) => !entry.undoneAt);
  if (!last) return { text: "Es gibt keine Änderung, die ich rückgängig machen könnte." };
  return { text: `Soll ich „${last.title}“ rückgängig machen? ${last.summary.slice(0, 3).join("; ")}`.slice(0, 2000), undoId: last.id };
}

function depot({ asOf, market }: Context, text: string): AgentResult {
  const parsed = parseAssistantMessage(text, asOf);
  const years = /(\d{1,2})\s*jahr/i.exec(text);
  const yearCount = years ? Math.min(50, Math.max(1, Number(years[1]))) : 10;
  const numbers = amountsIn(text.replace(/(\d{1,2})\s*jahr\w*/gi, "").replace(/\d{1,2}\s*%/g, "")).filter((value) => value > 0);
  const monthly = parsed.monthly ?? (numbers.length ? numbers.find((value) => value !== parsed.startCapital) : undefined);
  if (!monthly) return { text: "Wie viel möchtest du monatlich investieren und wie viele Jahre? Zum Beispiel „100 € im Monat in einen ETF, 10 Jahre“." };
  const result = depotProjection(monthly, yearCount, parsed.startCapital ?? 0);
  const middle = result.card.lines[2]?.value;
  const real = middle === undefined ? undefined : realValue(middle, yearCount, market);
  if (real === undefined || !market?.inflation) return result;
  return { ...result, card: { ...result.card, lines: [...result.card.lines, { label: "Mittel, in heutiger Kaufkraft", value: real, tone: "info",
    detail: `bei ${market.inflation.value.toLocaleString("de-AT", { maximumFractionDigits: 1 })} % Inflation (Eurostat, live)` }] } };
}

function taxYear(text: string, asOf: string) {
  const lower = text.toLowerCase();
  const explicit = /\b(20\d{2})\b/.exec(lower);
  const current = Number(asOf.slice(0, 4));
  return explicit ? Number(explicit[1]) : /letztes jahr|vorjahr|voriges jahr/.test(lower) ? current - 1 : current;
}

function tax({ state, asOf }: Context, text: string): AgentResult {
  return taxDeductibles(state, taxYear(text, asOf));
}

function help(): AgentResult {
  const lines = [
    { label: "Ausgaben verstehen", detail: "„Wie viel ging im Oktober fürs Essen weg?“, dann einfach „und im September?“" },
    { label: "Vergleichen", detail: "„Vergleich Oktober mit September“, „Wie haben sich meine Ausgaben entwickelt?“" },
    { label: "Finanz-Check", detail: "„Bin ich sparsam?“, „Wie stehe ich finanziell da?“" },
    { label: "Sparen und planen", detail: "„3.000 € für Japan bis Juli 2027“" },
    { label: "Leisten oder nicht", detail: "„Geht sich ein Fernseher um 900 € aus?“" },
    { label: "Konten und Amex", detail: "„Was muss ich noch auf Amex Rückzahlung überweisen?“" },
    { label: "Bestellungen", detail: "„Welche Bestellungen sind noch offen?“, „Was muss ich bei Klarna noch zahlen?“ – erkannt aus Gmail" },
    { label: "Was fällt dir auf?", detail: "Knappes Monatsende, Budgets, Fristen, Preiserhöhungen, Sparziele, Doppelbuchungen – auch als Hinweise in der Übersicht" },
    { label: "Verträge & Abos", detail: "„Welche Abos habe ich?“, „Wann läuft Netflix aus?“, „Was kostet mich Spotify im Jahr?“" },
    { label: "Frei verfügbar", detail: "„Wie viel kann ich noch ausgeben?“, „Wie viel bleibt am Monatsende?“" },
    { label: "Diese Ansicht", detail: "„Was ist mit den angezeigten Buchungen?“, „Fass die ausgewählten Buchungen zusammen“" },
    { label: "Monats-Puls", detail: "„Wie viel kann ich heute noch ausgeben?“, „Ist mein Gehalt schon da?“, „Bin ich im Budget?“ – mit echtem Kontostand" },
    { label: "Monatsbudget", detail: "„Was bleibt mir diesen Monat übrig?“" },
    { label: "Ändern und merken", detail: "„Erhöh Japan auf 4.000 € und schieb es auf Juli“, „Zahl das Pickerl vom Sparkonto“, „Puffer immer 500 €“" },
    { label: "Buchungen bearbeiten", detail: "„Benenne BILLA DANKT in Billa um“, „Netflix ist Fixkosten“, „Nimm die Buchung vom 3.11. aus dem Plan“, „Lösch die Buchung vom 3.8. über 249 €“" },
    { label: "Tags", detail: "„Tagge die Buchungen vom 10. bis 15.8. mit Malaga 2026“, „Entferne den Tag Malaga“" },
    { label: "Verträge anlegen und ändern", detail: "„Leg einen neuen Vertrag an“ – Schritt für Schritt –, „Netflix ist gekündigt zum 31.12.“, „Bestätige Spotify“, „Kündigungsfrist von Magenta ist 3 Monate“" },
    { label: "Monatsplan", detail: "„Setz die Miete im Dezember auf 700 €“, „Füg eine Position Fitnessstudio hinzu“, „Lebensmittelbudget um 50 € erhöhen“" },
    { label: "Konten und Gehalt einstellen", detail: "„Sparkonto ist für alle Ausgaben“, „Setz den Successbonus auf 120 %“" },
    { label: "Steuer und Depot", detail: "„Was kann ich absetzen?“, „100 € im Monat in einen ETF“" },
    { label: "Live aus dem Internet", detail: "„Wie hoch ist die Inflation?“, „Welche Zinsen fürs Sparkonto?“, „3.000 € in Yen“" },
    { label: "Begriffe erklären und dazulernen", detail: "„Was ist ein ETF?“, „Was bedeutet KESt?“, „Was hast du gelernt?“" },
    { label: "Mir etwas beibringen", detail: "„Mit Japan meine ich Motorrad“, „Nein, ich meinte meine Ausgaben im Oktober“, 👍/👎 unter jeder Antwort" },
    { label: "Kredit durchrechnen", detail: "„Kredit 10.000 € auf 5 Jahre zu 6 %“, „Laptop in 12 Raten“" },
    { label: "Erinnerungen", detail: "„Erinner mich am 1. Dezember, die Kfz-Versicherung zu kündigen“" },
    { label: "Jahresrückblick", detail: "„Wie war mein Jahr 2026?“" },
    { label: "Kündigungshilfe", detail: "„Kündige Netflix“, „Welche Verträge kann ich kündigen?“" },
    { label: "Warum diese Kategorie?", detail: "„Warum ist Billa Lebensmittel?“" },
    { label: "Kontoprognose", detail: "„Wird mein Konto knapp?“, „Reicht mein Geld bis Jänner?“" },
    { label: "Was wäre wenn", detail: "„Wenn ich Netflix kündige und 200 € mehr spare, wann erreiche ich Japan?“ – mit Schiebereglern" },
    { label: "Steuer-Mappe", detail: "„Steuer-Mappe 2026“ – absetzbare Buchungen nach Kennzahl, als CSV" },
  ];
  return { text: "Gern! Ich helfe dir bei allem rund um deine Finanzen und erledige fast alles, was du in der App auch selbst machen kannst – jede Änderung zeige ich dir vorher zum Bestätigen:",
    card: { kind: "answer", title: "Womit ich dir helfen kann", lines, note: "Alle Zahlen rechnet der Code nach. Geändert wird nur, wenn du bestätigst." },
    suggestions: ["Gib mir den Wochenüberblick", "Was kann ich im Dashboard alles einstellen?", "Ich will 200 € mehr im Monat sparen"] };
}

// Executes a non-draft tool deterministically on the local data. Draft tools (goal, expense, affordability) use the draft flow.
export function executeTool(tool: AssistantTool, input: string, context: Context): AgentResult {
  const { state, dashboard, asOf } = context;
  const text = normalizeMessage(input);
  switch (tool) {
    case "query": return answerQuestion(state, text, asOf, context.hints, (context.previous ?? []).map(normalizeMessage));
    case "amex": return amexSettlement(state, dashboard, text, asOf);
    case "accounts": return goalsQuestion(text.toLowerCase()) || namedGoal(dashboard, text) && goalProgressQuestion(text.toLowerCase()) ? goalsStatus(dashboard, asOf, text) : amexQuestion(text.toLowerCase()) ? amexSettlement(state, dashboard, text, asOf) : accountBalances(state, dashboard, text);
    case "budget": return budgetLineAnswer(dashboard, asOf, text) ?? monthBudget(dashboard, text);
    case "briefing": return weeklyBriefing(state, dashboard, asOf, memoryValue(state, "salaryDay"));
    case "check": return financialCheck(state, dashboard, asOf, text);
    case "coach": {
      const target = amountsIn(text).find((value) => value > 0 && value < 100_000) ?? 100;
      return savingsCoach(state, asOf, target);
    }
    case "depot": return depot(context, text);
    case "market": return marketAnswer(text, context.market, dashboard);
    case "knowledge": return knowledgeListQuestion(text.toLowerCase()) || !context.knowledge ? knowledgeList(state)
      : knowledgeAnswer(text, context.knowledge.found, context.knowledge);
    case "tax": return tax(context, text);
    case "homeoffice": return homeOfficeStart(state, taxYear(text, asOf));
    case "edit": return edit(context, text);
    case "booking": return booking(context, text);
    case "batch": return batch(context, text);
    case "rule": return rule(context, text);
    case "remember": {
      const operation = parseMemory(text);
      return operation ? previewChange(state, [operation], "Merken", asOf) : { text: "Was soll ich mir merken?" };
    }
    case "forget": return forget(context, text);
    case "memory": return memoryCard(state);
    case "changes": return changesCard(state);
    case "undo": return undo(context);
    case "explain": return explainDashboard(state, dashboard, text);
    case "help": return help();
    case "loan": return loanAnswer(text, dashboard);
    case "reminder": {
      if (reminderListQuestion(text.toLowerCase()) && !reminderRequest(text.toLowerCase())) return reminderList(state, asOf);
      const operation = parseReminder(text, asOf);
      return typeof operation === "string" ? { text: operation } : previewChange(state, [operation], "Erinnerung anlegen", asOf);
    }
    case "review": return yearReview(state, text, asOf);
    case "cancel": {
      // The letter is only half of it: one tap marks the contract as cancelled, like the switch in the contract dialog.
      const answer = cancelAnswer(state, text, asOf);
      const name = answer.card?.kind === "cancel" ? answer.card.title.replace(/^Kündigungshilfe · /, "") : undefined;
      const end = /\bzum\s+(\d{1,2}\.\s?\d{1,2}\.(?:\s?\d{2,4})?)/.exec(text)?.[1];
      return name ? { ...answer, suggestions: [`${name} ist gekündigt${end ? ` zum ${end}` : ""}`.slice(0, 120), ...(answer.suggestions ?? [])].slice(0, 4) } : answer;
    }
    case "why": return whyAnswer(state, text);
    case "forecast": return forecastAnswer(state, dashboard, asOf);
    case "whatif": return whatIfAnswer(state, dashboard, text, asOf);
    case "pulse": {
      if (trendQuestion(text.toLowerCase())) return trendAnswer(state, asOf);
      const pulse = pulseAnswer(state, dashboard, asOf, text);
      const topUp = giroTopUp(state, dashboard, asOf);
      if (!topUp) return pulse;
      return { ...pulse, text: `${pulse.text} ${topUpText(topUp, true)}`.trim(),
        card: { ...pulse.card, lines: [pulse.card.lines[0], { label: topUp.from ? `Umbuchen vom ${topUp.from}` : "Giro-Lücke bis zum Gehalt", value: topUp.need,
          tone: "warn" as const, detail: topUp.from ? `danach dort ${currency(topUp.after ?? 0)}` : "kein frei verwendbares Konto hat genug" }, ...pulse.card.lines.slice(1)].slice(0, 40) } };
    }
    case "orders": return ordersAnswer(state, asOf);
    case "funds": return fundsAnswer(state, dashboard, text, asOf);
    case "account_rule": return accountRule(context, text);
    case "security": return securityCheck(state, asOf);
    case "cleanup": {
      const plan = cleanupPlan(state);
      if (typeof plan === "string") return { text: plan };
      const preview = previewChange(state, plan.operations, plan.title, asOf);
      return { ...preview, card: plan.card, text: preview.change ? `${plan.count === 1 ? "1 offene Buchung" : `${plan.count} offene Buchungen`} kann ich zuordnen${plan.open ? `, ${plan.open} bleiben offen` : ""}. Bitte kurz prüfen und bestätigen:` : preview.text };
    }
    case "month_review": return monthReview(state, text, asOf);
    case "shared": return sharedAnswer(state, asOf);
    case "networth": return netWorthAnswer(state, dashboard);
    case "refunds": return refundAnswer(state, text, asOf);
    case "contracts": return contractsAnswer(state, text, asOf, () => answerQuestion(state, text, asOf, context.hints, (context.previous ?? []).map(normalizeMessage)), context.page,
      context.previous ?? []);
    case "context": return contextAnswer(state, text, context.page);
    case "insights": return insightsAnswer(state, dashboard, asOf, context.insights);
    case "payroll": {
      const bonus = bonusRequest(text);
      return bonus === undefined ? payrollAnswer(state, text, asOf)
        : previewChange(state, [{ op: "bonus_percent", value: bonus }], bonus === 0 ? "Successbonus ausschalten" : `Successbonus auf ${bonus.toLocaleString("de-DE")} % setzen`, asOf);
    }
    case "contract_new": return contractDraftResult(state, startContractDraft(text, state, asOf, `manual:${crypto.randomUUID()}`), asOf);
    case "contract_edit": {
      const plan = contractEdit(state, text, asOf, context.page);
      return "operations" in plan ? previewChange(state, plan.operations, plan.title, asOf) : plan;
    }
    case "budget_plan": {
      // "Setz Tanken im Dezember auf 150 €", "Tanken ab Jänner auf 120 €": single months of the month plan, like editing those cells.
      if (/\b(?:im|für|fuer|ab|von|bis)\s+(?:jänner|jaenner|januar|feber|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\b/i.test(text)
        && !/\bum\s+\d/.test(text)) {
        const months = planRows(state, text, asOf);
        if (months?.change) return months;
      }
      const parsed = parseBudgetPlan(state, text, asOf);
      return "operations" in parsed ? previewChange(state, parsed.operations, parsed.title, asOf) : parsed;
    }
    default: return help();
  }
}
