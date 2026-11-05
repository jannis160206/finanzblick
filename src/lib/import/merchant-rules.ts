import { classify } from "@/lib/calc";
import { type AppState, type Transaction } from "@/lib/types";
import { ambiguousMerchant, hasTerminalText, merchantKeyText, merchantText, recoverMerchant, unresolvedTerminal } from "./merchant-description";
import { stripBankMetadata } from "./bank-description";
import { payrollCategory } from "@/lib/payroll";
import { canonicalCategory } from "@/lib/categories";
import { isIncomeCategory } from "@/lib/fixed";
import { normalizeAccount } from "@/lib/accounts";
import { hasCategoryChoice, hasManualCategory } from "@/lib/manual-category";
import { mergeConfirmedMerchantChoices } from "./merchant-choice";
import { merchantAliasAssignment } from "@/lib/merchant-identity";
import { isAutomationLocked } from "@/lib/automation/locks";
import { recurringLunchCategory } from "@/lib/recurring-purpose";

// Retain merchant words and subscription identifiers. Do not learn a blanket
// "PayPal" rule that would silently assign unrelated merchants.
export function merchantRuleKey(
  row: Pick<Transaction, "bank" | "description"> & Partial<Pick<Transaction, "merchantAlias" | "rawDescription">>,
) {
  const original = row.rawDescription ?? row.description;
  // Generic bank descriptors still need recipient/mandate identity for learning,
  // even though those private identifiers no longer appear in booking names.
  const bankIdentity = !row.merchantAlias && stripBankMetadata(original) !== original &&
    !hasTerminalText(original) &&
    !/\b(?:verwendungszweck(?:\/text)?|zahlungsreferenz|h(?:ä|ae|a)ndler(?:[\s-]*name)?|merchant(?:[\s-]*name)?)\s*:/i.test(original);
  const text = bankIdentity
    ? original.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("de-AT")
    : merchantKeyText(row.merchantAlias ?? recoverMerchant(row).description);
  const mandate = /mandat(?:sreferenz)?:\s*([^,;\s]+)/i.exec(text)?.[1];
  const merchant = mandate
    ? `mandat:${mandate}`
    : text
        .replace(
          /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/g,
          " ",
        )
        .replace(/\b(?:kartenzahlung|pos|zahlung|debit|sepa)\b/g, " ")
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
        .replace(/\b\d{5,}\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
  const bank = normalizeAccount({ bank: row.bank, pocket: null }).bank
    .trim()
    .toLowerCase()
    .replace(/^american express$/, "amex");
  return `${bank}|${merchant}`;
}
export function storedMerchantKey(key: string): string {
  const divider = key.indexOf("|");
  return divider < 0 ? key : merchantRuleKey({ bank: key.slice(0, divider), description: key.slice(divider + 1) });
}
export function isSpecificMerchantKey(key: string): boolean {
  const merchant = key.slice(key.indexOf("|") + 1).trim();
  if (!merchant || unresolvedTerminal(merchant)) return false;
  const provider = merchant.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return !/^(?:paypal(?: europe)?(?: s a r l)?(?: et cie)?(?: s c a)?|revolut(?: epayment| ltd| payments)?|sumup|stripe|adyen|klarna|mollie|worldline|pos|terminal|zahlung|online banking)$/.test(provider);
}
export function merchantAliasSourceKey(row: Parameters<typeof merchantRuleKey>[0]): string | undefined {
  const source = recoverMerchant({ ...row, merchantAlias: undefined });
  const key = merchantRuleKey(source);
  // Normalization can leave just an amount after stripping generic POS words.
  return merchantText(source.description) && isSpecificMerchantKey(key) ? key : undefined;
}

type NameBooking = Parameters<typeof merchantRuleKey>[0] &
  Partial<Pick<Transaction, "rawDetails" | "merchantId" | "merchantLogo" | "merchantMatch" | "merchantNameConfirmed">>;

function merchantNameKey(key: string) {
  const normalized = storedMerchantKey(key);
  // Recipient and mandate identifiers are scoped to their bank, unlike the
  // same named merchant paid through different accounts.
  return /\b(?:iban|bic|mandat)\b/i.test(normalized)
    ? normalized : normalized.slice(normalized.indexOf("|") + 1);
}

function merchantNameKeys(row: NameBooking) {
  return [...new Set([
    merchantAliasSourceKey(row),
    row.merchantAlias ? merchantRuleKey(row) : undefined,
  ].filter((key): key is string => !!key && isSpecificMerchantKey(key)))];
}

export function createMerchantNameApplier(state: AppState) {
  if (!state.merchantNameRules?.length)
    return <T extends NameBooking>(row: T): T => row;
  const aliases = new Map<string, Set<string>>();
  for (const rule of state.merchantNameRules ?? []) {
    if (!isSpecificMerchantKey(rule.key)) continue;
    const key = merchantNameKey(rule.key);
    const names = aliases.get(key) ?? new Set<string>();
    names.add(rule.merchantAlias);
    aliases.set(key, names);
  }
  return <T extends NameBooking>(row: T): T => {
    const names = new Set(merchantNameKeys(row).flatMap(
      (key) => [...(aliases.get(merchantNameKey(key)) ?? [])],
    ));
    if (names.size !== 1) return row;
    const merchantAlias = [...names][0];
    return merchantAlias === row.merchantAlias ? row : {
      ...row,
      ...merchantAliasAssignment(row, merchantAlias),
      merchantNameConfirmed: row.merchantNameConfirmed,
      merchantMatch: row.merchantNameConfirmed ? undefined : "rule",
    };
  };
}

export function applyMerchantNameRules(state: AppState): AppState {
  if (!state.merchantNameRules?.length) return state;
  const apply = createMerchantNameApplier(state);
  return {
    ...state,
    transactions: state.transactions.map(apply),
    ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((receipt) =>
      receipt.booking ? { ...receipt, booking: apply(receipt.booking) } : receipt,
    ) } : {}),
    ...(state.reviewQueue ? { reviewQueue: state.reviewQueue.map((item) => item.kind === "booking"
      ? { ...item, draft: apply(item.draft) }
      : { ...item, change: { ...item.change, bookings: item.change.bookings.map(apply) } },
    ) } : {}),
  };
}

