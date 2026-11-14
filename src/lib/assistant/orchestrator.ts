import { adviceQuestion, isQuestion } from "./conversation";
import { currentInfo } from "./current-info";
import { normalizeMessage } from "./normalize";
import { changingFacts, explicitWeb, foldText, ownData, publicTerms, statedYear } from "./public-facts";
import { detectSmallTalk } from "./smalltalk";
import { fixedReply } from "./fixed-replies";
import { assistantTools, detectTool, isDraftTool, mentionsName, type AssistantTool } from "./tools";

/**
 * Thin orchestrator plus supervisor and workers. The orchestrator does no work of its own: fixed rules decide only the
 * clear cases (see `orchestrate`), everything else goes to the supervisor (DeepSeek V4 Pro), which splits the task among
 * the specialists, runs their reading tools and writes the answer. Four specialists own their tools without overlap; the
 * general chat answers everything else. Without DeepSeek the local routing below decides: signal words, then one word
 * from the local model.
 */
export const agentIds = ["transactions", "contracts", "budget", "payroll", "general"] as const;
export type AgentId = typeof agentIds[number];
/** At most four specialists; "general" is the conversational fallback, not a specialist. */
export const specialistIds = ["transactions", "contracts", "budget", "payroll"] as const satisfies readonly AgentId[];
export type SpecialistId = typeof specialistIds[number];
export const isAgentId = (value: unknown): value is AgentId => typeof value === "string" && (agentIds as readonly string[]).includes(value);

export const agentLabel: Record<AgentId, string> = {
  transactions: "Umsätze",
  contracts: "Verträge",
  budget: "Budget & Prognose",
  payroll: "Gehalt & Steuern",
  general: "Chat",
};

/** Every tool has exactly one owner, so the responsibilities never overlap. */
export const toolOwner: Record<AssistantTool, AgentId> = {
  query: "transactions", booking: "transactions", rule: "transactions", cleanup: "transactions", why: "transactions",
  security: "transactions", refunds: "transactions", context: "transactions", orders: "transactions", shared: "transactions",
  month_review: "transactions", review: "transactions",
  contracts: "contracts", cancel: "contracts", contract_new: "contracts", contract_edit: "contracts",
  budget: "budget", budget_plan: "budget", pulse: "budget", forecast: "budget", funds: "budget", account_rule: "budget",
  affordability: "budget", savings_goal: "budget", expense: "budget", edit: "budget", batch: "budget", whatif: "budget",
  coach: "budget", check: "budget", briefing: "budget", insights: "budget", accounts: "budget", amex: "budget",
  networth: "budget", depot: "budget", loan: "budget",
  payroll: "payroll", tax: "payroll", homeoffice: "payroll", payroll_action: "payroll",
  help: "general", explain: "general", knowledge: "general", market: "general", memory: "general", remember: "general",
  forget: "general", changes: "general", undo: "general", reminder: "general", ask: "general", settings: "general",
};
export const agentTools = (agent: AgentId): AssistantTool[] => assistantTools.filter((tool) => toolOwner[tool] === agent);

