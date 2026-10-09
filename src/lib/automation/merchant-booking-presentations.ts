import { actualBookings, classify } from "@/lib/calc";
import { shouldShowMerchantMark } from "@/lib/merchant-mark-policy";
import type { AccountDatabase } from "@/lib/server/database";
import type { Transaction } from "@/lib/types";
import { createAccountMerchantResolver } from "./aliases";
import { merchantEvidence, qualifiedCompany } from "./evidence";
import { logoAccountIdSchema } from "./merchant-logo-grant-metadata";
import {
  accountMerchantNamePresentations,
  accountMerchantPresentations,
} from "./merchant-logo-presentations";
import { merchantLogoBookingId, merchantLogoName } from "./merchant-mark-name";
import { merchantMarksRequestSchema } from "./merchant-presentation-schema";
import { MerchantIndex } from "./merchants";
import type { AutomationStore } from "./store";

const indices = new WeakMap<
  AccountDatabase,
  { revision: string; index: MerchantIndex }
>();

function displayIndex(store: AutomationStore) {
  // data_version covers other connections; total_changes also covers this one.
  const revision = store.accounts.read((db) =>
    JSON.stringify([
      db.prepare("PRAGMA data_version").get(),
      db.prepare("SELECT total_changes()").get(),
    ]),
  );
  const cached = indices.get(store.accounts);
  if (cached?.revision === revision) return cached.index;
  const index = new MerchantIndex(store.loadMerchants());
  indices.set(store.accounts, { revision, index });
  return index;
}

export async function accountMerchantBookingPresentations(
  store: AutomationStore,
  bookingIds: string[],
  userId: string,
) {
  logoAccountIdSchema.parse(userId);
  const input = merchantMarksRequestSchema.parse({
    merchantIds: [],
    bookingIds,
  });
  const wanted = new Set(input.bookingIds);
  if (!wanted.size) return [];
  const state = store.accounts.getFinance(userId).state;
  const rows = new Map<string, Transaction | null>();
  for (const row of state ? actualBookings(state) : []) {
    if (!wanted.has(row.id)) continue;
    rows.set(row.id, rows.has(row.id) ? null : row);
  }
  const identities = new Map<string, string>();
  const confirmedNames = new Map<string, string>();
  if (rows.size && state) {
    const index = displayIndex(store);
    const resolveAccount = createAccountMerchantResolver(state);
    for (const [id, row] of rows) {
      if (
        !row ||
        !merchantLogoBookingId(row) ||
        !shouldShowMerchantMark(row, classify(row))
      )
        continue;
      const learned = resolveAccount(row);
      if (learned.kind === "conflict") continue;
      if (learned.kind === "matched" && learned.choice.merchantAlias) {
        const name = merchantLogoName({
          merchantAlias: learned.choice.merchantAlias,
        });
        if (name) confirmedNames.set(id, name);
        continue;
      }
      const evidence = merchantEvidence(row, index);
      if (evidence.kind !== "consistent") continue;
      const match = index.match(evidence.text);
      if (
        match.merchant &&
        (match.method === "exact" || match.method === "regex") &&
        !qualifiedCompany(evidence.text, match.merchant.canonicalName)
      ) {
        identities.set(id, match.merchant.id);
      }
    }
  }
  const marks = identities.size
    ? await accountMerchantPresentations(
        store,
        { merchantIds: [...new Set(identities.values())] },
        userId,
      )
    : [];
  const byId = new Map(marks.map((mark) => [mark.merchantId, mark.logo]));
  const namedMarks = confirmedNames.size
    ? await accountMerchantNamePresentations(
        store,
        [...new Set(confirmedNames.values())],
        userId,
      )
    : [];
  const byName = new Map(
    namedMarks.map((mark) => [mark.merchantName, mark.logo]),
  );
  return [...wanted].map((bookingId) => ({
    bookingId,
    logo:
      byName.get(confirmedNames.get(bookingId) ?? "") ??
      byId.get(identities.get(bookingId) ?? "") ??
      null,
  }));
}
