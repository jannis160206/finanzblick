import { classify } from "@/lib/calc";
import { canonicalCategory, type Category } from "@/lib/categories";
import {
  contractCandidates, contractPatch, contractRuleMatches, inferInterval, nextAfter, stepDate, suggestContractRule,
  upsertContractOverride, type Contract,
} from "@/lib/contracts";
import { cleanMerchantName } from "@/lib/merchant-display";
import type { AppState, ContractInterval, ContractMatch, ContractOverride, Transaction } from "@/lib/types";

type OverridePatch = Partial<Omit<ContractOverride, "id" | "updatedAt">>;

const MAX_IDS = 500;

/**
 * Adds or removes bookings of one contract: picked bookings join its own (detected charges stay), removed ones are
 * excluded so the automatic detection does not bring them back. Editing a suggestion confirms it unless `confirm` is false.
 */
export function contractBookingsChange(
  contract: Pick<Contract, "charges" | "status">,
  stored: Pick<ContractOverride, "bookingIds" | "excludedBookingIds"> | undefined,
  add: readonly string[],
  remove: readonly string[],
  confirm = true,
): { added: string[]; removed: string[]; patch: OverridePatch } {
  const charged = new Set(contract.charges.map((charge) => charge.id));
  const added = [...new Set(add)].filter((id) => !charged.has(id));
  const removed = [...new Set(remove)].filter((id) => charged.has(id) || !!stored?.bookingIds?.includes(id));
  const gone = new Set(removed);
  const fresh = new Set(added);
  const picked = [...new Set([...(stored?.bookingIds ?? []).filter((id) => !gone.has(id)), ...added])].slice(-MAX_IDS);
  const excluded = [...new Set([...(stored?.excludedBookingIds ?? []).filter((id) => !fresh.has(id)), ...removed])].slice(-MAX_IDS);
  const patch: OverridePatch = { bookingIds: picked.length ? picked : undefined, excludedBookingIds: excluded.length ? excluded : undefined };
  if (confirm && contract.status === "review") patch.status = "confirmed";
  return { added, removed, patch };
}

/** The contract a booking currently counts for; ignored contracts do not count. */
export function contractOfBooking(contracts: readonly Contract[], bookingId: string): Contract | undefined {
  return contracts.find((contract) => contract.status !== "ignored" && contract.charges.some((charge) => charge.id === bookingId));
}

/** Only real debits can belong to a contract – the same bookings the contract detection looks at. */
export const canHoldContract = (booking: Pick<Transaction, "amount" | "ignored">) => booking.amount < 0 && !booking.ignored;

/**
 * Moves a booking to the contract `targetId` (or just releases it with null). Every other contract that lists it lets
 * go of it, without confirming that contract.
 */
export function assignBookingToContract(state: AppState, contracts: readonly Contract[], bookingId: string, targetId: string | null, at = Date.now()): AppState {
  let list = state.contracts;
  for (const contract of contracts) {
    if (contract.status === "ignored" && contract.id !== targetId) continue;
    const holds = contract.charges.some((charge) => charge.id === bookingId);
    const stored = list?.find((entry) => entry.id === contract.id);
    const change = contract.id === targetId
      ? holds ? null : contractBookingsChange(contract, stored, [bookingId], [])
      : holds || stored?.bookingIds?.includes(bookingId) ? contractBookingsChange(contract, stored, [], [bookingId], false) : null;
    if (change && (change.added.length || change.removed.length)) list = upsertContractOverride(list, contract.id, contractPatch(contract, change.patch), at);
  }
  return list === state.contracts ? state : { ...state, contracts: list };
}

export type ContractSeed = {
  name: string;
  amount: number;
  category: Category;
  interval: ContractInterval;
  nextDate: string;
  selected: string[];
  rule?: ContractMatch;
};

const merchantOf = (row: Transaction) => (row.merchantAlias?.trim() || cleanMerchantName(row.description) || row.description).trim();

/**
 * A new contract filled in from one booking: its merchant, amount and category; the rhythm and the next charge come
 * from earlier bookings of the same merchant when there are any, otherwise monthly. The booking is the first charge.
 */
export function contractSeedFromBooking(state: AppState, booking: Transaction, today: string): ContractSeed {
  const name = merchantOf(booking).slice(0, 100);
  const key = name.toLocaleLowerCase("de-AT");
  const siblings = contractCandidates(state, today).filter((row) => row.id !== booking.id && merchantOf(row).toLocaleLowerCase("de-AT") === key);
  const dates = [...siblings.map((row) => row.date), booking.date];
  const interval = inferInterval(dates) ?? "monthly";
  const latest = dates.sort().at(-1) ?? booking.date;
  const category = canonicalCategory(classify(booking).category);
  const rule = suggestContractRule([booking]);
  return {
    name,
    amount: Math.abs(booking.amount),
    category: category === "Prüfen" ? "Abonnements" : category,
    interval,
    nextDate: nextAfter(stepDate(latest, interval, 1), interval, today),
    selected: [booking.id],
    ...(rule ? { rule } : {}),
  };
}

/** How well a contract fits a booking: same merchant or rule first, then a similar amount. */
export function contractFit(contract: Contract, booking: Transaction, stored?: Pick<ContractOverride, "match">): number {
  const name = merchantOf(booking).toLocaleLowerCase("de-AT");
  const contractName = contract.name.toLocaleLowerCase("de-AT");
  const sameName = name.length >= 3 && (contractName.includes(name) || name.includes(contractName));
  const ruled = !!stored?.match && contractRuleMatches(booking, stored.match);
  const amount = Math.abs(booking.amount);
  const close = contract.amount > 0 && Math.abs(contract.amount - amount) / contract.amount <= 0.2;
  return (sameName || ruled ? 2 : 0) + (close ? 1 : 0);
}
