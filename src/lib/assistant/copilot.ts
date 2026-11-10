import { addMonths, classify, knownMerchantName, round, type Dashboard } from "@/lib/calc";
import { canonicalCategory } from "@/lib/categories";
import { contractNotice } from "@/lib/contract-types";
import { daysBetween, detectContracts, intervalLabel, isRunning, noticeLabel, type Contract } from "@/lib/contracts";
import { buildCopilotInsights, type CopilotInsight } from "@/lib/copilot-insights";
import { currency, dateLabel, monthLabel } from "@/lib/format";
import { ledger } from "@/lib/insights";
import { ledgerHref } from "@/lib/ledger-link";
import { monthEndForecast } from "@/lib/month-forecast";
import type { AppState, AssistantCard, Transaction } from "@/lib/types";
import type { AssistantPageContext } from "@/lib/assistant-context";
import type { AgentResult } from "./agent";
import { matchName } from "./tools";

type Line = AssistantCard["lines"][number];
const folder = { label: "Im Vertragsordner öffnen", href: "/vertraege" } as const;
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const typeWords: [RegExp, Contract["type"][]][] = [
  [/streaming|\babos?\b|abonnement/, ["streaming", "software", "gym"]],
  [/versicherung/, ["insurance"]],
  [/handy|mobilfunk|telefon/, ["mobile"]],
  [/internet|wlan|breitband/, ["internet"]],
  [/strom|gas|energie/, ["energy"]],
  [/fitness|gym|studio/, ["gym"]],
];

function typeNoun(pattern: RegExp) {
  const source = pattern.source;
  if (source.includes("abos")) return { one: "Abo", many: "Abos", title: "Abos" };
  if (source.includes("versicherung")) return { one: "Versicherung", many: "Versicherungen", title: "Versicherungen" };
  return { one: "passenden Vertrag", many: "passende Verträge", title: "Passende Verträge" };
}

function contractLine(contract: Contract, today: string): Line {
  const deadline = contract.deadline ? daysBetween(today, contract.deadline) : undefined;
  return {
    label: contract.name, value: -contract.amount,
    tone: deadline !== undefined && deadline <= 14 ? "warn" : contract.status === "review" ? "info" : undefined,
    detail: [
      intervalLabel[contract.interval],
      contract.nextDate ? `nächste ${dateLabel(contract.nextDate)}` : "",
      contract.deadline ? `kündigen bis ${dateLabel(contract.deadline)}` : contract.notice ? "" : "Frist offen",
      contract.priceChange && contract.priceChange.percent > 0 ? `+${contract.priceChange.percent.toLocaleString("de-AT")} % seit ${dateLabel(contract.priceChange.date)}` : "",
      contract.status === "review" ? "neu erkannt" : contract.status === "cancelled" ? `endet ${contract.cancelledAt ? dateLabel(contract.cancelledAt) : ""}`.trim() : "",
    ].filter(Boolean).join(" · "),
    transactionIds: contract.charges.slice(0, 50).map((charge) => charge.id),
  };
}