export function rememberMerchantRename(
  state: AppState,
  source: NameBooking,
  merchantAlias: string,
): AppState {
  if (!merchantAliasSourceKey(source)) return state;
  const keys = new Set(merchantNameKeys(source));
  const links = new Map<string, Set<string>>();
  const link = (rowKeys: string[]) => {
    for (const key of rowKeys) {
      const name = merchantNameKey(key);
      const linked = links.get(name) ?? new Set<string>();
      rowKeys.forEach((value) => linked.add(value));
      links.set(name, linked);
    }
  };
  for (const rule of state.merchantNameRules ?? []) {
    if (!isSpecificMerchantKey(rule.key)) continue;
    link([
      storedMerchantKey(rule.key),
      merchantRuleKey({
        bank: rule.key.slice(0, rule.key.indexOf("|")),
        description: rule.merchantAlias,
      }),
    ]);
  }
  for (const row of [
    ...state.transactions,
    ...(state.fixedReceipts ?? []).flatMap((receipt) => receipt.booking ? [receipt.booking] : []),
    ...(state.reviewQueue ?? []).flatMap((item) => item.kind === "booking" ? [item.draft] : item.change.bookings),
  ]) {
    link(merchantNameKeys(row));
  }
  const visited = new Set<string>();
  for (const key of keys) {
    const name = merchantNameKey(key);
    if (visited.has(name)) continue;
    visited.add(name);
    for (const linked of links.get(name) ?? []) keys.add(linked);
  }
  const identities = new Set([...keys].map(merchantNameKey));
  const rules = new Map((state.merchantNameRules ?? []).map((rule) => [
    storedMerchantKey(rule.key),
    identities.has(merchantNameKey(rule.key)) ? { ...rule, merchantAlias } : rule,
  ]));
  for (const key of keys) rules.set(key, { key, merchantAlias });
  return applyMerchantNameRules({
    ...state,
    merchantNameRules: [...rules.values()],
    ...(state.merchantRules ? { merchantRules: state.merchantRules.map((rule) =>
      identities.has(merchantNameKey(rule.key)) && rule.merchantAlias
        ? { ...rule, merchantAlias } : rule,
    ) } : {}),
  });
}