// Whole words with umlauts ("übrig", "Überweisung"): JavaScript's \b only knows ASCII letters.
const words = (list: string) => new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${list})(?![\p{L}\p{N}])`, "u");
// Words that clearly belong to one domain. A message has to hit exactly one specialist to skip the model.
const signals: Record<SpecialistId, RegExp[]> = {
  transactions: [words(String.raw`buchung\p{L}*|umsätze|spend|spent|spending|expenses?|groceries|getankt|eingekauft|gekauft|bestellt|gelassen|gespart|umsatz|ausgegeben|bezahlt|gezahlt|eingenommen|überweisung\p{L}*|abbuchung\p{L}*|lastschrift\p{L}*|händler\p{L}*|kategori\p{L}*|rückerstattung\p{L}*|retoure\p{L}*|gutschrift\p{L}*|doppelt|bestellung\p{L}*|klarna|paypal|monatsbericht|rückblick|verdächtig\p{L}*`),
    /\bwo(?:hin)? (?:geht|fließt|fliesst|landet|verschwindet|bleibt) (?:\S+ ){0,2}geld\b/],
  contracts: [words(String.raw`vertr[aä]g\p{L}*|\p{L}*abos?|abonnement\p{L}*|subscriptions?|kündig\p{L}*|laufzeit\p{L}*|versicherung\p{L}*|mitgliedschaft\p{L}*|streaming|handytarif|stromanbieter`)],
  budget: [words(String.raw`\p{L}*budget\p{L}*|übrig|konto|kontos|pleite|blank|leisten|leistbar|ausgehen|knapp|prognose|kontostand|kontostände|sparkonto|girokonto|konten|sparziel\p{L}*|sparen|sparsam|zurücklegen|notgroschen|reserve|puffer|vermögen|monatsende|monatsplan|anleg\p{L}*|veranlagen|etfs?|depot|zinsen|kredit\p{L}*|(?:spar)?rate|amex|pleite`),
    /geht sich|reicht (?:mein |das |es |unser )?geld/],
  payroll: [words(String.raw`grenzsteuersatz|steuersatz|steuerklassen?|verkehrsabsetzbetrag|familienbonus|gehalt(?:s\p{L}*|es)?|lohn(?:zettel|abrechnung\p{L}*|steuer)?|brutto|netto|abrechnung\p{L}*|sonderzahlung\p{L}*|urlaubszuschuss|urlaubsgeld|weihnachtsgeld|weihnachtsremuneration|jahressechstel|sechstel|successbonus|bonus|prämie\p{L}*|steuer\p{L}*|veranlagung|steuerausgleich|absetz\p{L}*|finanzamt|home.?office|rufbereitschaft|überstunden|sozialversicherung`)],
};
// Anything about money at all; without it, the general chat answers right away.
const financeWords = [/€|\d+\s*k\b|\bgeb\w* (?:\S+ ){0,4}aus\b/, words(String.raw`eur|euro|geld\p{L}*|konto|bank\p{L}*|kosten?|kostet|teuer\p{L}*|günstig\p{L}*|billig\p{L}*|preis\p{L}*|zahl\p{L}*|finanz\p{L}*|spar\p{L}*|ausgab\p{L}*|einnahm\p{L}*|schulden|verdien\p{L}*|invest\p{L}*|rechnung\p{L}*|kauf\p{L}*|leist\p{L}*|monat\p{L}*`)];
const hits = (patterns: RegExp[], text: string) => patterns.some((pattern) => pattern.test(text));

/** Whether a message is about money at all; the general chat only sees personal facts when it is. */
export function aboutMoney(input: string): boolean {
  const lower = normalizeMessage(input).toLowerCase();
  return hits(financeWords, lower) || specialistIds.some((id) => hits(signals[id], lower));
}

// Creative or plain chat requests ("Schreib mir ein Gedicht über Sparen") belong to the general chat, even when they mention money.
const CHAT_REQUEST = /\b(?:gedicht\w*|witz\w*|reim\w*|lied\w*|songtext\w*|geschichte\w*|kurzgeschichte\w*|rezept\w*|haiku)\b|^(?:erzähl|erzaehl)\w* mir (?:einen|eine|was|etwas)\b/;
export const chatRequest = (input: string) => CHAT_REQUEST.test(normalizeMessage(input).toLowerCase());
// "Kann man mit 3000 netto in Wien gut leben?" asks about people in general, not about the user's own data.
export const generalQuestion = (lower: string) => /\bman\b/.test(lower) && !/\b(?:ich|mir|mich|mein\w*|wir|uns|unser\w*)\b/.test(lower);

// Advice and explanation wording: "Lohnt sich …?", "Was ist …?", "Wie funktioniert …?", "Tipps".
const adviceWords = /\b(?:hältst du von|haeltst du von|denkst du über|meinst du zu|lohnt sich|lohnen sich|sollte man|soll ich|sollte ich|was ist|was sind|was bedeutet|was heißt|wie funktioniert|unterschied|tipps?|regel|faustregel|erklär\w*|empfiehlst|empfehlung|sinnvoll|besser)\b/;

/**
 * The orchestrator's decision whether the local finance knowledge is searched. Only general finance knowledge needs it:
 * a term for the knowledge tool, or a written answer about money or advice. Tools that compute from the user's data and
 * every app action never wait for it, so normal answers stay as fast as before.
 */
export function wantsKnowledge(input: string, decision: { tool?: AssistantTool; agent: AgentId }): boolean {
  if (decision.tool) return decision.tool === "knowledge";
  const lower = normalizeMessage(input).toLowerCase();
  if (lower.split(/\s+/).length < 2) return false;
  return aboutMoney(lower) || adviceWords.test(lower) || generalQuestion(lower);
}


/** An explicit request to look something up on the internet ("Such im Internet nach …", "google mal …"). */
export const asksForWebSearch = (input: string) => explicitWeb.test(foldText(input));

/**
 * The orchestrator's decision whether a question goes to the web search: never for app actions or the user's own figures,
 * always when the user asks for it, and otherwise only for general finance questions the local knowledge cannot answer
 * reliably, such as yearly amounts and legal rules ("Wie hoch ist die Pendlerpauschale 2026?").
 */
export function wantsWebSearch(input: string, context: { tool?: AssistantTool; hits?: number; confident?: boolean } = {}): boolean {
  const text = foldText(input);
  if (text.split(" ").length < 3 || CHAT_REQUEST.test(text)) return false;
  const changing = changingFacts.test(text);
  const finance = changing || aboutMoney(input);
  if (!finance) return false;
  if (context.tool && context.tool !== "knowledge") return false;
  if (explicitWeb.test(text)) return true;
  // "Warum sind meine Ausgaben heuer so hoch?" is about the user's own money; only a public rule or benefit goes out.
  if (ownData.test(text) && !publicTerms.test(text)) return false;
  if (changing) return !context.confident || statedYear.test(text);
  return !context.hits;
}

/** A free answer that admits it does not know; the question then goes to the web search once. */
export const unsureAnswer = (text: string | undefined) => !text?.trim() ||
  /\b(?:weiß ich (?:leider )?nicht|weiss ich (?:leider )?nicht|kann ich (?:dir )?(?:leider )?nicht (?:sicher |genau )?sagen|bin (?:mir )?(?:da )?nicht (?:ganz )?sicher|keine (?:aktuellen |genauen |verlässlichen )?(?:informationen|infos|daten|angaben|zahlen)|nicht in meinen (?:daten|unterlagen)|habe ich (?:leider )?keine (?:aktuellen )?(?:infos|informationen|daten|zahlen))\b/i.test(text);

export const routeVias = ["rule", "signal", "model", "fallback", "supervisor"] as const;
export type RouteVia = typeof routeVias[number];
export const isRouteVia = (value: unknown): value is RouteVia => typeof value === "string" && (routeVias as readonly string[]).includes(value);
export type RouteDecision = { agent: AgentId; tool?: AssistantTool; via: RouteVia };

/** Signal words only: one specialist, the general chat for messages without any money topic, otherwise undecided. */
export function routeBySignals(input: string, names: string[] = []): RouteDecision | undefined {
  const text = normalizeMessage(input);
  const lower = text.toLowerCase();
  const found = specialistIds.filter((id) => hits(signals[id], lower) || id === "budget" && mentionsName(text, names));
  if (found.length === 1) return { agent: found[0], via: "signal" };
  if (!found.length && !hits(financeWords, lower)) return { agent: "general", via: "rule" };
  return undefined;
}

/** The orchestrator's free decision: small talk and clear commands by rule, then signal words. Undefined = ask the model. */
export function routeByRules(input: string, names: string[] = []): RouteDecision | undefined {
  const text = normalizeMessage(input);
  if (detectSmallTalk(text) || chatRequest(text) || fixedReply(text)) return { agent: "general", via: "rule" };
  // "Mein Konto ist leer", "Ich bin pleite": a worry first, answered with understanding by the general chat.
  if (/^(?:mein (?:konto|girokonto) ist (?:leer|im minus|überzogen|blank)|ich bin (?:total |komplett |gerade )?(?:pleite|blank|abgebrannt|im minus))\b/.test(text.toLowerCase())) return { agent: "general", via: "rule" };
  const tool = detectTool(text, names);
  if (tool) return { agent: toolOwner[tool], tool, via: "rule" };
  if (generalQuestion(text.toLowerCase())) return { agent: "general", via: "rule" };
  return routeBySignals(text, names);
}

// Tools that compute from an amount; without one they could only ask for it, so the supervisor answers from the user's data instead.
export const amountTools: readonly AssistantTool[] = ["funds", "affordability", "depot", "loan"];
const firstPerson = words(String.raw`ich|mir|mich|mein\p{L}*|wir|uns|unser\p{L}*`);

/**
 * Whether a tool the rules recognised answers the message by itself. Advice, opinions and worries want judgment; a
 * purchase, savings plan or loan without any amount and a form opened by a plain question would only ask back.
 */
export function needsSupervisor(input: string, tool: AssistantTool): boolean {
  const text = normalizeMessage(input).toLowerCase();
  if (adviceQuestion(text)) return true;
  const amount = /\d/.test(text);
  return !amount && (amountTools.includes(tool) || isDraftTool(tool) && isQuestion(text));
}

export type Handoff = { to: "specialist"; decision: RouteDecision } | { to: "supervisor"; hint?: AssistantTool };

/**
 * The thin orchestrator: it only decides who takes over. Fixed rules cover the clear cases – small talk, creative and
 * fixed requests, today's values for the web search, general "man" questions, messages without any money topic, and clear
 * commands and lookups that bring everything they need. Everything else goes to the supervisor, a recognised tool as a hint.
 */
export function orchestrate(input: string, names: string[] = []): Handoff {
  const text = normalizeMessage(input);
  const lower = text.toLowerCase();
  const general: Handoff = { to: "specialist", decision: { agent: "general", via: "rule" } };
  if (detectSmallTalk(text) || chatRequest(text) || fixedReply(text)) return general;
  const tool = detectTool(text, names);
  if ((!tool || tool === "knowledge") && (asksForWebSearch(text) || currentInfo(text))) return general;
  if (tool) return needsSupervisor(text, tool) ? { to: "supervisor", hint: tool } : { to: "specialist", decision: { agent: toolOwner[tool], tool, via: "rule" } };
  if (generalQuestion(lower) || !aboutMoney(text) && !firstPerson.test(lower)) return general;
  return { to: "supervisor" };
}

// The router model answers with one of these words; anything else counts as unsure.
export const agentWords: Record<AgentId, string> = {
  transactions: "umsaetze", contracts: "vertraege", budget: "budget", payroll: "gehalt", general: "chat",
};

/** Reads the router model's one-word answer. Undefined (nothing or several agents named) means unsure: general chat. */
export function parseAgent(answer: string): AgentId | undefined {
  const words = answer.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").toLowerCase()
    .replace(/ä/g, "ae").replace(/ü/g, "ue").replace(/ö/g, "oe").match(/[a-z]+/g) ?? [];
  const named = new Set(words.flatMap((word) => agentIds.filter((agent) => agentWords[agent] === word || agent === word)));
  return named.size === 1 ? [...named][0] : undefined;
}
