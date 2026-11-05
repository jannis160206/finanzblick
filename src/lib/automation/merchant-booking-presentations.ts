import { classify } from "@/lib/calc";
import { shouldShowMerchantMark } from "@/lib/merchant-mark-policy";
import type { AccountDatabase } from "@/lib/server/database";
import type { Transaction } from "@/lib/types";
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
import {
  MerchantIndex,
  normalizeMerchantDescriptor,
  isPaymentProviderText,
  type Merchant,
} from "./merchants";
import type { AutomationStore } from "./store";
import { isIncomeCategory } from "@/lib/fixed";
import { normalizeLocalLogoName } from "./merchant-local-logos";
import { MerchantLogoRequest } from "./merchant-logo-request";
import {
  atmLogoBank,
  isAtmBooking,
  isBankLogoName,
  type AtmBankReference,
} from "@/lib/atm-logo";
import { normalizeAccount } from "@/lib/accounts";
import {
  reviewedAustrianBankIds,
  reviewedAustrianMerchants,
} from "./austrian-merchant-rules";

const indices = new WeakMap<
  AccountDatabase,
  {
    revision: string;
    index: MerchantIndex;
    bankReferences: AtmBankReference[];
  }
>();

function displayIndex(store: AutomationStore, request: MerchantLogoRequest) {
  // data_version covers other connections; total_changes also covers this one.
  const revision = store.accounts.read((db) =>
    JSON.stringify([
      db.prepare("PRAGMA data_version").get(),
      db.prepare("SELECT total_changes()").get(),
    ]),
  );
  const cached = indices.get(store.accounts);
  if (cached?.revision === revision) return cached;
  const merchants = request.merchants();
  const entry = {
    revision,
    index: new MerchantIndex(merchants),
    bankReferences: [
      ...reviewedAustrianMerchants.filter((bank) =>
        reviewedAustrianBankIds.has(bank.id),
      ),
      ...merchants.filter((merchant) => isBankLogoName(merchant.canonicalName)),
    ].map((bank) => ({
      name: bank.canonicalName,
      aliases: bank.aliases,
    })),
  };
  indices.set(store.accounts, entry);
  return entry;
}

export async function accountMerchantBookingPresentations(
  store: AutomationStore,
  bookingIds: string[],
  userId: string,
  request = new MerchantLogoRequest(store, userId),
) {
  logoAccountIdSchema.parse(userId);
  request.assertAccount(store, userId);
  const input = merchantMarksRequestSchema.parse({
    merchantIds: [],
    bookingIds,
  });
  const wanted = new Set(input.bookingIds);
  if (!wanted.size) return [];
  const lookup = request.bookings();
  const rows = new Map<string, Transaction | null>();
  for (const id of wanted) rows.set(id, lookup?.rows.get(id) ?? null);
  const identities = new Map<string, string>();
  const confirmedNames = new Map<string, string>();
  if (lookup && [...rows.values()].some(Boolean)) {
    const supplied = await request.localLogos();
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
    const { index, bankReferences: publicBanks } = displayIndex(store, request);
    const bankReferences: AtmBankReference[] = [...publicBanks];
    for (const name of supplied.keys())
      if (isBankLogoName(name)) bankReferences.push({ name, aliases: [] });
    for (const bank of lookup.banks)
      bankReferences.push({
        name: normalizeAccount({ bank, pocket: null }).bank,
        aliases: [bank],
      });
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
      // A supplied word anywhere in the booking text selects its logo, except a
      // payment provider, which only names the merchant at the start of the text.
      const local = (
        matches.find(
          ({ name }) =>
            normalized === name || normalized.startsWith(`${name} `),
        ) ?? matches.find(({ name }) => !isPaymentProviderText(name))
      )?.grant;
      if (!local || qualifiedCompany(text, local.canonicalName)) return null;
      const publicMatch = index.match(text);
      const showsLocal = (merchant: Merchant) =>
        [merchant.canonicalName, ...merchant.aliases].some(
          (name) =>
            supplied.get(normalizeLocalLogoName(name))?.merchantId ===
            local.merchantId,
        );
      // Public map copies of one brand (many "Spar" outlets) are ambiguous
      // for an identity, not for its artwork.
      const ambiguous = index.ambiguousCandidates(text);
      const sameBrand =
        ambiguous.length > 0 &&
        ambiguous.every((merchants) => merchants.every(showsLocal));
      if (
        publicMatch.requiresManualReview &&
        publicMatch.method !== "none" &&
        !publicMatch.merchant &&
        !sameBrand
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
    const resolveAccount = lookup.resolveAccount;
    for (const [id, row] of rows) {
      if (
        !row ||
        !merchantLogoBookingId(row) ||
        !shouldShowMerchantMark(row, classify(row), true)
      )
        continue;
      if (isAtmBooking(row)) {
        const bank = atmLogoBank(row, bankReferences);
        if (!bank) continue;
        const grants = new Map(
          [bank.name, ...(bank.aliases ?? [])].flatMap((name) => {
            const grant = supplied.get(normalizeLocalLogoName(name));
            return grant ? [[grant.merchantId, grant] as const] : [];
          }),
        );
        if (grants.size === 1) identities.set(id, [...grants.keys()][0]);
        else if (!grants.size && bank.explicit)
          confirmedNames.set(id, bank.name);
        continue;
      }
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
        request,
      )
    : [];
  const byId = new Map(marks.map((mark) => [mark.merchantId, mark.logo]));
  const namedMarks = confirmedNames.size
    ? await accountMerchantNamePresentations(
        store,
        [...new Set(confirmedNames.values())],
        userId,
        request,
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