type ClassifyBooking = (row: Transaction) => ReturnType<typeof classify>;
export type MerchantChoice = Pick<Transaction, "category" | "fixedCost" | "merchantAlias"> & { identityOnly?: boolean };

export function isAutomaticMerchantAssignment(row: Transaction): boolean {
  return !!(row.merchantId || row.merchantMatch || row.automaticCategoryEvidence) && !isAutomationLocked(row);
}

// Legacy worker imports could learn their own guesses. Keep stored rules, but
// do not treat matching automatic-only history as a user's confirmation.
export function activeMerchantRules(state: AppState) {
  const automatic = new Map<string, {
    categories: Set<Transaction["category"]>;
    assignments: Set<string>;
  }>();
  const confirmed = new Set<string>();
  const unnamedPurposes = new Map<string, Set<Transaction["category"]>>();
  for (const row of [
    ...state.transactions,
    ...(state.fixedReceipts ?? []).flatMap(item => item.booking ? [item.booking] : []),
  ]) {
    const keys = new Set([merchantRuleKey(row), merchantAliasSourceKey(row)].filter(key => key !== undefined));
    const unnamedPurpose = /^(?:hotspot|mensa|mensen)$/i.test(merchantText(recoverMerchant(row).description))
      ? recurringLunchCategory(row.description, row.date, row.amount) : undefined;
    for (const key of keys) {
      if (unnamedPurpose) {
        const purposes = unnamedPurposes.get(key) ?? new Set<Transaction["category"]>();
        purposes.add(unnamedPurpose);
        unnamedPurposes.set(key, purposes);
      }
      if (isAutomaticMerchantAssignment(row) || (row.merchantNameConfirmed && !hasCategoryChoice(row))) {
        const choices = automatic.get(key) ?? {
          categories: new Set<Transaction["category"]>(), assignments: new Set<string>(),
        };
        choices.categories.add(row.category);
        choices.assignments.add(JSON.stringify([row.category, row.merchantAlias]));
        automatic.set(key, choices);
      } else if (!row.aiAssigned && (row.is_locked || hasCategoryChoice(row) || row.categoryOverride)) confirmed.add(key);
    }
  }
  return (state.merchantRules ?? []).filter(rule => {
    if (rule.identityOnly) return true;
    const key = storedMerchantKey(rule.key);
    // Conflicting unnamed purposes stay open as automatic history grows.
    if (!rule.merchantAlias &&
      [...(unnamedPurposes.get(key) ?? [])].some((purpose) => purpose !== canonicalCategory(rule.category)))
      return true;
    const choices = automatic.get(key);
    return confirmed.has(key) || !(rule.merchantAlias
      ? choices?.assignments.has(JSON.stringify([rule.category, rule.merchantAlias]))
      : choices?.categories.has(rule.category));
  });
}

function addChoice(choices: Map<string, MerchantChoice | null>, key: string, choice: MerchantChoice) {
  const previous = choices.get(key);
  // Conflicting history is not a new decision. Keep it unresolved, independent
  // of statement order, until the user explicitly chooses this merchant again.
  if (previous === null) return;
  choices.set(key, mergeConfirmedMerchantChoices(previous ? { key, ...previous } : undefined, { key, ...choice }));
}

function merchantChoices(rows: Transaction[], classifyBooking: ClassifyBooking = classify) {
  const choices = new Map<string, MerchantChoice | null>();
  for (const row of rows) {
    // AI decisions are proposals, not the user's confirmation; never generalize them.
    if (isAutomaticMerchantAssignment(row) || row.aiAssigned) continue;
    if (row.merchantNameConfirmed && row.merchantAlias &&
      (row.category === "Prüfen" || !hasCategoryChoice(row))) {
      const sourceKey = merchantAliasSourceKey(row);
      if (sourceKey && row.amount < 0 && !classifyBooking(row).isTransfer && !payrollCategory(row))
        addChoice(choices, sourceKey, {
          merchantAlias: row.merchantAlias, category: "Prüfen", identityOnly: true,
        });
      continue;
    }
    if ((!row.categoryOverride && !hasManualCategory(row)) || row.category === "Prüfen" || payrollCategory(row)) continue;
    const key = merchantRuleKey(row);
    if (
      isSpecificMerchantKey(key) &&
      (row.merchantAlias || (!ambiguousMerchant(row) && !unresolvedTerminal(row.description))) &&
      !classifyBooking(row).isTransfer
    ) {
      const choice = {
        category: canonicalCategory(row.category),
        ...(row.fixedCost !== undefined && row.amount < 0 && !isIncomeCategory(classifyBooking(row).category)
          ? { fixedCost: row.fixedCost } : {}),
      };
      addChoice(choices, key, choice);
      // Keep the bank's original merchant key as the link for later imports.
      const sourceKey = row.merchantAlias ? merchantAliasSourceKey(row) : undefined;
      if (sourceKey && row.merchantAlias && row.amount < 0)
        addChoice(choices, sourceKey, { ...choice, merchantAlias: row.merchantAlias });
    }
  }
  return choices;
}

