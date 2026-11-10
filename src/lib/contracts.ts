import { brandKey } from "@/lib/ai/evidence";
import { round } from "@/lib/calc";
import { currency, dateLabel } from "@/lib/format";
import { canonicalCategory, groupedContractCategories, type Category } from "@/lib/categories";
import { contractNotice, contractTypeOf, type ContractType } from "@/lib/contract-types";
import { fixedBookingHistory } from "@/lib/fixed-cost-schedule";
import { fixedRowCategory } from "@/lib/fixed";
import { ledger } from "@/lib/insights";
import type { AppState, ContractInterval, ContractNotice, ContractOverride, FinanceRow, Transaction } from "@/lib/types";

export type ContractStatus = "review" | "active" | "cancelled" | "ignored";
export type ContractSource = "detected" | "fixed" | "manual";
export type ContractCharge = { id: string; date: string; amount: number };

export type Contract = {
  id: string;
  name: string;
  category: Category;
  type: ContractType;
  source: ContractSource;
  status: ContractStatus;
  amount: number;
  interval: ContractInterval;
  monthly: number;
  yearly: number;
  account?: string;
  lastDate?: string;
  nextDate?: string;
  charges: ContractCharge[];
  priceChange?: { from: number; to: number; percent: number; date: string };
  confidence: number;
  notice?: ContractNotice;
  termEnd?: string;
  autoRenew: boolean;
  renewalMonths: number;
  deadline?: string;
  effectiveEnd?: string;
  cancelledAt?: string;
  note?: string;
  fixedRowId?: string;
  missed: boolean;
  edited: boolean;
  booking?: Transaction;
};

export type ContractReminder = {
  id: string;
  contractId: string;
  kind: "deadline" | "price" | "missed";
  date: string;
  tone: "info" | "warn" | "bad";
  title: string;
  body: string;
};

export type ContractSummary = {
  monthly: number;
  yearly: number;
  active: number;
  review: number;
  next?: Contract;
  nextDeadline?: Contract;
};

export const intervalMonths: Record<ContractInterval, number> = { monthly: 1, quarterly: 3, halfyearly: 6, yearly: 12 };
export const intervalLabel: Record<ContractInterval, string> = {
  monthly: "monatlich", quarterly: "vierteljährlich", halfyearly: "halbjährlich", yearly: "jährlich",
};
export const intervalAdverb: Record<ContractInterval, string> = {
  monthly: "im Monat", quarterly: "im Quartal", halfyearly: "im Halbjahr", yearly: "im Jahr",
};
const gapWindows: Record<ContractInterval, [number, number]> = {
  monthly: [25, 35], quarterly: [80, 100], halfyearly: [170, 195], yearly: [350, 380],
};
const graceDays: Record<ContractInterval, number> = { monthly: 20, quarterly: 40, halfyearly: 60, yearly: 60 };
const detectionOrder: ContractInterval[] = ["monthly", "quarterly", "halfyearly", "yearly"];
// Shops visited regularly are spending, not contracts.
const everydayCategories = new Set<Category>([
  "Lebensmittel", "Mittagessen", "Restaurants", "Lieferdienste", "Cafés & Snacks", "Tanken", "Drogerie",
  "Rückerstattungen", "Transfer", "Transfer intern", "Gehalt", "Einkommen", "Rufbereitschaft",
]);
const contractCategories = new Set<Category>([...groupedContractCategories, "Leasing", "Sport & Fitness"]);

const DAY_MS = 86_400_000;
const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, days: number) => iso(time(date) + days * DAY_MS);
export const daysBetween = (from: string, to: string) => Math.round((time(to) - time(from)) / DAY_MS);