function singleContract(contract: Contract, lower: string, today: string): AgentResult {
  const typical = contractNotice[contract.type];
  const lines: Line[] = [
    { label: "Betrag", value: -contract.amount, detail: intervalLabel[contract.interval] },
    { label: "Im Jahr", value: -contract.yearly, detail: `${currency(contract.monthly)} im Monat` },
    ...(contract.nextDate && contract.status !== "ignored" ? [{ label: "Nächste Abbuchung", detail: dateLabel(contract.nextDate) }] : []),
    { label: "Kündigungsfrist", detail: contract.notice ? noticeLabel(contract.notice) : `nicht hinterlegt · üblich: ${typical.text}` },
    ...(contract.deadline && contract.effectiveEnd ? [{ label: "Kündigen bis", tone: "warn" as const, detail: `${dateLabel(contract.deadline)}, endet dann am ${dateLabel(contract.effectiveEnd)}` }] : []),
    ...(contract.priceChange ? [{ label: "Preisänderung", tone: contract.priceChange.percent > 0 ? "warn" as const : "good" as const,
      detail: `${currency(contract.priceChange.from)} → ${currency(contract.priceChange.to)} am ${dateLabel(contract.priceChange.date)}` }] : []),
    ...(contract.charges.length ? [{ label: "Abbuchungen", detail: `${contract.charges.length} erkannt, zuletzt ${dateLabel(contract.charges[0].date)}`,
      transactionIds: contract.charges.slice(0, 50).map((charge) => charge.id) }] : []),
  ];
  let text: string;
  if (/aus\b|endet|ende\b|kündigungsfrist|kuendigungsfrist|kündigen|kuendigen|verlänger|verlaenger|laufzeit|kündbar|kuendbar/.test(lower)) {
    text = contract.status === "cancelled" ? `${contract.name} ist als gekündigt markiert${contract.cancelledAt ? ` und endet am ${dateLabel(contract.cancelledAt)}` : ""}.`
      : contract.deadline && contract.effectiveEnd
        ? `${contract.name}: Kündigen bis ${dateLabel(contract.deadline)} (noch ${plural(daysBetween(today, contract.deadline), "Tag", "Tage")}), dann endet der Vertrag am ${dateLabel(contract.effectiveEnd)}. Sonst verlängert er sich.`
        : `Für ${contract.name} ist keine Kündigungsfrist hinterlegt – dazu habe ich keine ausreichenden Daten. Üblich bei ${typical.label}: ${typical.text} Trag die Frist im Vertragsordner ein, dann erinnere ich dich rechtzeitig.`;
  } else if (/jahr|jährlich|jaehrlich/.test(lower)) {
    text = `${contract.name} kostet dich ${currency(contract.yearly)} im Jahr (${currency(contract.amount)} ${intervalLabel[contract.interval]}).`;
  } else {
    text = `${contract.name}: ${currency(contract.amount)} ${intervalLabel[contract.interval]}${contract.nextDate ? `, nächste Abbuchung am ${dateLabel(contract.nextDate)}` : ""}. Im Jahr sind das ${currency(contract.yearly)}.`;
  }
  if (contract.priceChange && contract.priceChange.percent > 0) text += ` Seit ${dateLabel(contract.priceChange.date)} ist es ${currency(contract.priceChange.to - contract.priceChange.from)} teurer.`;
  if (contract.status === "review") text += " Ich habe den Vertrag aus wiederkehrenden Abbuchungen erkannt; im Vertragsordner kannst du ihn bestätigen.";
  return {
    text,
    card: { kind: "contracts", title: contract.name, total: -contract.yearly, lines, page: folder },
    suggestions: contract.status === "cancelled" ? ["Welche Abos habe ich?"] : [`Kündige ${contract.name}`, "Welche Abos habe ich?", "Wie viel kann ich noch ausgeben?"],
  };
}

/** Contract folder questions; `fallback` answers when a named item is not a known contract. */
export function contractsAnswer(state: AppState, text: string, today: string, fallback: () => AgentResult, page?: AssistantPageContext | null): AgentResult {
  const lower = text.toLowerCase();
  const contracts = detectContracts(state, today).filter((contract) => contract.status !== "ignored");
  // "Wann läuft der Vertrag aus?" while a contract is open in the folder refers to that one.
  const opened = page?.contractId && /\b(?:dies\w*|den|der|das|dem)\s+(?:vertrag|abo|versicherung)\b|\bhier\b/.test(lower)
    ? contracts.find((contract) => contract.id === page.contractId) : undefined;
  const match = matchName(text, contracts, (contract) => contract.name) ?? opened;
  if (match) return singleContract(match, lower, today);
  const list = /\b(?:welche|wie ?viele|zeig|liste|übersicht|uebersicht|alle|meine)\b|\b(?:abos?|abonnements?|verträge|vertraege|versicherungen)\b/.test(lower);
  if (!list) return fallback();
  const running = contracts.filter((contract) => isRunning(contract, today));
  const type = typeWords.find(([pattern]) => pattern.test(lower) && !/verträge|vertraege|vertrag\b/.test(lower));
  const soon = /bald|demnächst|demnaechst|kündigungsfrist|kuendigungsfrist|laufen .{0,20}aus|enden/.test(lower);
  let shown = type ? running.filter((contract) => type[1].includes(contract.type)) : running;
  if (soon) shown = shown.filter((contract) => contract.deadline).sort((a, b) => a.deadline!.localeCompare(b.deadline!));
  if (!running.length) return {
    text: "Dazu habe ich keine ausreichenden Daten: In deinen Buchungen finde ich noch keine wiederkehrenden Zahlungen. Im Vertragsordner kannst du Verträge auch selbst anlegen.",
    card: { kind: "contracts", title: "Verträge & Abos", lines: [], page: folder },
  };
  const monthly = round(shown.reduce((sum, contract) => sum + contract.monthly, 0));
  const review = shown.filter((contract) => contract.status === "review").length;
  const missingNotice = shown.filter((contract) => !contract.notice).length;
  const text2 = soon
    ? shown.length
      ? `Diese Fristen laufen als Nächstes ab: ${shown.slice(0, 3).map((contract) => `${contract.name} bis ${dateLabel(contract.deadline!)}`).join(", ")}.`
      : `Für keinen deiner Verträge ist eine Kündigungsfrist hinterlegt – dazu habe ich keine ausreichenden Daten. Trag Fristen im Vertragsordner ein, dann erinnere ich dich rechtzeitig.`
    : `Du hast ${plural(shown.length, type ? typeNoun(type[0]).one : "laufenden Vertrag bzw. Abo", type ? typeNoun(type[0]).many : "laufende Verträge und Abos")}, zusammen ${currency(monthly)} im Monat (${currency(round(monthly * 12))} im Jahr).` +
      (type && shown.length < running.length ? ` Insgesamt laufen ${running.length} Verträge mit ${currency(round(running.reduce((sum, contract) => sum + contract.monthly, 0)))} im Monat.` : "") +
      (review ? ` ${plural(review, "davon ist neu erkannt", "davon sind neu erkannt")} und noch zu bestätigen.` : "") +
      (missingNotice && !type ? ` Bei ${missingNotice} fehlt die Kündigungsfrist.` : "");
  const lines = shown.slice(0, 40).map((contract) => contractLine(contract, today));
  return {
    text: text2,
    card: { kind: "contracts", title: soon ? "Kündigungsfristen" : type ? typeNoun(type[0]).title : "Verträge & Abos", total: -monthly, lines, page: folder,
      note: "Erkannt aus wiederkehrenden Abbuchungen und deinen Fixkosten. Fristen kennt Finanzblick nur, wenn du sie einträgst." },
    suggestions: [shown[0] ? `Was kostet mich ${shown[0].name} im Jahr?` : "Wie viel kann ich noch ausgeben?", "Welche Verträge kann ich kündigen?", "Was fällt dir auf?"],
  };
}

