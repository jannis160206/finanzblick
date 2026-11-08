import { addMonths, round, type Dashboard } from "@/lib/calc";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { savingsGoals } from "@/lib/goals";
import { plannedOccurrences } from "@/lib/planned-one-offs";
import { MAX_ACCOUNT_RULES, type AccountRule, type AppState, type AssistantCard } from "@/lib/types";
import type { AgentResult } from "./agent";
import { balances } from "./accounts";
import { findCategories } from "./answers";
import { parseAssistantMessage } from "./intent";
import { checkAffordability, monthBasis, planningHorizon } from "./plan";
import { safeToSpend } from "./pulse";
import { matchName } from "./tools";

type Line = AssistantCard["lines"][number];
type Use = AccountRule["use"];

export const fold = (value: string) => value.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, " ").trim();
const squash = (value: string) => fold(value).replace(/ /g, "");

// Words that mean the same kind of spending, so "nur für Autowerkstatt" also covers "Ölwechsel" or "Pickerl".
const purposeGroups: string[][] = [
  ["auto", "kfz", "werkstatt", "autowerkstatt", "oelwechsel", "oel", "service", "pickerl", "reifen", "winterreifen", "sommerreifen", "inspektion", "bremse", "bremsen",
    "mechaniker", "autoreparatur", "wartung", "fahrzeugwartung", "tuev", "vignette", "autoversicherung", "leasing", "batterie", "zahnriemen", "auspuff", "windschutzscheibe", "motorrad"],
  ["notfall", "notfaelle", "notfallreserve", "unvorhergesehen", "kaputt", "notfallreparatur"],
  ["urlaub", "reise", "reisen", "flug", "fluege", "hotel", "ferien", "trip"],
  ["gesundheit", "arzt", "zahnarzt", "apotheke", "brille", "krankenhaus", "therapie", "physio"],
  ["wohnen", "haushalt", "moebel", "couch", "sofa", "bett", "kueche", "waschmaschine", "kuehlschrank", "geschirrspueler", "staubsauger", "einrichtung", "kaffeemaschine", "reparatur"],
  ["elektronik", "technik", "handy", "smartphone", "iphone", "laptop", "notebook", "pc", "computer", "monitor", "fernseher", "tv", "konsole", "playstation", "tablet", "ipad", "kamera"],
  ["lebensmittel", "einkauf", "einkaeufe", "supermarkt", "wocheneinkauf", "billa", "spar", "hofer", "lidl"],
  ["geschenk", "geschenke", "geburtstag", "weihnachten"],
];
const groupsOf = (words: string[]) => new Set(purposeGroups.flatMap((group, index) => words.some((word) => group.includes(word) ||
  group.some((entry) => entry.length >= 5 && word.includes(entry))) ? [index] : []));

// Does a purpose list ("Autowerkstatt, Ölwechsel") cover what the money is for?
export function servesPurpose(purposes: string[], text: string) {
  const words = fold(text).split(" ").filter((word) => word.length >= 2);
  const plain = ` ${fold(text)} `;
  const own = purposes.map(fold).filter(Boolean);
  if (own.some((purpose) => plain.includes(` ${purpose} `) || purpose.length >= 5 && words.some((word) => word.startsWith(purpose) || purpose.startsWith(word) && word.length >= 5))) return true;
  const theirs = groupsOf(own.flatMap((purpose) => purpose.split(" ")));
  if ([...groupsOf(words)].some((group) => theirs.has(group))) return true;
  const asked = findCategories(text)?.categories ?? [];
  return asked.length > 0 && own.some((purpose) => (findCategories(purpose)?.categories ?? []).some((category) => asked.includes(category)));
}

// ---------- Teaching rules in chat ----------

