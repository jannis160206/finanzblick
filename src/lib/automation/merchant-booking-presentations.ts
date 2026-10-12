import { actualBookings, classify } from "@/lib/calc";
import { shouldShowMerchantMark } from "@/lib/merchant-mark-policy";
import type { AccountDatabase } from "@/lib/server/database";
import type { Transaction } from "@/lib/types";
import { createAccountMerchantResolver } from "./aliases";
import { merchantEvidence, qualifiedCompany } from "./evidence";
import {
  logoAccountIdSchema,
  type AuthorizedLogoGrant,
} from "./merchant-logo-grant-metadata";
import {
  accountMerchantNamePresentations,
  accountMerchantPresentations,
} from "./merchant-logo-presentations";
import { merchantLogoBookingId, merchantLogoName } from "./merchant-mark-name";
import { merchantMarksRequestSchema } from "./merchant-presentation-schema";
import { MerchantIndex, normalizeMerchantDescriptor } from "./merchants";
import type { AutomationStore } from "./store";
import { isIncomeCategory } from "@/lib/fixed";
import {
  availableLocalLogoGrants,
  normalizeLocalLogoName,
} from "./merchant-local-logos";

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
    const supplied = await availableLocalLogoGrants(store, userId);
    const localIdentities = new Map<
      string,
      {
        grant: AuthorizedLogoGrant;
        aliases: string[];
      }
    >();
    for (const [name, grant] of supplied) {
      const entry = localIdentities.get(grant.merchantId) ?? {
        grant,
        aliases: [],
      };
      entry.aliases.push(name);
      localIdentities.set(grant.merchantId, entry);
    }
    // Supplied booking names are not public merchant definitions: they may
    // contain more than four words or reference a payment provider directly.
    const localDescriptors = [...localIdentities.values()].flatMap(
      ({ grant, aliases }) =>
        [...new Set(aliases.map(normalizeMerchantDescriptor))]
          .filter(Boolean)
          .map((name) => ({ name, grant })),
    );
    const index = displayIndex(store);
    function suppliedIdentity(text: string, income: boolean) {
      const exact = supplied.get(normalizeLocalLogoName(text));
      if (exact) return exact.merchantId;
      if (income)
        text = text.replace(
          /^(?:lohn\s*[/&]\s*gehalt|lohn\s+und\s+gehalt|lohn|gehalt|salary)(?:\s+von)?\s+/iu,
          "",
        );
      const direct = supplied.get(normalizeLocalLogoName(text));
      if (direct) return direct.merchantId;
      const normalized = normalizeMerchantDescriptor(text);
      if (!normalized || normalized.split(" ").length > 32) return null;
      const matches = localDescriptors.filter(({ name }) =>
        ` ${normalized} `.includes(` ${name} `),
      );
      const identities = new Set(matches.map(({ grant }) => grant.merchantId));
      if (identities.size !== 1) return null;
      const local = matches.find(
        ({ name }) => normalized === name || normalized.startsWith(`${name} `),
      )?.grant;
      if (!local || qualifiedCompany(text, local.canonicalName)) return null;
      const publicMatch = index.match(text);
      if (
        publicMatch.requiresManualReview &&
        publicMatch.method !== "none" &&
        !publicMatch.merchant
      )
        return null;
      if (
        publicMatch.merchant &&
        ![
          publicMatch.merchant.canonicalName,
          ...publicMatch.merchant.aliases,
        ].some(
          (name) =>
            supplied.get(normalizeLocalLogoName(name))?.merchantId ===
            local.merchantId,
        )
      )
        return null;
      return local.merchantId;
    }
    const resolveAccount = createAccountMerchantResolver(state);
    for (const [id, row] of rows) {
      if (
        !row ||
        !merchantLogoBookingId(row) ||
        !shouldShowMerchantMark(row, classify(row), true)
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
      const income = isIncomeCategory(classify(row).category);
      const local = suppliedIdentity(evidence.text, income);
      const raw =
        row.rawDescription && row.rawDescription !== row.description
          ? merchantEvidence({ ...row, description: row.rawDescription }, index)
          : null;
      const rawLocal =
        raw?.kind === "consistent" ? suppliedIdentity(raw.text, income) : null;
      const payers = income
        ? [
            ...(row.rawDescription ?? "").matchAll(
              /\b(?:auftraggeber|absender|zahler|payer|von)\s*:\s*([\s\S]*?)(?=\s*(?:verwendungszweck(?:\/text)?|zahlungsreferenz|auftraggeberreferenz|mandat|referenz|iban|bic)\s*:|$)/gi,
            ),
          ].map((match) => suppliedIdentity(match[1].trim(), true))
        : [];
      const localIds = new Set(
        [local, rawLocal, ...payers].filter(
          (value): value is string => !!value,
        ),
      );
      const displayMatch = index.match(evidence.text);
      const rawConflicts =
        (rawLocal || payers.some(Boolean)) &&
        !local &&
        ((displayMatch.merchant && !row.merchantId) ||
          (displayMatch.requiresManualReview &&
            displayMatch.method !== "none" &&
            !displayMatch.merchant) ||
          raw?.kind === "conflict");
      if (localIds.size === 1 && !rawConflicts) {
        identities.set(id, [...localIds][0]);
        continue;
      }
      // A supplied exact name can correct artwork, not a stored merchant identity.
      if (row.merchantId) continue;
      if (
        !row.merchantAlias?.trim() &&
        isIncomeCategory(classify(row).category)
      )
        continue;
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