// Alias first, then a known brand, otherwise the booking text as the user saw it.
const merchantOf = (row: Transaction) => (row.merchantAlias?.trim() || knownMerchantName(row.description) || row.description.replace(/\s+/g, " ").trim()).slice(0, 60);

/** Answers about the bookings the user is looking at or selected; nothing leaves the browser. */
export function contextAnswer(state: AppState, text: string, page: AssistantPageContext | null | undefined): AgentResult {
  const lower = text.toLowerCase();
  const wantsSelection = /ausgewählt|ausgewaehlt|markiert|auswahl/.test(lower);
  const ids = wantsSelection || (page?.selectedIds?.length && !/angezeigt|gefiltert|sichtbar|seite|liste/.test(lower)) ? page?.selectedIds ?? [] : page?.visibleIds ?? [];
  const byId = new Map(state.transactions.map((row) => [row.id, row]));
  const rows = ids.flatMap((id) => byId.get(id) ?? []);
  const where = page ? `${page.title}${page.month ? ` · ${page.month}` : ""}` : undefined;
  if (!page || !rows.length) return {
    text: page?.route === "/umsaetze" || wantsSelection
      ? "Dazu habe ich keine ausreichenden Daten: Gerade sind keine Buchungen ausgewählt bzw. angezeigt. Markiere Buchungen in den Umsätzen oder setze einen Filter und frag dann noch einmal."
      : `Auf ${where ?? "dieser Seite"} sehe ich keine Buchungsliste. Öffne die Umsätze, filtere oder markiere Buchungen, dann fasse ich sie dir zusammen.`,
    card: { kind: "context", title: "Diese Ansicht", lines: [], page: { label: "Umsätze öffnen", href: "/umsaetze" } },
  };
  const out = rows.filter((row) => row.amount < 0 && !row.ignored && !classify(row).isTransfer);
  const income = rows.filter((row) => row.amount > 0 && !row.ignored && !classify(row).isTransfer);
  const spent = round(-out.reduce((sum, row) => sum + row.amount, 0));
  const received = round(income.reduce((sum, row) => sum + row.amount, 0));
  const group = (key: (row: Transaction) => string) => {
    const totals = new Map<string, { amount: number; ids: string[] }>();
    for (const row of out) {
      const entry = totals.get(key(row)) ?? { amount: 0, ids: [] };
      entry.amount = round(entry.amount - row.amount);
      entry.ids.push(row.id);
      totals.set(key(row), entry);
    }
    return [...totals].sort((a, b) => b[1].amount - a[1].amount);
  };
  const merchants = group(merchantOf).slice(0, 5);
  const categories = group((row) => canonicalCategory(classify(row).category)).slice(0, 5);
  const seen = new Map<string, Transaction>();
  const duplicates: [Transaction, Transaction][] = [];
  for (const row of [...out].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = `${merchantOf(row).toLowerCase()}|${row.amount.toFixed(2)}`;
    const previous = seen.get(key);
    if (previous && daysBetween(previous.date, row.date) <= 3) duplicates.push([previous, row]);
    seen.set(key, row);
  }
  const unclear = rows.filter((row) => ["Prüfen", "Sonstiges"].includes(canonicalCategory(classify(row).category)));
  const scope = ids === page.selectedIds ? "ausgewählten" : "angezeigten";
  const count = scope === "angezeigten" && page.visibleCount && page.visibleCount > rows.length ? `${rows.length} von ${page.visibleCount}` : String(rows.length);
  const lines: Line[] = [
    { label: "Ausgaben", value: -spent, detail: plural(out.length, "Buchung", "Buchungen"), transactionIds: out.slice(0, 50).map((row) => row.id) },
    ...(received ? [{ label: "Eingänge", value: received, tone: "good" as const, detail: plural(income.length, "Buchung", "Buchungen"), transactionIds: income.slice(0, 50).map((row) => row.id) }] : []),
    ...categories.map(([name, entry]) => ({ label: name, value: -entry.amount, detail: "Kategorie", transactionIds: entry.ids.slice(0, 50) })),
    ...merchants.slice(0, 3).map(([name, entry]) => ({ label: name, value: -entry.amount, detail: `Händler · ${plural(entry.ids.length, "Buchung", "Buchungen")}`, transactionIds: entry.ids.slice(0, 50) })),
    ...duplicates.slice(0, 3).map(([first, second]) => ({ label: `Möglicherweise doppelt: ${merchantOf(first)}`, value: first.amount, tone: "warn" as const,
      detail: `${dateLabel(first.date)} und ${dateLabel(second.date)}`, transactionIds: [first.id, second.id] })),
    ...(unclear.length ? [{ label: "Unklare Kategorie", tone: "warn" as const, detail: `${plural(unclear.length, "Buchung", "Buchungen")} in Prüfen oder Sonstiges`, transactionIds: unclear.slice(0, 50).map((row) => row.id) }] : []),
  ];
  const parts = [
    `Bei den ${count} ${scope} Buchungen${page.filters?.length ? ` (${page.filters.join(", ")})` : ""} sind es ${currency(spent)} Ausgaben${received ? ` und ${currency(received)} Eingänge` : ""}.`,
    categories[0] ? `Am meisten geht an ${categories[0][0]} (${currency(categories[0][1].amount)})${merchants[0] ? `, größter Händler ist ${merchants[0][0]} (${currency(merchants[0][1].amount)})` : ""}.` : "",
    duplicates.length ? `${plural(duplicates.length, "Paar sieht", "Paare sehen")} nach einer Doppelbuchung aus.` : "",
    unclear.length ? `${plural(unclear.length, "Buchung hat", "Buchungen haben")} noch keine klare Kategorie.` : "",
  ].filter(Boolean);
  return {
    text: parts.join(" "),
    card: { kind: "context", title: `Ausgewertet: ${where}`, total: -spent, lines: lines.slice(0, 40), transactionIds: rows.slice(0, 50).map((row) => row.id) },
    suggestions: [unclear.length ? "Ordne alle offenen Buchungen zu" : "Wo gebe ich mehr aus als letzten Monat?", duplicates.length ? "Wurde ich doppelt abgebucht?" : "Was fällt dir auf?"],
  };
}