export function addMonthsToDate(date: string, months: number, anchorDay = Number(date.slice(8, 10))) {
  const index = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 + months;
  const year = Math.floor(index / 12), month = index % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(Math.min(anchorDay, last)).padStart(2, "0")}`;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const monthlyEquivalent = (amount: number, interval: ContractInterval) => round(amount / intervalMonths[interval]);

export function nextAfter(date: string, interval: ContractInterval, today: string) {
  const anchor = Number(date.slice(8, 10));
  let next = date;
  for (let step = 1; next < today && step < 600; step++) next = addMonthsToDate(date, step * intervalMonths[interval], anchor);
  return next;
}

export function noticeLabel(notice: ContractNotice) {
  const units = { days: ["Tag", "Tage"], weeks: ["Woche", "Wochen"], months: ["Monat", "Monate"] } as const;
  return `${notice.value} ${units[notice.unit][notice.value === 1 ? 0 : 1]}`;
}

function beforeNotice(date: string, notice: ContractNotice) {
  if (notice.unit === "months") return addMonthsToDate(date, -notice.value);
  return addDays(date, -(notice.unit === "weeks" ? notice.value * 7 : notice.value));
}

/** Latest day to give notice so the contract ends at the next possible date instead of renewing. */
export function cancellationWindow(
  input: { notice?: ContractNotice; termEnd?: string; nextDate?: string; interval: ContractInterval; autoRenew?: boolean; renewalMonths?: number },
  today: string,
): { deadline: string; effectiveEnd: string } | undefined {
  if (!input.notice) return undefined;
  let end = input.termEnd ?? input.nextDate;
  if (!end) return undefined;
  const step = input.termEnd ? input.renewalMonths ?? intervalMonths[input.interval] : intervalMonths[input.interval];
  const anchor = Number(end.slice(8, 10));
  const start = end;
  for (let index = 1; index < 600; index++) {
    const deadline = beforeNotice(end, input.notice);
    if (deadline >= today) return { deadline, effectiveEnd: end };
    if (input.termEnd && input.autoRenew === false) return undefined;
    end = addMonthsToDate(start, index * step, anchor);
  }
  return undefined;
}

type Charge = { row: Transaction; category: Category; amount: number };

function amountClusters(entries: Charge[]) {
  const clusters: Charge[][] = [];
  for (const entry of entries) {
    let best: Charge[] | undefined;
    let bestDiff = Infinity;
    for (const cluster of clusters) {
      const last = cluster[cluster.length - 1].amount;
      const diff = Math.abs(entry.amount - last) / Math.max(entry.amount, last);
      if (diff <= 0.25 && diff < bestDiff) { best = cluster; bestDiff = diff; }
    }
    if (best) best.push(entry); else clusters.push([entry]);
  }
  return clusters;
}

function recurringRun(cluster: Charge[], interval: ContractInterval) {
  const [low, high] = gapWindows[interval];
  const run: Charge[] = [];
  for (let index = cluster.length - 1; index >= 0; index--) {
    const entry = cluster[index];
    if (!run.length) { run.unshift(entry); continue; }
    const gap = daysBetween(entry.row.date, run[0].row.date);
    if (gap < low) continue;
    if (gap > high) break;
    if (Math.abs(entry.amount - run[0].amount) > run[0].amount * 0.25) break;
    run.unshift(entry);
  }
  return run;
}

function priceChangeOf(amounts: number[], date: string) {
  if (amounts.length < 2) return undefined;
  const usual = median(amounts.slice(0, -1));
  const current = amounts[amounts.length - 1];
  const percent = usual ? (current - usual) / usual * 100 : 0;
  if (Math.abs(percent) <= 2 || Math.abs(current - usual) < 0.5) return undefined;
  return { from: round(usual), to: round(current), percent: Math.round(percent * 10) / 10, date };
}

const merchantName = (row: Transaction) => row.merchantAlias?.trim() || row.description.trim().slice(0, 60);
const accountName = (row: Transaction) => row.pocket ? `${row.bank} · ${row.pocket}` : row.bank;

type Draft = Omit<Contract, "status" | "deadline" | "effectiveEnd" | "edited" | "autoRenew" | "renewalMonths" | "missed"> & { stale: boolean };

function detectFromBookings(state: AppState, today: string): Draft[] {
  const groups = new Map<string, Charge[]>();
  for (const { row, category } of ledger(state)) {
    if (row.amount >= 0 || row.ignored || row.date > today || everydayCategories.has(category)) continue;
    const brand = brandKey(row);
    if (!brand) continue;
    groups.set(brand, [...(groups.get(brand) ?? []), { row, category, amount: Math.abs(row.amount) }]);
  }
  const drafts: Draft[] = [];
  for (const [brand, entries] of groups) {
    entries.sort((a, b) => a.row.date.localeCompare(b.row.date) || a.row.id.localeCompare(b.row.id));
    const found: { run: Charge[]; interval: ContractInterval }[] = [];
    for (const cluster of amountClusters(entries)) {
      for (const interval of detectionOrder) {
        const run = recurringRun(cluster, interval);
        const latest = run[run.length - 1];
        const minimum = interval === "monthly" && !contractCategories.has(latest.category) ? 3 : 2;
        if (run.length < minimum) continue;
        const span = cluster.filter((entry) => entry.row.date >= run[0].row.date).length;
        if (span > run.length + Math.floor(run.length / 3)) continue;
        found.push({ run, interval });
        break;
      }
    }
    const primary = [...found].sort((a, b) => b.run.length - a.run.length || a.run[0].row.date.localeCompare(b.run[0].row.date))[0];
    for (const { run, interval } of found) {
      const latest = run[run.length - 1];
      const nextDate = addMonthsToDate(latest.row.date, intervalMonths[interval]);
      const amounts = run.map((entry) => entry.amount);
      const stable = amounts.every((amount) => Math.abs(amount - latest.amount) <= Math.max(0.05, latest.amount * 0.05));
      const contractish = contractCategories.has(latest.category);
      const confidence = Math.min(0.95, round(
        (interval === "monthly" ? Math.min(run.length, 6) / 8 : Math.min(run.length, 3) / 4) +
        (stable ? 0.1 : 0) + (contractish ? 0.1 : 0),
      ));
      const name = merchantName(latest.row);
      drafts.push({
        id: primary.run === run ? brand : `${brand}#${Math.round(run[0].amount * 100)}`,
        name, category: latest.category, type: contractTypeOf(name, latest.category), source: "detected",
        amount: round(latest.amount), interval,
        monthly: monthlyEquivalent(latest.amount, interval), yearly: round(latest.amount * 12 / intervalMonths[interval]),
        account: accountName(latest.row), lastDate: latest.row.date, nextDate,
        charges: run.slice(-24).reverse().map((entry) => ({ id: entry.row.id, date: entry.row.date, amount: round(entry.amount) })),
        ...(() => { const change = priceChangeOf(amounts, latest.row.date); return change ? { priceChange: change } : {}; })(),
        confidence, booking: latest.row,
        stale: daysBetween(nextDate, today) > graceDays[interval],
      });
    }
  }
  return drafts;
}