const accountWords = /\b(?:spar ?konto|notgroschen|giro(?:konto)?|raiffeisen|revolut|trade ?republic|traderepublik|trade ?republik|\btr\b|paypal|tagesgeld|gemeinschaftskonto|verrechnungskonto|amex[- ]?(?:rückzahlung|pocket)|pocket|hauptkonto|persönliches konto|konto)\b/;
const anyWords = /\bfür (?:alle|alles|jede|sämtliche)\b|\bfuer (?:alle|alles|jede)\b|frei (?:verfügbar|verwendbar|nutzbar)|\bbeliebig\b|uneingeschränkt|ohne einschränkung|\bdarf (?:ich )?(?:immer|alles|frei)\b|\bwieder frei\b/;
const neverWords = /\b(?:nicht|nie|niemals|keinesfalls) (?:angreifen|anrühren|anruehren|verwenden|benutzen|nutzen|antasten|anfassen|ausgeben)|\btabu\b|finger weg|\bdarf (?:ich )?(?:nicht|nie)\b|\bgesperrt\b|\bsperr(?:e|en)?\b|bleibt (?:unangetastet|liegen)/;
const onlyWords = /\bnur (?:für|fuer|bei|wenn|im|in)\b|\bausschlie(?:ß|ss)lich\b|\bmax(?:imal)? (?:für|fuer)\b|\bnur noch\b|\bist (?:für|fuer)\b|\bsind (?:für|fuer)\b|\bdient (?:nur )?(?:für|fuer|als)\b|reserviert (?:für|fuer)|gedacht (?:für|fuer)|\bnimm (?:ich )?(?:nur )?(?:für|fuer)\b/;

export const accountRuleRequest = (lower: string) => accountWords.test(lower) && (anyWords.test(lower) || neverWords.test(lower) || onlyWords.test(lower)) &&
  !/\?\s*$/.test(lower) && !/^(?:kann|darf|soll|geht|reicht|ist|hab|habe|wie|was|wo|welche[srn]?|wann)\b/.test(lower) && !/\d+(?:[.,]\d+)?\s*(?:€|euro|eur)\b/.test(lower) &&
  !/leisten|leistbar|geht sich|ausgehen/.test(lower);
export const fundsQuestion = (lower: string) =>
  /kontoregeln?|verwendungsregeln?|welche konten (?:darf|kann|soll)|welches konto (?:darf|kann|soll|nehm)|von welchem konto|wofür darf ich|wofuer darf ich|welches konto ist für|welche konten sind für/.test(lower) ||
  /\d/.test(lower) && /wie lange (?:brauch|muss ich|dauert)|wann (?:kann ich mir|hab ich|habe ich|hätte ich)\b.{0,40}\b(?:leisten|zusammen|beisammen)/.test(lower) && !/sparziel|\bziel\b|depot|etf|kredit|rate\b/.test(lower) ||
  /\d/.test(lower) && (/\b(?:ok|okay|passt das|geht das|machbar|drin)\s*\??$/.test(lower) ||
    /\b(?:kann|darf|könnte|koennte) ich\b.{0,60}\b(?:ausgeben|zahlen|bezahlen|kaufen|nehmen|verwenden|holen)\b/.test(lower) && !/wie ?viel/.test(lower));

const bankAliases: [RegExp, string][] = [
  [/trade ?republi[ck]|traderepubli[ck]|\btr\b|verrechnungskonto/, "Trade Republic"], [/\brevolut\b/, "Revolut"], [/raiffeisen|giro(?:konto)?|hauptkonto/, "Raiffeisen Giro"],
  [/paypal/, "PayPal"], [/spar ?konto/, "Sparkonto"], [/notgroschen/, "Notgroschen"], [/gemeinschaftskonto/, "Gemeinschaftskonto"],
  [/amex[- ]?(?:rückzahlung|pocket)/, "Amex Rückzahlung"],
];

