import { normalizeMessage } from "./normalize";
import { detectSmallTalk } from "./smalltalk";
import { fixedReply } from "./fixed-replies";
import { assistantTools, detectTool, mentionsName, type AssistantTool } from "./tools";

/**
 * Orchestrator-worker routing for the finance assistant. A light orchestrator picks exactly one agent per message:
 * rules first, then domain signal words, and only when both stay unclear one short model call. Four specialists own
 * their tools without overlap; everything else, and every doubt, goes to the general chat agent.
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
  payroll: "payroll", tax: "payroll", homeoffice: "payroll",
  help: "general", explain: "general", knowledge: "general", market: "general", memory: "general", remember: "general",
  forget: "general", changes: "general", undo: "general", reminder: "general", ask: "general",
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

export const routeVias = ["rule", "signal", "model", "fallback"] as const;
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