function rowInterval(row: FinanceRow, month: string): ContractInterval {
  const months = Object.entries(row.values).filter(([key, value]) => key >= month && (value ?? 0) > 0).map(([key]) => key).sort().slice(0, 12);
  if (months.length < 2) return months.length && Object.keys(row.values).filter((key) => key >= month).length >= 12 ? "yearly" : "monthly";
  const [first, second] = months;
  const gap = (Number(second.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(second.slice(5, 7)) - Number(first.slice(5, 7));
  return gap >= 12 ? "yearly" : gap >= 6 ? "halfyearly" : gap >= 3 ? "quarterly" : "monthly";
}

function detectFromFixedRows(state: AppState, drafts: Draft[], today: string): Draft[] {
  const month = today.slice(0, 7);
  const history = fixedBookingHistory(state);
  const chargeOwner = new Map<string, Draft>();
  for (const draft of drafts) for (const charge of draft.charges) chargeOwner.set(charge.id, draft);
  const result: Draft[] = [];
  for (const row of state.financeRows) {
    if (row.kind !== "fixed") continue;
    const upcoming = Object.entries(row.values).filter(([key, value]) => key >= month && (value ?? 0) > 0).sort(([a], [b]) => a.localeCompare(b));
    if (!upcoming.length) continue;
    const bookings = [...(history.get(row.id) ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const ids = new Set([...bookings.map((booking) => booking.id), ...row.fixedSource?.bookingIds ?? []]);
    const linked = [...ids].flatMap((id) => chargeOwner.get(id) ?? []);
    if (linked.length) {
      for (const draft of new Set(linked)) draft.fixedRowId ??= row.id;
      continue;
    }
    const category = fixedRowCategory(row) ?? row.planCategory ?? "Sonstiges";
    if (everydayCategories.has(canonicalCategory(category))) continue;
    const interval = rowInterval(row, month);
    const [firstMonth, firstValue] = upcoming[0];
    const amount = round(firstValue ?? 0);
    const latest = bookings.at(-1);
    const thisMonthBooked = bookings.some((booking) => booking.date.startsWith(month));
    const nextDate = latest
      ? nextAfter(addMonthsToDate(latest.date, intervalMonths[interval]), interval, thisMonthBooked ? addDays(today, 1) : `${month}-01`)
      : firstMonth === month ? today : `${firstMonth}-01`;
    const name = row.fixedSource?.labelOverride ?? row.label;
    result.push({
      id: `fixed:${row.id}`, name, category, type: contractTypeOf(name, category), source: "fixed",
      amount, interval, monthly: monthlyEquivalent(amount, interval), yearly: round(amount * 12 / intervalMonths[interval]),
      ...(latest ? { account: accountName(latest), lastDate: latest.date, booking: latest } : {}),
      nextDate,
      charges: bookings.slice(-24).reverse().map((booking) => ({ id: booking.id, date: booking.date, amount: round(Math.abs(booking.amount)) })),
      ...(() => { const change = priceChangeOf(bookings.map((booking) => Math.abs(booking.amount)), latest?.date ?? today); return change ? { priceChange: change } : {}; })(),
      confidence: 1, fixedRowId: row.id, stale: false,
    });
  }
  return result;
}

const editedKeys = ["name", "category", "amount", "interval", "nextDate", "notice", "termEnd", "autoRenew", "renewalMonths", "note"] as const;

function finish(draft: Draft, override: ContractOverride | undefined, today: string): Contract | undefined {
  if (draft.stale && !override?.status) return undefined;
  const interval = override?.interval ?? draft.interval;
  const amount = round(override?.amount ?? draft.amount);
  const name = override?.name ?? draft.name;
  const category = override?.category ?? draft.category;
  const plannedNext = override?.nextDate ?? draft.nextDate;
  // Bank bookings may arrive late; manual contracts have no booking to wait for.
  const pending = draft.source === "manual" ? today : addDays(today, -graceDays[interval]);
  const after = draft.lastDate && addDays(draft.lastDate, 1) > pending ? addDays(draft.lastDate, 1) : pending;
  const nextDate = plannedNext ? nextAfter(plannedNext, interval, after) : undefined;
  const status: ContractStatus = override?.status === "ignored" ? "ignored"
    : override?.status === "cancelled" ? "cancelled"
      : override?.status === "confirmed" || draft.source !== "detected" || draft.fixedRowId ? "active" : "review";
  const type = contractTypeOf(name, category);
  const renewalMonths = override?.renewalMonths ?? (type === "insurance" ? 12 : intervalMonths[interval]);
  const autoRenew = override?.autoRenew ?? true;
  const window = status === "active" || status === "review"
    ? cancellationWindow({ notice: override?.notice, termEnd: override?.termEnd, nextDate, interval, autoRenew, renewalMonths }, today)
    : undefined;
  const { stale, ...rest } = draft;
  return {
    ...rest, name, category, type, interval, amount, status, autoRenew, renewalMonths,
    monthly: monthlyEquivalent(amount, interval), yearly: round(amount * 12 / intervalMonths[interval]),
    ...(nextDate ? { nextDate } : {}),
    ...(override?.notice ? { notice: override.notice } : {}),
    ...(override?.termEnd ? { termEnd: override.termEnd } : {}),
    ...(override?.cancelledAt ? { cancelledAt: override.cancelledAt } : {}),
    ...(override?.note ? { note: override.note } : {}),
    ...(window ? { deadline: window.deadline, effectiveEnd: window.effectiveEnd } : {}),
    missed: stale,
    edited: draft.source !== "manual" && !!override && editedKeys.some((key) => override[key] !== undefined),
  };
}

function manualDraft(override: ContractOverride, today: string): Draft | undefined {
  if (!override.manual || !override.name || override.amount === undefined || !override.interval || !override.nextDate) return undefined;
  const category = override.category ?? "Sonstiges";
  return {
    id: override.id, name: override.name, category, type: contractTypeOf(override.name, category), source: "manual",
    amount: round(override.amount), interval: override.interval,
    monthly: monthlyEquivalent(override.amount, override.interval), yearly: round(override.amount * 12 / intervalMonths[override.interval]),
    nextDate: nextAfter(override.nextDate, override.interval, today), charges: [], confidence: 1, stale: false,
  };
}

/** Every recurring payment as a contract: detected from bookings, taken from the fixed-cost plan or added by hand. */
export function detectContracts(state: AppState, today: string): Contract[] {
  const overrides = new Map((state.contracts ?? []).map((entry) => [entry.id, entry]));
  const detected = detectFromBookings(state, today);
  const fixed = detectFromFixedRows(state, detected, today);
  const manual = (state.contracts ?? []).flatMap((entry) => manualDraft(entry, today) ?? []);
  const order: Record<ContractStatus, number> = { review: 1, active: 0, cancelled: 2, ignored: 3 };
  return [...detected, ...fixed, ...manual]
    .flatMap((draft) => finish(draft, overrides.get(draft.id), today) ?? [])
    .sort((a, b) => order[a.status] - order[b.status] || (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999") || b.monthly - a.monthly);
}

export const isRunning = (contract: Contract, today: string) =>
  contract.status === "active" || contract.status === "review" || (contract.status === "cancelled" && !!contract.cancelledAt && contract.cancelledAt > today);

export function contractSummary(contracts: Contract[], today: string): ContractSummary {
  const running = contracts.filter((contract) => isRunning(contract, today));
  const monthly = round(running.reduce((sum, contract) => sum + contract.monthly, 0));
  const upcoming = running.filter((contract) => contract.nextDate && contract.nextDate >= today)
    .sort((a, b) => a.nextDate!.localeCompare(b.nextDate!));
  const deadlines = running.filter((contract) => contract.deadline).sort((a, b) => a.deadline!.localeCompare(b.deadline!));
  return {
    monthly, yearly: round(monthly * 12),
    active: running.length,
    review: contracts.filter((contract) => contract.status === "review").length,
    ...(upcoming[0] ? { next: upcoming[0] } : {}),
    ...(deadlines[0] ? { nextDeadline: deadlines[0] } : {}),
  };
}

/** Charges of running contracts that fall into [from, to]; cancelled contracts stop at their end date. */
export function contractChargesBetween(contracts: Contract[], from: string, to: string, today: string) {
  const result: { contract: Contract; date: string; amount: number }[] = [];
  for (const contract of contracts) {
    if (!isRunning(contract, today) || !contract.nextDate) continue;
    const anchor = Number(contract.nextDate.slice(8, 10));
    for (let step = 0, date = contract.nextDate; date <= to && step < 400; date = addMonthsToDate(contract.nextDate, ++step * intervalMonths[contract.interval], anchor)) {
      if (contract.status === "cancelled" && contract.cancelledAt && date >= contract.cancelledAt) break;
      if (date >= from) result.push({ contract, date, amount: contract.amount });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

export function contractReminders(contracts: Contract[], today: string, horizon = 30): ContractReminder[] {
  const reminders: ContractReminder[] = [];
  for (const contract of contracts) {
    if (contract.status !== "active" && contract.status !== "review") continue;
    if (contract.deadline && contract.effectiveEnd) {
      const days = daysBetween(today, contract.deadline);
      if (days >= 0 && days <= horizon) reminders.push({
        id: `deadline:${contract.id}:${contract.deadline}`, contractId: contract.id, kind: "deadline", date: contract.deadline,
        tone: days <= 7 ? "bad" : "warn", title: `Kündigungsfrist: ${contract.name}`,
        body: `${days === 0 ? "Heute" : `Bis ${dateLabel(contract.deadline)}`} kündigen, um zum ${dateLabel(contract.effectiveEnd)} rauszukommen.`,
      });
    }
    const change = contract.priceChange;
    if (change && change.percent > 0 && daysBetween(change.date, today) <= 60) reminders.push({
      id: `price:${contract.id}:${change.date}`, contractId: contract.id, kind: "price", date: change.date, tone: "warn",
      title: `Preiserhöhung: ${contract.name}`,
      body: `${currency(change.from)} → ${currency(change.to)} (+${change.percent.toLocaleString("de-AT")} %), ${currency(round((change.to - change.from) * 12 / intervalMonths[contract.interval]))} mehr im Jahr.`,
    });
    if (contract.missed && contract.status === "active" && contract.nextDate) reminders.push({
      id: `missed:${contract.id}:${contract.lastDate ?? contract.nextDate}`, contractId: contract.id, kind: "missed", date: contract.nextDate, tone: "info",
      title: `Abbuchung ausgeblieben: ${contract.name}`,
      body: `Die erwartete Abbuchung ist nicht gekommen. Gekündigt? Dann markiere den Vertrag als gekündigt.`,
    });
  }
  const rank = { bad: 0, warn: 1, info: 2 };
  return reminders.sort((a, b) => rank[a.tone] - rank[b.tone] || a.date.localeCompare(b.date));
}

export const typicalNotice = (contract: Pick<Contract, "type">) => contractNotice[contract.type];

export function upsertContractOverride(current: ContractOverride[] | undefined, id: string, patch: Partial<Omit<ContractOverride, "id" | "updatedAt">>, at = Date.now()): ContractOverride[] {
  const list = current ?? [];
  const previous = list.find((entry) => entry.id === id);
  const merged = Object.fromEntries(Object.entries({ ...previous, ...patch, id, updatedAt: at }).filter(([, value]) => value !== undefined)) as ContractOverride;
  return previous ? list.map((entry) => entry.id === id ? merged : entry) : [...list, merged];
}