const fillers = /(?<![\p{L}])(?:etc|usw|u\.?\s?s\.?\s?w|z\.?\s?b|und so weiter|oder so|sowas|so was|zeug|sachen|dinge|ausgaben|kosten|zahlungen|verwenden|nehmen|benutzen|nutzen|da|sein|ist|sind|max(?:imal)?|nur|für|fuer|den|die|das|der|dem|ein|eine|einen|meine?n?|wie|was|ich|will|möchte|halt|bitte)(?![\p{L}])/giu;
const joined = /\b(?:beim|im|am|vom|von|mit|zum|zur|bei|in|an|auf|für|fuer)\b/i;
function cleanPurposes(raw: string) {
  return raw.split(/\s*(?:,|;|\/|\+|&|\bund\b|\boder\b|\bbzw\.?)\s*/i)
    // "Autowerkstatt Ölwechsel" are two purposes; "Service beim Auto" is one.
    .flatMap((part) => joined.test(part) ? [part] : part.split(/\s+/))
    .map((part) => part.replace(fillers, " ").replace(/[.!?:]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((part) => part.length >= 2 && part.length <= 60 && !/^\d+$/.test(part))
    .filter((part, index, list) => list.indexOf(part) === index).slice(0, 20);
}

type Mention = { index: number; end: number; account: string };
function mentions(text: string, names: string[]): Mention[] {
  const lower = text.toLowerCase();
  const found: Mention[] = [];
  for (const [pattern, account] of bankAliases)
    for (const match of lower.matchAll(new RegExp(pattern.source, "g"))) found.push({ index: match.index!, end: match.index! + match[0].length, account });
  for (const name of names) {
    const key = name.toLowerCase();
    if (key.length < 4) continue;
    for (let at = lower.indexOf(key); at >= 0; at = lower.indexOf(key, at + 1))
      if (!/\w/.test(lower[at - 1] ?? " ") && !/\w/.test(lower[at + key.length] ?? " ")) found.push({ index: at, end: at + key.length, account: name });
  }
  // Keep the longest mention at a position; a word after "für" is a purpose, not an account.
  return found.sort((a, b) => a.index - b.index || b.end - a.end)
    .filter((item, index, list) => !list.slice(0, index).some((other) => item.index < other.end))
    .filter((item) => !/(?:für|fuer|außer|ausser|bei|wie)\s*(?:\S+\s+)?$/.test(lower.slice(Math.max(0, item.index - 30), item.index)) || item.index === 0);
}

// "Sparkonto ist für alle Ausgaben und Trade Republic nur für Autowerkstatt, Ölwechsel etc."
export function parseAccountRules(text: string, names: string[] = [], at = Date.now()): AccountRule[] {
  const found = mentions(text, names);
  const rules: AccountRule[] = [];
  found.forEach((mention, index) => {
    const segment = text.slice(mention.index, found[index + 1]?.index ?? text.length);
    const lower = segment.toLowerCase();
    let use: Use | undefined;
    let purposes: string[] = [];
    if (neverWords.test(lower)) use = "never";
    else if (anyWords.test(lower)) use = "any";
    else {
      const only = onlyWords.exec(lower);
      if (only) {
        purposes = cleanPurposes(segment.slice(only.index + only[0].length).replace(/^\s*(?:max(?:imal)?\s+)?/i, ""));
        if (purposes.length) use = "only";
      }
    }
    if (use) rules.push({ id: `rule-${squash(mention.account)}-${at}`.slice(0, 100), account: mention.account, use, purposes, at });
  });
  // The same account named twice: the later statement wins.
  return rules.filter((rule, index) => !rules.slice(index + 1).some((other) => squash(other.account) === squash(rule.account)));
}

export function storeAccountRules(current: AccountRule[] = [], fresh: AccountRule[]) {
  const replaced = new Set(fresh.map((rule) => squash(rule.account)));
  return [...current.filter((rule) => !replaced.has(squash(rule.account))), ...fresh].slice(-MAX_ACCOUNT_RULES);
}

export const ruleText = (rule: Pick<AccountRule, "use" | "purposes">) =>
  rule.use === "any" ? "für alle Ausgaben" : rule.use === "never" ? "nie angreifen" : `nur für ${rule.purposes.join(", ")}`;

// ---------- The check ----------

type Account = { key: string; name: string; bank?: string; balance: number; available: number; use: Use; purposes: string[]; ruled: boolean; detail?: string; date?: string };
export type FundsCheck = {
  amount: number;
  label: string;
  ok: boolean;
  missing: number;
  pay: { name: string; amount: number; after: number }[];
  accounts: (Account & { allowed: boolean })[];
  // Accounts that would have enough money but may not be used for this.
  blocked: string[];
  plan?: { month: string; light: string; after?: number; shortfall?: number };
  // When the missing money is saved up from the free plan surplus of the coming months.
  ready?: { month: string; perMonth: number };
};

function readyMonth(state: AppState, dashboard: Dashboard, missing: number): FundsCheck["ready"] {
  const horizon = planningHorizon(dashboard);
  let saved = 0;
  let months = 0;
  for (let offset = 1; offset <= 24; offset++) {
    const month = addMonths(dashboard.currentMonth, offset);
    if (month > horizon) return undefined;
    const basis = monthBasis(state, dashboard, month);
    if (!basis) return undefined;
    saved = round(saved + Math.max(0, basis.free));
    months += 1;
    if (saved + 0.005 >= missing) return { month, perMonth: round(saved / months) };
  }
  return undefined;
}

// Giro below zero before payday: how much to move over and from which freely usable account.
export function giroTopUp(state: AppState, dashboard: Dashboard, today: string) {
  const pulse = safeToSpend(state, dashboard, today);
  if (!pulse || pulse.free >= -0.5) return undefined;
  const need = Math.ceil(-pulse.free);
  const from = accountsWithRules(state, dashboard, today)
    .filter((account) => account.use === "any" && !/giro|persönliches/i.test(account.name) && account.available >= need)
    .sort((a, b) => b.available - a.available)[0];
  return { need, until: pulse.until, ...(from ? { from: accountLabel(from), after: round(from.available - need) } : {}) };
}

export function topUpText(topUp: NonNullable<ReturnType<typeof giroTopUp>>, short = false) {
  if (short) return topUp.from ? `Tipp: Buche ${currency(topUp.need)} vom ${topUp.from} aufs Giro, dann bleiben dort ${currency(topUp.after ?? 0)}.` : "";
  return topUp.from
    ? `Dein Giro reicht bis zum Gehalt am ${dateLabel(topUp.until)} nicht: Buche ${currency(topUp.need)} vom ${topUp.from} aufs Giro, dann bleiben dort ${currency(topUp.after ?? 0)}.`
    : `Dein Giro reicht bis zum Gehalt am ${dateLabel(topUp.until)} nicht: Es fehlen ${currency(topUp.need)}, und kein frei verwendbares Konto hat genug.`;
}

const budgetPocket = /^(?:lebensmittel|mittagessen|tanken|snacks|haushalt|wocheneinkauf|entertainment|shopping|pro|essen|freizeit)/i;

function defaults(name: string, key: string, goalPockets: Map<string, string>): { use: Use; purposes: string[]; detail?: string } {
  if (/giro|persönliches konto|hauptkonto|personal account/i.test(name)) return { use: "any", purposes: [] };
  if (/^sparkonto$/i.test(name)) return { use: "any", purposes: [] };
  if (/notgroschen/i.test(name)) return { use: "only", purposes: ["Notfälle"], detail: "Notgroschen" };
  if (/amex/i.test(name)) return { use: "never", purposes: [], detail: "für die Amex-Abrechnung reserviert" };
  if (/gemeinschaft/i.test(name)) return { use: "never", purposes: [], detail: "gemeinsames Konto mit Raphael" };
  const goal = goalPockets.get(key);
  if (goal) return { use: "only", purposes: [goal], detail: `Sparziel ${goal}` };
  if (budgetPocket.test(name)) return { use: "only", purposes: [name], detail: "Budget-Pocket" };
  return { use: "only", purposes: [name] };
}

function ruleFor(rules: AccountRule[], name: string, bank?: string) {
  const own = squash(name);
  return [...rules].reverse().find((rule) => squash(rule.account) === own) ??
    [...rules].reverse().find((rule) => own.includes(squash(rule.account)) && squash(rule.account).length >= 4) ??
    (bank ? [...rules].reverse().find((rule) => squash(rule.account) === squash(bank) && !/revolut/i.test(bank)) : undefined);
}

export function accountsWithRules(state: AppState, dashboard: Dashboard, today: string, plannedId?: string): Account[] {
  const rules = state.accountRules ?? [];
  const goalPockets = new Map(savingsGoals(state).filter((goal) => !goal.completedAt && goal.pocket).map((goal) => [fold(goal.pocket!), goal.name] as const));
  const pulse = safeToSpend(state, dashboard, today);
  const planned = plannedOccurrences(state.plannedOneOffs).filter((item) => !item.bookingId && item.itemId !== plannedId && item.date >= today && item.date <= shiftDays(today, 92));
  const list: Account[] = [];
  for (const item of balances(state, dashboard)) {
    if (item.amount === null || /paypal/i.test(item.name)) continue;
    const rule = ruleFor(rules, item.name, item.bank);
    const base = defaults(item.name, fold(item.name), goalPockets);
    const use = rule?.use ?? base.use;
    const purposes = rule ? rule.purposes : base.purposes;
    let available = Math.max(0, item.amount);
    let detail = rule ? undefined : base.detail;
    if (/giro/i.test(item.name) && item.bank !== "Revolut" && pulse) {
      // Giro: only what is left after fixed costs, savings rates and the buffer until the next salary.
      available = round(Math.max(0, Math.min(item.amount, pulse.free)));
      detail = `Stand ${currency(item.amount)}, frei bis Gehalt ${monthDay(pulse.until)}: ${currency(Math.max(0, pulse.free))}`;
    } else {
      const reserved = round(planned.filter((entry) => fold(entry.pocket) === fold(item.name)).reduce((sum, entry) => sum + entry.ownAmount, 0));
      if (reserved > 0.005) {
        available = round(Math.max(0, available - reserved));
        detail = `${currency(reserved)} schon für geplante Ausgaben vorgemerkt`;
      }
    }
    if (item.amount <= 0.005 && !rule) continue;
    list.push({ key: item.key, name: item.name, bank: item.bank, balance: item.amount, available, use, purposes, ruled: !!rule, ...(detail ? { detail } : {}), ...(item.date ? { date: item.date } : {}) });
  }
  return list;
}

function shiftDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
const monthDay = (date: string) => `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}.`;

export const accountLabel = (account: { name: string; bank?: string }) =>
  account.bank && account.bank !== "Revolut" && !account.name.toLowerCase().includes(account.bank.toLowerCase().split(" ")[0]) ? `${account.name} (${account.bank})` : account.name;

export function checkFunds(state: AppState, dashboard: Dashboard, input: { amount: number; purpose: string; label?: string; month?: string; plannedId?: string }, today: string): FundsCheck {
  const accounts = accountsWithRules(state, dashboard, today, input.plannedId).map((account) => ({
    ...account, allowed: account.use === "any" || account.use === "only" && servesPurpose(account.purposes, input.purpose),
  }));
  // Accounts meant for exactly this go first, then free money on the giro, then the general savings.
  const order = (account: Account & { allowed: boolean }) => account.use === "only" ? 0 : /giro|persönliches/i.test(account.name) ? 1 : 2;
  const usable = accounts.filter((account) => account.allowed && account.available > 0.005).sort((a, b) => order(a) - order(b) || b.available - a.available);
  const single = usable.find((account) => account.available + 0.005 >= input.amount);
  const pay: FundsCheck["pay"] = [];
  if (single) pay.push({ name: accountLabel(single), amount: input.amount, after: round(single.available - input.amount) });
  else {
    let rest = input.amount;
    for (const account of usable) {
      if (rest <= 0.005) break;
      const take = round(Math.min(rest, account.available));
      pay.push({ name: accountLabel(account), amount: take, after: round(account.available - take) });
      rest = round(rest - take);
    }
  }
  const covered = round(pay.reduce((sum, item) => sum + item.amount, 0));
  const missing = round(Math.max(0, input.amount - covered));
  const blocked = accounts.filter((account) => !account.allowed && account.available + 0.005 >= input.amount).map(accountLabel);
  let plan: FundsCheck["plan"];
  if (input.month && input.month > dashboard.currentMonth) {
    const result = checkAffordability(state, dashboard, { action: "affordability", amount: input.amount, date: `${input.month}-01` });
    if (!result.error) plan = { month: input.month, light: result.light, after: result.tightest?.after, shortfall: result.shortfall };
  }
  const ok = missing <= 0.005;
  const ready = ok ? undefined : readyMonth(state, dashboard, missing);
  return { amount: input.amount, label: input.label ?? "Ausgabe", ok, missing, pay, accounts, blocked, ...(plan ? { plan } : {}), ...(ready ? { ready } : {}) };
}

function accountLine(account: FundsCheck["accounts"][number], amount: number, purpose: string): Line {
  const label = accountLabel(account);
  const rule = account.use === "any" ? "für alles" : account.use === "never" ? "gesperrt" : `nur für ${account.purposes.join(", ")}`;
  const why = account.detail ? ` · ${account.detail}` : "";
  if (!account.allowed) return { label, value: account.available, tone: "info",
    detail: `${account.use === "never" ? "darf nicht verwendet werden" : `${rule} – passt nicht zu ${purpose}`}${why}`.slice(0, 300) };
  const enough = account.available + 0.005 >= amount;
  return { label, value: account.available, tone: enough ? "good" : "warn", detail: `${rule} · ${enough ? "reicht allein" : `reicht allein nicht`}${why}`.slice(0, 300) };
}

const purposeLabel = (label: string) => label === "Ausgabe" ? "diese Ausgabe" : label;

export function fundsResult(check: FundsCheck): AgentResult {
  const what = `${currency(check.amount)}${check.label !== "Ausgabe" ? ` für ${check.label}` : ""}`;
  let text: string;
  if (check.ok && check.pay.length === 1) {
    const pay = check.pay[0];
    text = `✅ OK – ${what} geht sich aus. Zahl es vom ${pay.name}, danach bleiben dort ${currency(pay.after)}.`;
  } else if (check.ok) {
    text = `✅ OK – ${what} geht sich aus, aber nur aufgeteilt: ${check.pay.map((pay) => `${currency(pay.amount)} vom ${pay.name}`).join(" + ")}.`;
  } else {
    const have = round(check.amount - check.missing);
    text = `❌ Nicht OK – für ${what} fehlen ${currency(check.missing)}. Auf den Konten, die du dafür verwenden darfst, sind nur ${currency(have)} frei.`;
    if (check.blocked.length) {
      const names = check.blocked.length > 1 ? `${check.blocked.slice(0, -1).join(", ")} und ${check.blocked.at(-1)}` : check.blocked[0];
      text += check.blocked.length > 1 ? ` ${names} hätten genug, sind aber laut deinen Regeln nicht dafür gedacht.`
        : ` ${names} hätte genug, ist aber laut deinen Regeln nicht dafür gedacht.`;
    }
    text += check.ready
      ? ` Mit deinem freien Überschuss von rund ${currency(check.ready.perMonth)} im Monat geht es sich voraussichtlich ab ${monthLabel(check.ready.month)} aus.`
      : " Mit deinem aktuellen Monatsplan geht es sich in absehbarer Zeit nicht aus.";
  }
  if (check.plan) {
    const month = monthLabel(check.plan.month);
    text += check.plan.light === "green" ? ` Auch im Monatsplan ${month} ist Platz dafür.`
      : check.plan.light === "yellow" ? ` Im Monatsplan ${month} wird es knapp; dort müsstest du eine Sparrate kürzen.`
        : ` Im Monatsplan ${month} fehlen dafür ${currency(check.plan.shortfall ?? 0)}.`;
  }
  const lines = [...check.accounts].sort((a, b) => Number(b.allowed) - Number(a.allowed) || b.available - a.available)
    .slice(0, 20).map((account) => accountLine(account, check.amount, purposeLabel(check.label)));
  lines.unshift(check.ok
    ? { label: "Ergebnis", detail: check.pay.map((pay) => `${currency(pay.amount)} vom ${pay.name} → danach ${currency(pay.after)}`).join(" · ").slice(0, 300), tone: "good" }
    : { label: "Ergebnis: es fehlen", value: check.missing, tone: "bad" });
  if (check.ready) lines.splice(1, 0, { label: `Geht sich aus ab ${monthLabel(check.ready.month)}`, value: check.ready.perMonth, tone: "info",
    detail: "freier Überschuss pro Monat laut Monatsplan, nach Fixkosten und Sparraten" });
  return {
    text,
    card: { kind: "answer", title: `${check.ok ? "✅ OK" : "❌ Nicht OK"} · ${check.label} ${currency(check.amount)}`.slice(0, 200), total: check.amount, lines,
      note: "Geprüft mit deinen echten Kontoständen und deinen Kontoregeln. Es wird nichts angelegt. Regeln ändern: z. B. „Sparkonto ist für alle Ausgaben“ oder „Trade Republic nur für Autowerkstatt, Ölwechsel“." },
    suggestions: [
      ...(check.ok && check.label !== "Ausgabe" ? [`Plane ${check.label} ${Math.round(check.amount)} € als Ausgabe ein`] : []),
      "Welche Konten darf ich wofür verwenden?",
      ...(!check.ok && check.ready && check.label !== "Ausgabe" ? [`Plane ${check.label} ${Math.round(check.amount)} € im ${monthLabel(check.ready.month)} ein`] : []),
    ].slice(0, 3),
  };
}

export function rulesResult(state: AppState, dashboard: Dashboard, today: string, intro?: string): AgentResult {
  const accounts = accountsWithRules(state, dashboard, today);
  const lines: Line[] = accounts.sort((a, b) => Number(b.ruled) - Number(a.ruled) || b.available - a.available).slice(0, 20).map((account) => ({
    label: accountLabel(account), value: account.available, tone: account.use === "never" ? "bad" : account.use === "any" ? "good" : "info",
    detail: `${ruleText(account)}${account.ruled ? " · deine Regel" : " · Standard"}${account.detail ? ` · ${account.detail}` : ""}`.slice(0, 300),
  }));
  const own = (state.accountRules ?? []).length;
  return {
    text: intro ?? (own ? `Das sind deine Kontoregeln. Bei „Kann ich mir … leisten?“ prüfe ich genau diese Konten und sage OK oder nicht OK.`
      : "Du hast noch keine eigenen Kontoregeln. Ich verwende diese Standards; sag mir einfach, wofür ein Konto gedacht ist."),
    card: { kind: "rule", title: "Welches Konto wofür", lines, note: "Ändern: „Sparkonto ist für alle Ausgaben“, „Trade Republic nur für Autowerkstatt, Ölwechsel“, „Notgroschen nicht angreifen“. Löschen unter „Gedächtnis“." },
    suggestions: ["Kann ich mir eine Waschmaschine um 600 € leisten?", "Ölwechsel 120 € ok?", "Notgroschen nur für Notfälle"],
  };
}

// Amount, label and month from any phrasing; a missing amount is taken from a planned expense with that name.
export function fundsAnswer(state: AppState, dashboard: Dashboard, input: string, today: string): AgentResult {
  const parsed = parseAssistantMessage(input, today);
  const lower = input.toLowerCase();
  const plannedItems = (state.plannedOneOffs ?? []).filter((item) => item.date >= today.slice(0, 8) + "01");
  const known = matchName(input, plannedItems, (item) => item.name);
  const amount = parsed.amount ?? parsed.numbers.find((value) => value > 0) ?? (known ? (known.total ?? known.amount * known.installments) : undefined);
  if (!amount) {
    if (/kontoregel|verwendungsregel|welche konten|welches konto|wofür darf|wofuer darf/.test(lower)) return rulesResult(state, dashboard, today);
    return { text: "Wie viel kostet es ungefähr? Dann prüfe ich alle Konten, die du dafür verwenden darfst, und sage dir OK oder nicht OK.",
      suggestions: ["Welche Konten darf ich wofür verwenden?"] };
  }
  const category = findCategories(input)?.label;
  const label = (parsed.name && !/^(?:ich|es|das|mir|geld)$/i.test(parsed.name) ? parsed.name : undefined) ?? known?.name ?? category ?? "Ausgabe";
  const month = parsed.date?.month;
  return fundsResult(checkFunds(state, dashboard, { amount, purpose: `${input} ${label}`, label, ...(month ? { month } : {}), ...(known ? { plannedId: known.id } : {}) }, today));
}