export function rememberMerchants(
  state: AppState,
  rows: Transaction[],
): AppState {
  const normalizedRules = (state.merchantRules ?? [])
    .map((rule) => ({ ...rule, key: storedMerchantKey(rule.key), category: canonicalCategory(rule.category) }))
    .filter((rule) => isSpecificMerchantKey(rule.key));
  const rules = new Map<string, typeof normalizedRules>();
  const active = new Set(activeMerchantRules({ ...state, merchantRules: normalizedRules }));
  for (const rule of normalizedRules) {
    const group = rules.get(rule.key) ?? [];
    group.push(rule);
    rules.set(rule.key, group);
  }
  const choices = merchantChoices(rows);
  for (const [key, choice] of choices) {
    if (!choice) continue;
    const previous = rules.get(key) ?? [];
    if (choice.identityOnly) {
      let combined = { key, ...choice };
      for (const rule of previous.filter(rule => active.has(rule))) {
        const merged = mergeConfirmedMerchantChoices(rule, combined);
        if (!merged) { combined = { key, ...choice }; break; }
        combined = merged;
      }
      rules.set(key, [combined]);
      continue;
    }
    const fixedCosts = new Set(previous.map((rule) => rule.fixedCost).filter((value) => value !== undefined));
    const aliases = new Set(previous.map((rule) => rule.merchantAlias).filter((value) => value !== undefined));
    rules.set(key, [{ key, ...(fixedCosts.size === 1 ? { fixedCost: [...fixedCosts][0] } : {}),
      ...(aliases.size === 1 ? { merchantAlias: [...aliases][0] } : {}), ...choice }]);
  }
  const applyChoice = (row: Transaction): Transaction => {
    if (row.is_locked || row.merchantNameConfirmed) return row;
    if (hasCategoryChoice(row)) return row;
    const sourceKey = merchantAliasSourceKey(row);
    const sourceChoice = sourceKey ? choices.get(sourceKey) : undefined;
    const choice = sourceChoice?.merchantAlias ? sourceChoice : choices.get(merchantRuleKey(row));
    if (!choice || (choice.merchantAlias && (row.amount >= 0 || classify(row).isTransfer))) return row;
    if (choice.identityOnly) return row;
    const updated = { ...row, category: choice.category, categoryOverride: true, includeInPlan: true,
      ...(choice.merchantAlias ? { merchantAlias: choice.merchantAlias } : {}) };
    const result = classify(updated);
    return { ...updated, category: result.category, includeInPlan: result.includeInPlan };
  };
  return rules.size
    ? {
        ...state,
        transactions: state.transactions.map(applyChoice),
        ...(state.fixedReceipts ? { fixedReceipts: state.fixedReceipts.map((item) => {
          if (item.booking && hasCategoryChoice(item.booking)) return item;
          const category = item.merchantKey ? choices.get(storedMerchantKey(item.merchantKey))?.category : undefined;
          return category ? { ...item, category, ...(item.booking ? { booking: applyChoice(item.booking) } : {}) } : item;
        }) } : {}),
        merchantRules: [...rules.values()].flat(),
      }
    : state.merchantRules?.length ? { ...state, merchantRules: [] } : state;
}
export function applyMerchantRules(state: AppState, rows: Transaction[]) {
  if (!rows.length) return [];
  return rows.map(createMerchantRuleApplier(state, classify, true));
}