const severityTone = { high: "bad", medium: "warn", low: "info" } as const;

/** Current proactive hints as an answer; dismissed hints are left out like on the dashboard. */
export function insightsAnswer(state: AppState, dashboard: Dashboard, today: string, insights?: CopilotInsight[]): AgentResult {
  const contracts = detectContracts(state, today);
  const list = insights ?? buildCopilotInsights(state, dashboard, today, { contracts, forecast: monthEndForecast(state, dashboard, today, contracts) });
  if (!list.length) return {
    text: "Mir fällt gerade nichts Dringendes auf: keine Budgetüberschreitung, keine Frist in den nächsten 30 Tagen, keine Doppelbuchung und keine ungewöhnlich hohen Ausgaben.",
    card: { kind: "insights", title: "Hinweise", lines: [] },
    suggestions: ["Wie viel kann ich noch ausgeben?", "Welche Abos habe ich?"],
  };
  const important = list.filter((item) => item.severity === "high");
  return {
    text: `${plural(list.length, "Punkt fällt", "Punkte fallen")} mir auf${important.length ? `, am wichtigsten: ${important.map((item) => item.title).slice(0, 2).join(" und ")}` : ""}.`,
    card: { kind: "insights", title: "Hinweise", lines: list.slice(0, 12).map((item) => ({ label: item.title, tone: severityTone[item.severity], detail: item.text,
      ...(item.amount !== undefined ? { value: item.amount } : {}) })) },
    suggestions: list.slice(0, 3).map((item) => item.prompt),
  };
}