// Build once per operation, including when repairing several legacy POS rows.
// No cross-update cache: newly learned choices must take effect immediately.
export function createMerchantRuleApplier(state: AppState, classifyBooking: ClassifyBooking = classify, applyFixedCost = false) {
  const applyName = createMerchantNameApplier(state);
  // Inferring rules must not apply them to a discarded copy of the entire ledger.
  const remembered = merchantChoices(state.transactions, classifyBooking);
  const inferred = new Map<string, MerchantChoice | null>();
  for (const receipt of state.fixedReceipts ?? []) {
    if (receipt.booking && isAutomaticMerchantAssignment(receipt.booking)) continue;
    if (receipt.booking?.merchantNameConfirmed && !hasCategoryChoice(receipt.booking)) continue;
    const key = receipt.merchantKey ? storedMerchantKey(receipt.merchantKey) : undefined;
    if (key && isSpecificMerchantKey(key))
      addChoice(inferred, key, { category: canonicalCategory(receipt.category) });
  }
  const rules = new Map(
    [...remembered].filter(([, choice]) => !choice?.identityOnly).map(([key, choice]) => [storedMerchantKey(key), choice] as const)
      .filter(([key]) => isSpecificMerchantKey(key)),
  );
  const explicit = new Map<string, MerchantChoice | null>();
  const identities = new Map<string, MerchantChoice | null>();
  for (const rule of activeMerchantRules(state)) {
    const key = storedMerchantKey(rule.key);
    if (rule.identityOnly) {
      if (isSpecificMerchantKey(key)) addChoice(identities, key, rule);
      continue;
    }
    if (isSpecificMerchantKey(key)) addChoice(explicit, key, {
      category: canonicalCategory(rule.category),
      ...(rule.fixedCost !== undefined ? { fixedCost: rule.fixedCost } : {}),
      ...(rule.merchantAlias ? { merchantAlias: rule.merchantAlias } : {}),
    });
  }
  for (const [key, choice] of explicit) rules.set(key, choice);
  return (source: Transaction): Transaction => {
    source = applyName(source);
    if (source.is_locked) return source;
    if (source.merchantNameConfirmed) return source;
    let row = recoverMerchant(source);
    if (hasCategoryChoice(row)) return row;
    const identityKey = merchantAliasSourceKey(row) ?? merchantRuleKey(row);
    const identity = identities.get(identityKey);
    if (!rules.has(identityKey) && identity?.merchantAlias && row.amount < 0 && !classifyBooking(row).isTransfer)
      row = { ...row, merchantAlias: identity.merchantAlias, merchantNameConfirmed: undefined,
        merchantMatch: "rule", merchantId: undefined, merchantLogo: false, requires_manual_review: true };
    const detected = classifyBooking(row);
    if (payrollCategory(row) === detected.category) return { ...row, category: detected.category, includeInPlan: detected.includeInPlan };
    const sourceKey = merchantAliasSourceKey(row);
    const key = sourceKey && rules.get(sourceKey)?.merchantAlias ? sourceKey : merchantRuleKey(row);
    const choice =
      rules.has(key) ? rules.get(key) :
      (detected.category === "Prüfen" || detected.category === "Abonnements"
        ? inferred.get(key)
        : undefined);
    return choice && (!choice.merchantAlias || (row.amount < 0 && sourceKey !== undefined)) &&
      isSpecificMerchantKey(key) && (!row.categoryOverride || choice.merchantAlias) && !detected.isTransfer &&
      (choice.merchantAlias || row.merchantAlias || (!ambiguousMerchant(row) && !unresolvedTerminal(row.description)))
      ? { ...row, category: choice.category, categoryOverride: true, includeInPlan: true,
          ...(choice.merchantAlias ? { merchantAlias: choice.merchantAlias } : {}),
          // Reload/repair must not apply a new booking's checkbox to old twins.
          ...(applyFixedCost && row.fixedCost === undefined && (row.amount < 0 || choice.fixedCost === false) && !isIncomeCategory(choice.category) &&
            choice.fixedCost !== undefined ? { fixedCost: choice.fixedCost } : {}),
        }
      : row;
  };
}