/** "Wo gebe ich mehr aus als letzten Monat?" compared at the same day of the month, plus the three-month average. */
export function trendAnswer(state: AppState, today: string): AgentResult {
  const month = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  const previous = [1, 2, 3].map((offset) => addMonths(month, -offset));
  const totals = new Map<string, { now: number; months: number[]; ids: string[] }>();
  let history = 0;
  for (const { row, category } of ledger(state)) {
    if (row.amount >= 0 || row.ignored || row.date > today || Number(row.date.slice(8, 10)) > day) continue;
    const index = previous.indexOf(row.date.slice(0, 7));
    if (row.date.slice(0, 7) !== month && index < 0) continue;
    const name = canonicalCategory(category);
    const entry = totals.get(name) ?? { now: 0, months: [0, 0, 0], ids: [] };
    if (index < 0) { entry.now = round(entry.now - row.amount); entry.ids.push(row.id); }
    else { entry.months[index] = round(entry.months[index] - row.amount); if (index === 0) history++; }
    totals.set(name, entry);
  }
  const page = { label: "Umsätze dieses Monats", href: ledgerHref({ month }) };
  if (!history) return {
    text: `Dazu habe ich keine ausreichenden Daten: Für ${monthLabel(previous[0])} gibt es keine Buchungen zum Vergleich.`,
    card: { kind: "answer", title: "Mehr als im Vormonat", lines: [], page },
  };
  const rows = [...totals].map(([category, entry]) => ({ category, ...entry, last: entry.months[0], average: round(entry.months.reduce((sum, value) => sum + value, 0) / 3) }))
    .map((item) => ({ ...item, delta: round(item.now - item.last) }));
  const more = rows.filter((item) => item.delta >= 10).sort((a, b) => b.delta - a.delta);
  const lines: Line[] = more.slice(0, 12).map((item) => ({
    label: item.category, value: -item.now, tone: item.now > item.average * 1.2 ? "warn" : "info",
    detail: `+${currency(item.delta)} gegenüber ${monthLabel(previous[0], true)} bis zum ${day}. · Ø 3 Monate ${currency(item.average)}`,
    transactionIds: item.ids.slice(0, 50),
  }));
  const top = more.slice(0, 3).map((item) => `${item.category} (+${currency(item.delta)})`);
  return {
    text: more.length
      ? `Bis zum ${day}. gibst du vor allem hier mehr aus als im ${monthLabel(previous[0])} zum gleichen Zeitpunkt: ${top.join(", ")}.` +
        (more[0].now > more[0].average * 1.2 ? ` ${more[0].category} liegt auch über dem Schnitt der letzten drei Monate (${currency(more[0].average)}).` : "")
      : `Bis zum ${day}. gibst du in keiner Kategorie spürbar mehr aus als im ${monthLabel(previous[0])} zum gleichen Zeitpunkt.`,
    card: { kind: "answer", title: "Mehr als im Vormonat", lines, page, note: "Verglichen wird jeweils bis zum selben Tag im Monat, damit ein laufender Monat fair bleibt." },
    suggestions: more[0] ? [`Wie viel habe ich diesen Monat für ${more[0].category} ausgegeben?`, "Was fällt dir auf?"] : ["Was fällt dir auf?"],
  };
}

export const trendQuestion = (lower: string) =>
  /\bwo (?:gebe|geb|gab|habe|hab|hätte|haette) ich (?:\S+ ){0,3}mehr (?:geld )?(?:\S+ )?als (?:im |letzten |vorigen |im letzten |im vorigen )?(?:monat|vormonat)\b/.test(lower) ||
  /\bwo (?:sind|waren) (?:meine |die )?ausgaben (?:\S+ )?gestiegen\b|\bwas ist (?:diesen monat )?(?:gestiegen|mehr geworden)\b/.test(lower);
