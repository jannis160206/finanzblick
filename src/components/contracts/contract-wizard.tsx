"use client";

import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CalendarClock, Check, ChevronDown, ListChecks, Search, Sparkles, Wand2 } from "lucide-react";
import { CategorySelect } from "@/components/category-select";
import { contractTypeIcon } from "@/components/contracts/contract-visuals";
import { FinancialData } from "@/components/financial-data";
import { MerchantMark, shouldShowMerchantMark } from "@/components/merchant-mark";
import { MerchantMarksProvider, useMerchantMarks } from "@/components/merchant-marks-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ChoiceCards, DialogEmpty, DialogStep, DialogSteps, Field, MoneyField, PremiumDialog, PremiumDialogContent, PremiumDialogHeader, ToggleRow,
  moneyText, moneyValue, type ChoiceOption,
} from "@/components/ui/premium-dialog";
import { merchantBookingMarkKey, merchantLogoBookingId, merchantLogoName, merchantNameMarkKey } from "@/lib/automation/merchant-mark-name";
import { classify, round } from "@/lib/calc";
import { categories, type Category } from "@/lib/categories";
import { contractNotice, contractTypeOf } from "@/lib/contract-types";
import {
  cancellationWindow, contractAccount, contractCandidates, contractRuleMatches, daysBetween, inferInterval, intervalAdverb, intervalLabel,
  nextAfter, perYear, stepDate, suggestContractRule, type Contract,
} from "@/lib/contracts";
import { currency, dateLabel } from "@/lib/format";
import { contractIntervals, contractOverrideSchema, type AppState, type ContractInterval, type ContractMatch, type ContractNotice, type Transaction } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ContractPatch } from "./contract-dialogs";

type Form = {
  name: string;
  amount: string;
  category: Category;
  noticeValue: string;
  noticeUnit: ContractNotice["unit"];
  termEnd: string;
  autoRenew: boolean;
  renewalMonths: string;
  note: string;
  interval: ContractInterval;
  nextDate: string;
  selected: string[];
  rule: boolean;
  ruleText: string;
  ruleMin: string;
  ruleMax: string;
  ruleAccount: string;
};

type ErrorKey = "name" | "amount" | "noticeValue" | "renewalMonths" | "nextDate" | "selection" | "ruleText" | "ruleMin" | "ruleMax";
type Errors = Partial<Record<ErrorKey, string>>;

type Candidate = {
  row: Transaction;
  classification: ReturnType<typeof classify>;
  label: string;
  merchant: string;
  account: string;
  amount: number;
  search: string;
};

export type ContractWizardProps = {
  open: boolean;
  /** null creates a manual contract. */
  contract: Contract | null;
  contracts: Contract[];
  state: AppState;
  today: string;
  disabled: boolean;
  storageError: string | null;
  onClose: () => void;
  onSave: (patch: ContractPatch) => void;
};

const unitLabel: Record<ContractNotice["unit"], string> = { days: "Tage", weeks: "Wochen", months: "Monate" };
const intervalTitle: Record<ContractInterval, string> = {
  weekly: "Wöchentlich", biweekly: "Alle 2 Wochen", monthly: "Monatlich", quarterly: "Vierteljährlich", halfyearly: "Halbjährlich", yearly: "Jährlich",
};
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);
const selectableCategory = (category: Category): Category => categories.includes(category as (typeof categories)[number]) ? category : "Sonstiges";
const fold = (text: string) => text.toLocaleLowerCase("de-AT").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
const PAGE = 40;
const MAX_SELECTED = 500;

function initialForm(contract: Contract | null, match: ContractMatch | undefined, today: string): Form {
  return {
    name: contract?.name ?? "",
    amount: contract ? moneyText(contract.amount) : "",
    category: selectableCategory(contract?.category ?? "Abonnements"),
    noticeValue: contract?.notice ? String(contract.notice.value) : "",
    noticeUnit: contract?.notice?.unit ?? "months",
    termEnd: contract?.termEnd ?? "",
    autoRenew: contract?.autoRenew ?? true,
    renewalMonths: contract?.termEnd ? String(contract.renewalMonths) : "12",
    note: contract?.note ?? "",
    interval: contract?.interval ?? "monthly",
    nextDate: contract?.nextDate ?? today,
    selected: contract?.charges.map((charge) => charge.id) ?? [],
    rule: !!match,
    ruleText: match?.text ?? "",
    ruleMin: moneyText(match?.amountMin),
    ruleMax: moneyText(match?.amountMax),
    ruleAccount: match?.account ?? "",
  };
}

function ruleOf(text: string, min: string, max: string, account: string): ContractMatch | null {
  const amountMin = moneyValue(min);
  const amountMax = moneyValue(max);
  const match: ContractMatch = {
    ...(text.trim() ? { text: text.trim().slice(0, 80) } : {}),
    ...(amountMin !== null && amountMin >= 0 ? { amountMin } : {}),
    ...(amountMax !== null && amountMax >= 0 ? { amountMax } : {}),
    ...(account ? { account } : {}),
  };
  return Object.keys(match).length ? match : null;
}

function validate(form: Form): Errors {
  const errors: Errors = {};
  const name = form.name.trim();
  if (!name || name.length > 100) errors.name = "Bitte einen Namen mit 1 bis 100 Zeichen eingeben.";
  const amount = moneyValue(form.amount);
  if (amount === null || amount <= 0 || amount > 1_000_000) errors.amount = "Bitte einen Betrag größer als 0 eingeben, z. B. 12,99.";
  const notice = form.noticeValue.trim() ? Number(form.noticeValue) : null;
  if (notice !== null && (!Number.isInteger(notice) || notice < 1 || notice > 730)) errors.noticeValue = "Die Frist muss eine ganze Zahl zwischen 1 und 730 sein.";
  const renewal = Number(form.renewalMonths);
  if (form.termEnd && form.autoRenew && (!Number.isInteger(renewal) || renewal < 1 || renewal > 60)) errors.renewalMonths = "Die Verlängerung muss zwischen 1 und 60 Monaten liegen.";
  if (!isDate(form.nextDate)) errors.nextDate = "Bitte das Datum der nächsten Abbuchung angeben.";
  if (form.selected.length > MAX_SELECTED) errors.selection = `Höchstens ${MAX_SELECTED} Buchungen auswählen.`;
  if (form.rule) {
    const min = moneyValue(form.ruleMin);
    const max = moneyValue(form.ruleMax);
    if (form.ruleMin.trim() && (min === null || min < 0)) errors.ruleMin = "Bitte einen gültigen Betrag eingeben.";
    if (form.ruleMax.trim() && (max === null || max < 0)) errors.ruleMax = "Bitte einen gültigen Betrag eingeben.";
    else if (min !== null && max !== null && min > max) errors.ruleMax = "Der Höchstbetrag muss mindestens so hoch sein wie der Mindestbetrag.";
    if (!ruleOf(form.ruleText, form.ruleMin, form.ruleMax, form.ruleAccount) && !errors.ruleMin && !errors.ruleMax) {
      errors.ruleText = "Mindestens ein Kriterium angeben – oder die automatische Zuordnung ausschalten.";
    }
  }
  return errors;
}

const stepFields: Record<string, ErrorKey[]> = {
  basics: ["name", "amount", "noticeValue", "renewalMonths"],
  rhythm: ["nextDate"],
  bookings: ["selection"],
  rules: ["ruleText", "ruleMin", "ruleMax"],
};

/** Create or edit a contract in five steps, with a live preview beside the form on wide screens. */
export default function ContractWizard(props: ContractWizardProps) {
  return (
    <PremiumDialog open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
      <WizardSurface {...props} />
    </PremiumDialog>
  );
}

function WizardSurface({ contract, contracts, state, today, disabled, storageError, onSave }: ContractWizardProps) {
  const override = state.contracts?.find((entry) => entry.id === contract?.id);
  const [initial] = useState(() => initialForm(contract, override?.match, today));
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Errors>({});
  // New contracts take their rule from the picked bookings until the user edits it.
  const [ruleTouched, setRuleTouched] = useState(contract !== null);

  const candidates = useMemo<Candidate[]>(() => {
    const rows = contractCandidates(state, today);
    const listed = new Set(rows.map((row) => row.id));
    const own = new Set(contract?.charges.map((charge) => charge.id) ?? []);
    const older = state.transactions.filter((row) => own.has(row.id) && !listed.has(row.id));
    return [...rows, ...older].map((row) => {
      const classification = classify(row);
      const label = row.merchantAlias?.trim() || row.description;
      const account = contractAccount(row);
      return { row, classification, label, merchant: classification.merchant ?? "", account, amount: Math.abs(row.amount), search: fold(`${label} ${row.description} ${account}`) };
    });
  }, [state, today, contract]);
  const byId = useMemo(() => new Map(candidates.map((candidate) => [candidate.row.id, candidate])), [candidates]);
  const owners = useMemo(() => {
    const map = new Map<string, string>();
    for (const other of contracts) {
      if (other.id === contract?.id || other.status === "ignored") continue;
      for (const charge of other.charges) map.set(charge.id, other.name);
    }
    return map;
  }, [contracts, contract]);
  const accounts = useMemo(() => [...new Set(candidates.map((candidate) => candidate.account))].sort((a, b) => a.localeCompare(b, "de")), [candidates]);

  const selectedSet = useMemo(() => new Set(form.selected), [form.selected]);
  const selectedRows = useMemo(() => form.selected.flatMap((id) => byId.get(id) ?? [])
    .sort((a, b) => a.row.date.localeCompare(b.row.date)), [form.selected, byId]);
  const rule = useMemo(() => form.rule ? ruleOf(form.ruleText, form.ruleMin, form.ruleMax, form.ruleAccount) : null,
    [form.rule, form.ruleText, form.ruleMin, form.ruleMax, form.ruleAccount]);
  const deferredRule = useDeferredValue(rule);
  const matches = useMemo(() => deferredRule ? candidates.filter((candidate) => contractRuleMatches(candidate.row, deferredRule)) : [], [deferredRule, candidates]);

  const amount = moneyValue(form.amount);
  const noticeValue = form.noticeValue.trim() ? Number(form.noticeValue) : null;
  const notice = noticeValue !== null && Number.isInteger(noticeValue) && noticeValue >= 1 && noticeValue <= 730 ? { value: noticeValue, unit: form.noticeUnit } : undefined;
  const renewal = Number(form.renewalMonths);
  const next = isDate(form.nextDate) ? nextAfter(form.nextDate, form.interval, today) : undefined;
  const window = cancellationWindow({
    notice, termEnd: form.termEnd || undefined, nextDate: next, interval: form.interval, autoRenew: form.autoRenew,
    renewalMonths: form.termEnd && Number.isInteger(renewal) && renewal >= 1 && renewal <= 60 ? renewal : undefined,
  }, today);
  const type = contractTypeOf(form.name.trim() || "Vertrag", form.category);
  const typical = contractNotice[type];
  const latest = selectedRows.at(-1);
  const inferred = inferInterval(selectedRows.map((candidate) => candidate.row.date));
  const preview: PreviewData = {
    name: form.name.trim(), category: form.category, type, amount: amount !== null && amount > 0 ? amount : null, interval: form.interval,
    next, deadline: window?.deadline, effectiveEnd: window?.effectiveEnd, hasNotice: !!notice, today,
    bookings: selectedRows.length, latest, account: latest?.account,
    upcoming: next ? [0, 1, 2].map((step) => stepDate(next, form.interval, step)) : [],
    rule,
  };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  function patchForm(patch: Partial<Form>, cleared: ErrorKey[] = []) {
    setForm((current) => ({ ...current, ...patch }));
    if (cleared.length) setErrors((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !cleared.includes(key as ErrorKey))));
  }

  function suggestRule(selected: string[]): Partial<Form> {
    const suggestion = suggestContractRule(selected.flatMap((id) => byId.get(id)?.row ?? []));
    return {
      rule: !!suggestion, ruleText: suggestion?.text ?? "", ruleMin: moneyText(suggestion?.amountMin),
      ruleMax: moneyText(suggestion?.amountMax), ruleAccount: suggestion?.account ?? "",
    };
  }

  function select(ids: string[], on: boolean) {
    const nextSet = new Set(form.selected);
    for (const id of ids) {
      if (on) nextSet.add(id);
      else nextSet.delete(id);
    }
    const selected = [...nextSet];
    patchForm({ selected, ...(ruleTouched ? {} : suggestRule(selected)) }, ["selection", "ruleText", "ruleMin", "ruleMax"]);
  }

  function editRule(patch: Partial<Form>) {
    setRuleTouched(true);
    patchForm(patch, ["ruleText", "ruleMin", "ruleMax"]);
  }

  function check(step: string) {
    const keys = stepFields[step] ?? [];
    const found = validate(form);
    const relevant = Object.fromEntries(keys.flatMap((key) => found[key] ? [[key, found[key]]] : []));
    setErrors((current) => ({ ...Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key as ErrorKey))), ...relevant }));
    return !Object.keys(relevant).length;
  }

  function complete() {
    if (disabled || amount === null) return;
    const name = form.name.trim();
    const initialIds = new Set(initial.selected);
    const selectionChanged = form.selected.length !== initial.selected.length || form.selected.some((id) => !initialIds.has(id));
    const ruleChanged = (["rule", "ruleText", "ruleMin", "ruleMax", "ruleAccount"] as const).some((key) => form[key] !== initial[key]);
    const ruleIds = rule ? candidates.filter((candidate) => contractRuleMatches(candidate.row, rule)).map((candidate) => candidate.row.id) : [];
    const excluded = [...new Set([...initial.selected, ...ruleIds])].filter((id) => !selectedSet.has(id));
    const patch: ContractPatch = {
      ...(!contract || name !== contract.name ? { name } : {}),
      ...(!contract || amount !== contract.amount ? { amount } : {}),
      ...(!contract || form.interval !== contract.interval ? { interval: form.interval } : {}),
      ...(!contract || form.nextDate !== contract.nextDate ? { nextDate: form.nextDate } : {}),
      ...(!contract || form.category !== selectableCategory(contract.category) ? { category: form.category } : {}),
      notice,
      termEnd: form.termEnd || undefined,
      autoRenew: form.termEnd ? form.autoRenew : undefined,
      renewalMonths: form.termEnd && form.autoRenew ? renewal : undefined,
      note: form.note.trim() || undefined,
      ...(!contract || selectionChanged || ruleChanged ? {
        bookingIds: form.selected.length ? form.selected.slice(0, MAX_SELECTED) : undefined,
        excludedBookingIds: excluded.length ? excluded.slice(0, MAX_SELECTED) : undefined,
      } : {}),
      ...(!contract || ruleChanged ? { match: rule ?? undefined } : {}),
      ...(contract ? contract.status === "review" ? { status: "confirmed" as const } : {} : { manual: true, status: "confirmed" as const }),
    };
    const parsed = contractOverrideSchema.safeParse({
      id: contract?.id ?? "check",
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      updatedAt: 0,
    });
    if (!parsed.success) {
      setErrors({ name: "Bitte die Eingaben prüfen." });
      return;
    }
    onSave(patch);
  }

  const amountHint = amount === null || amount <= 0 ? undefined
    : form.interval === "monthly" ? `${currency(round(amount * 12))} im Jahr`
      : `≈ ${currency(round(amount * perYear[form.interval] / 12))} im Monat · ${currency(round(amount * perYear[form.interval]))} im Jahr`;
  const intervalOptions: ChoiceOption<ContractInterval>[] = contractIntervals.map((interval) => ({
    value: interval,
    label: intervalTitle[interval],
    description: `${perYear[interval]}× im Jahr`,
    meta: amount !== null && amount > 0 ? `${currency(round(amount * perYear[interval]))} / Jahr` : undefined,
  }));
  const suggestedAmount = latest ? round(latest.amount) : null;
  const suggestedInterval = inferred && inferred !== form.interval ? inferred : null;
  const rhythm = inferred ?? form.interval;
  const suggestedNext = latest ? nextAfter(stepDate(latest.row.date, rhythm, 1), rhythm, today) : null;

  return (
    <PremiumDialogContent size="xl" dirty={dirty} preview={<ContractPreview data={preview} />}>
      <PremiumDialogHeader
        title={contract ? `${contract.name} bearbeiten` : "Vertrag hinzufügen"}
        description={contract
          ? "Korrekturen bleiben erhalten, auch wenn neue Buchungen dazukommen."
          : "Für Abos, Versicherungen und alles, was regelmäßig abgebucht wird."} />
      <DialogSteps mode="always" editing={contract !== null} disabled={disabled} onComplete={complete}
        submitLabel={contract ? "Speichern" : "Vertrag anlegen"}
        message={storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}>
        <DialogStep id="basics" title="Grunddaten" validate={() => check("basics")}>
          <BasicsStep form={form} errors={errors} typical={`${typical.label}: ${typical.text}`} amountHint={amountHint} onChange={patchForm} />
        </DialogStep>
        <DialogStep id="rhythm" title="Rhythmus" validate={() => check("rhythm")}>
          <Field label="Wie oft wird abgebucht?" group>
            <ChoiceCards columns={3} value={form.interval} options={intervalOptions} onValueChange={(interval) => patchForm({ interval })} />
          </Field>
          <Field label="Nächste Abbuchung" error={errors.nextDate}
            hint={next && next !== form.nextDate ? `Liegt in der Vergangenheit – die nächste fällige Abbuchung ist am ${dateLabel(next)}.` : next ? `Danach ${preview.upcoming.slice(1).map(dateLabel).join(" und ")}.` : undefined}>
            <Input type="date" value={form.nextDate} className="sm:max-w-56" onChange={(event) => patchForm({ nextDate: event.target.value }, ["nextDate"])} />
          </Field>
          {suggestedNext && suggestedNext !== form.nextDate && (
            <SuggestionRow icon={Sparkles} text={`Laut deinen Buchungen: ${dateLabel(suggestedNext)}`}
              action="Übernehmen" onApply={() => patchForm({ nextDate: suggestedNext, ...(suggestedInterval ? { interval: suggestedInterval } : {}) }, ["nextDate"])} />
          )}
        </DialogStep>
        <DialogStep id="bookings" title="Buchungen" validate={() => check("bookings")}>
          <BookingPicker candidates={candidates} selectedRows={selectedRows} selectedSet={selectedSet} owners={owners} name={form.name}
            error={errors.selection} today={today} interval={inferred} onSelect={select}
            suggestions={{
              interval: suggestedInterval, amount: suggestedAmount !== null && suggestedAmount !== amount ? suggestedAmount : null,
              next: suggestedNext && suggestedNext !== form.nextDate ? suggestedNext : null,
            }}
            onApply={(patch) => patchForm(patch, ["amount", "nextDate"])} />
        </DialogStep>
        <DialogStep id="rules" title="Erkennung" validate={() => check("rules")}>
          <RulesStep form={form} errors={errors} accounts={accounts} detected={!!contract && contract.source !== "manual"}
            matches={matches} selectedSet={selectedSet} selectedRows={selectedRows} rule={deferredRule}
            onToggle={(on) => editRule(on && !ruleOf(form.ruleText, form.ruleMin, form.ruleMax, form.ruleAccount) ? { ...suggestRule(form.selected), rule: true } : { rule: on })}
            onChange={editRule} onAdopt={(ids) => select(ids, true)} />
        </DialogStep>
        <DialogStep id="preview" title="Vorschau">
          <div className="lg:hidden"><ContractPreview data={preview} /></div>
          <PreviewChecks data={preview} />
        </DialogStep>
      </DialogSteps>
    </PremiumDialogContent>
  );
}

function BasicsStep({ form, errors, typical, amountHint, onChange }: {
  form: Form; errors: Errors; typical: string; amountHint?: string; onChange: (patch: Partial<Form>, cleared?: ErrorKey[]) => void;
}) {
  const [more, setMore] = useState(() => !!form.termEnd || !!form.note);
  return (
    <>
      <Field label="Name" error={errors.name}>
        <Input autoFocus value={form.name} maxLength={100} placeholder="z. B. Netflix oder Kfz-Versicherung" autoComplete="off"
          onChange={(event) => onChange({ name: event.target.value }, ["name"])} />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Betrag je Abbuchung" error={errors.amount} hint={amountHint}>
          <MoneyField value={form.amount} onValueChange={(amount) => onChange({ amount }, ["amount"])} />
        </Field>
        <Field label="Kategorie">
          <CategorySelect label="Kategorie" excludeReview value={form.category} onValueChange={(category) => onChange({ category })} />
        </Field>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-3 gap-y-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,12rem)]">
        <Field label="Kündigungsfrist" error={errors.noticeValue}>
          <Input inputMode="numeric" className="tabular-nums" placeholder="optional" value={form.noticeValue}
            onChange={(event) => onChange({ noticeValue: event.target.value.replace(/\D/g, "").slice(0, 3) }, ["noticeValue"])} />
        </Field>
        <select aria-label="Einheit der Kündigungsfrist" className="select-input mt-7 w-full" value={form.noticeUnit}
          onChange={(event) => onChange({ noticeUnit: event.target.value === "days" ? "days" : event.target.value === "weeks" ? "weeks" : "months" })}>
          {(Object.keys(unitLabel) as ContractNotice["unit"][]).map((unit) => <option key={unit} value={unit}>{unitLabel[unit]}</option>)}
        </select>
        <p className="col-span-2 text-xs leading-relaxed text-muted-foreground">{typical}</p>
      </div>
      <div className="rounded-2xl border border-border/70">
        <button type="button" aria-expanded={more} onClick={() => setMore((value) => !value)}
          className="flex min-h-12 w-full items-center justify-between gap-3 rounded-2xl px-4 text-left text-sm font-medium transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
          <span>Laufzeit & Notiz <span className="font-normal text-muted-foreground">optional</span></span>
          <ChevronDown aria-hidden="true" className={cn("size-4 text-muted-foreground transition-transform duration-200", more && "rotate-180")} />
        </button>
        {more && (
          <div className="space-y-5 border-t border-border/60 p-4">
            <Field label="Mindestlaufzeit bis" optional>
              <Input type="date" value={form.termEnd} className="sm:max-w-56" onChange={(event) => onChange({ termEnd: event.target.value }, ["renewalMonths"])} />
            </Field>
            {form.termEnd && (
              <>
                <ToggleRow checked={form.autoRenew} onCheckedChange={(autoRenew) => onChange({ autoRenew }, ["renewalMonths"])}
                  label="Verlängert sich automatisch" description="Nach Ablauf läuft der Vertrag weiter, bis du kündigst." />
                {form.autoRenew && (
                  <Field label="Verlängerung um (Monate)" error={errors.renewalMonths}>
                    <Input inputMode="numeric" className="w-24 tabular-nums" value={form.renewalMonths}
                      onChange={(event) => onChange({ renewalMonths: event.target.value.replace(/\D/g, "").slice(0, 2) }, ["renewalMonths"])} />
                  </Field>
                )}
              </>
            )}
            <Field label="Notiz" optional>
              <textarea rows={2} maxLength={500} value={form.note} onChange={(event) => onChange({ note: event.target.value })}
                className="block w-full resize-y rounded-xl border border-input bg-background/50 px-3 py-2 text-sm shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30"
                placeholder="z. B. Kundennummer oder Kündigungsweg" />
            </Field>
          </div>
        )}
      </div>
    </>
  );
}

function SuggestionRow({ icon: Icon, text, action, onApply }: { icon: typeof Sparkles; text: string; action: string; onApply: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-accent-muted/60 px-3 py-2 text-sm">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">{text}</span>
      <Button type="button" size="sm" variant="ghost" onClick={onApply}>{action}</Button>
    </div>
  );
}

function BookingPicker({ candidates, selectedRows, selectedSet, owners, name, error, today, interval, suggestions, onSelect, onApply }: {
  candidates: Candidate[];
  selectedRows: Candidate[];
  selectedSet: Set<string>;
  owners: Map<string, string>;
  name: string;
  error?: string;
  today: string;
  interval?: ContractInterval;
  suggestions: { interval: ContractInterval | null; amount: number | null; next: string | null };
  onSelect: (ids: string[], on: boolean) => void;
  onApply: (patch: Partial<Form>) => void;
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const deferredQuery = useDeferredValue(query);
  // Grouping is fixed while the step is open, so ticking a booking never moves rows under the pointer.
  const [merchants] = useState(() => new Set(selectedRows.map((candidate) => candidate.merchant).filter(Boolean)));
  const [nameNeedle] = useState(() => fold(name));
  const needle = fold(deferredQuery);
  const { suggested, rest } = useMemo(() => {
    if (needle) {
      const digits = needle.replace(/[^\d,.]/g, "").replace(".", ",");
      const found = candidates.filter((candidate) => candidate.search.includes(needle) ||
        (digits.length > 0 && currency(candidate.amount).includes(digits)));
      return { suggested: [] as Candidate[], rest: found };
    }
    const score = (candidate: Candidate) => merchants.has(candidate.merchant) ? 2
      : nameNeedle.length >= 3 && candidate.search.includes(nameNeedle) ? 1 : 0;
    const scored = candidates.map((candidate) => ({ candidate, score: score(candidate) }));
    return {
      suggested: scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || b.candidate.row.date.localeCompare(a.candidate.row.date)).map((entry) => entry.candidate),
      rest: scored.filter((entry) => entry.score === 0).map((entry) => entry.candidate),
    };
  }, [candidates, merchants, needle, nameNeedle]);
  const shownSuggested = suggested.slice(0, limit);
  const shownRest = rest.slice(0, Math.max(0, limit - shownSuggested.length));
  const remaining = suggested.length + rest.length - shownSuggested.length - shownRest.length;
  const marks = useMemo(() => {
    const visible = [...suggested.slice(0, limit), ...rest.slice(0, Math.max(0, limit - Math.min(limit, suggested.length)))];
    return {
    merchantIds: [...new Set(visible.flatMap((candidate) => candidate.row.merchantId ? [candidate.row.merchantId] : []))].slice(0, 100),
    merchantNames: [...new Set(visible.flatMap((candidate) => merchantLogoName(candidate.row) ?? []))].slice(0, 100),
    bookingIds: [...new Set(visible.flatMap((candidate) => merchantLogoBookingId(candidate.row) ?? []))].slice(0, 100),
    };
  }, [suggested, rest, limit]);

  if (!candidates.length) {
    return (
      <DialogEmpty icon={ListChecks} title="Noch keine Abbuchungen">
        Du kannst den Vertrag trotzdem anlegen. Spätere Abbuchungen ordnet die Erkennung im nächsten Schritt zu.
      </DialogEmpty>
    );
  }
  return (
    <MerchantMarksProvider {...marks}>
      <SelectionSummary rows={selectedRows} today={today} interval={interval} suggestions={suggestions} onApply={onApply} onClear={() => onSelect(selectedRows.map((candidate) => candidate.row.id), false)} />
      {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input type="search" aria-label="Buchungen durchsuchen" placeholder="Händler, Text oder Betrag" className="pl-9" value={query}
          onChange={(event) => { setQuery(event.target.value); setLimit(PAGE); }} />
      </div>
      {!shownSuggested.length && !shownRest.length ? (
        <DialogEmpty icon={Search} title="Keine passenden Buchungen">Probier einen anderen Suchbegriff oder einen Betrag wie „12,99“.</DialogEmpty>
      ) : (
        <div className="space-y-4">
          {shownSuggested.length > 0 && <BookingGroup title="Passt zum Vertrag" items={shownSuggested} selectedSet={selectedSet} owners={owners} onSelect={onSelect} />}
          {shownRest.length > 0 && <BookingGroup title={needle ? `${rest.length} Treffer` : shownSuggested.length ? "Weitere Abbuchungen" : "Letzte Abbuchungen"}
            items={shownRest} selectedSet={selectedSet} owners={owners} onSelect={onSelect} />}
          {remaining > 0 && (
            <Button type="button" variant="ghost" className="w-full" onClick={() => setLimit((value) => value + PAGE)}>
              Weitere anzeigen <span className="text-muted-foreground tabular-nums">({remaining})</span>
            </Button>
          )}
        </div>
      )}
    </MerchantMarksProvider>
  );
}

function BookingGroup({ title, items, selectedSet, owners, onSelect }: {
  title: string; items: Candidate[]; selectedSet: Set<string>; owners: Map<string, string>; onSelect: (ids: string[], on: boolean) => void;
}) {
  return (
    <section aria-label={title}>
      <h4 className="mb-1.5 px-1 text-xs font-medium text-muted-foreground">{title}</h4>
      <ul className="divide-y divide-border/50 overflow-hidden rounded-2xl border border-border/70">
        {items.map((candidate) => {
          const checked = selectedSet.has(candidate.row.id);
          const owner = owners.get(candidate.row.id);
          return (
            <li key={candidate.row.id}>
              <label className={cn("grid min-h-14 cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/50",
                checked && "bg-accent-muted/50 hover:bg-accent-muted/70")}>
                <input type="checkbox" className="peer sr-only" checked={checked}
                  aria-label={`${candidate.label}, ${dateLabel(candidate.row.date)}, ${currency(candidate.amount)}`}
                  onChange={(event) => onSelect([candidate.row.id], event.target.checked)} />
                <span aria-hidden="true" className={cn("flex size-5 items-center justify-center rounded-md border border-input bg-background transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-background",
                  checked && "border-primary bg-primary text-primary-foreground")}>
                  {checked && <Check className="size-3.5" strokeWidth={3} />}
                </span>
                <BookingMark candidate={candidate} />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{candidate.label}</span>
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="shrink-0 tabular-nums">{dateLabel(candidate.row.date)}</span>
                    <span aria-hidden="true">·</span>
                    <FinancialData as="span" className="truncate">{candidate.account}</FinancialData>
                  </span>
                  {owner && <Badge variant="warning" className="mt-1 max-w-full"><span className="truncate">Gehört zu {owner}</span></Badge>}
                </span>
                <FinancialData as="span" className="text-right text-sm font-semibold tabular-nums">{currency(-candidate.amount)}</FinancialData>
              </label>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function BookingMark({ candidate, className }: { candidate: Candidate; className?: string }) {
  const marks = useMerchantMarks();
  const { row } = candidate;
  const name = merchantLogoName(row);
  const bookingId = merchantLogoBookingId(row);
  // Without a logo or alias the shared mark would only show "?"; the first letter reads better in a list.
  const known = !!row.merchantAlias?.trim() || !!(marks && (
    (row.merchantId && marks.get(row.merchantId)) || (name && marks.get(merchantNameMarkKey(name))) || (bookingId && marks.get(merchantBookingMarkKey(bookingId)))));
  if (known && shouldShowMerchantMark(row, candidate.classification, true)) {
    return <MerchantMark booking={candidate.row} classification={candidate.classification} className={cn("size-9 rounded-xl", className)} />;
  }
  return (
    <span aria-hidden="true" className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-xs font-semibold text-muted-foreground", className)}>
      {candidate.label.trim().charAt(0).toLocaleUpperCase("de-AT") || "?"}
    </span>
  );
}

function SelectionSummary({ rows, today, interval, suggestions, onApply, onClear }: {
  rows: Candidate[];
  today: string;
  interval?: ContractInterval;
  suggestions: { interval: ContractInterval | null; amount: number | null; next: string | null };
  onApply: (patch: Partial<Form>) => void;
  onClear: () => void;
}) {
  const first = rows[0]?.row.date;
  const last = rows.at(-1)?.row.date;
  const average = rows.length ? round(rows.reduce((sum, candidate) => sum + candidate.amount, 0) / rows.length) : null;
  const end = last ? suggestions.next ?? (interval ? stepDate(last, interval, 1) : last) : undefined;
  const span = first && last && end ? Math.max(1, daysBetween(first, end > last ? end : last)) : 1;
  const position = (date: string) => first ? `${Math.min(100, Math.max(0, daysBetween(first, date) / span * 100))}%` : "0%";
  const { interval: newInterval, amount: newAmount, next: newNext } = suggestions;
  const all: Partial<Form> = {
    ...(newInterval ? { interval: newInterval } : {}),
    ...(newAmount !== null ? { amount: moneyText(newAmount) } : {}),
    ...(newNext ? { nextDate: newNext } : {}),
  };
  const offers = Object.keys(all).length;
  return (
    <section aria-label="Ausgewählte Buchungen" className={cn("space-y-3 rounded-2xl border p-4 transition-colors duration-300",
      rows.length ? "border-primary/25 bg-accent-muted/40" : "border-dashed border-border bg-transparent")}>
      <div className="flex min-h-5 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-semibold">{!rows.length ? "Noch keine Buchung ausgewählt" : rows.length === 1 ? "1 Buchung ausgewählt" : `${rows.length} Buchungen ausgewählt`}</p>
        {rows.length > 0 && <button type="button" onClick={onClear} className="text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Auswahl leeren</button>}
      </div>
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div><dt className="text-xs text-muted-foreground">Durchschnitt</dt><dd><FinancialData as="span" className="font-semibold tabular-nums">{average !== null ? currency(average) : "–"}</FinancialData></dd></div>
        <div><dt className="text-xs text-muted-foreground">Rhythmus</dt><dd className="font-semibold">{interval ? intervalTitle[interval] : "–"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Zeitraum</dt><dd className="font-semibold tabular-nums">{first && last && rows.length > 1 ? `${Math.max(1, Math.round(daysBetween(first, last) / 30.4))} Mon.` : "–"}</dd></div>
      </dl>
      <div aria-hidden="true">
        <div className="relative h-6">
          <span className={cn("absolute inset-x-0 top-1/2 h-px -translate-y-1/2", rows.length ? "bg-primary/25" : "bg-border")} />
          {rows.map((candidate) => (
            <span key={candidate.row.id} className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-card"
              style={{ left: position(candidate.row.date) }} />
          ))}
          {last && end && end > last && (
            <span className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-primary bg-card"
              style={{ left: position(end) }} />
          )}
        </div>
        <div className="flex min-h-4 justify-between text-2xs text-muted-foreground tabular-nums">
          <span>{first ? dateLabel(first) : "Die Auswahl zeigt Rhythmus und Betrag."}</span>
          {last && end && end > last && <span>{end > today ? "nächste" : "fällig"} {dateLabel(end)}</span>}
        </div>
      </div>
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        <Wand2 aria-hidden="true" className={cn("size-4", offers ? "text-primary" : "text-muted-foreground")} />
        {!offers && <span className="text-xs text-muted-foreground">{rows.length ? "Passt zu deinen Angaben." : "Vorschläge erscheinen mit der Auswahl."}</span>}
        {newInterval && <Button type="button" size="sm" variant="outline" onClick={() => onApply({ interval: newInterval })}>{intervalTitle[newInterval]}</Button>}
        {newAmount !== null && <Button type="button" size="sm" variant="outline" onClick={() => onApply({ amount: moneyText(newAmount) })}>
          <FinancialData as="span">{currency(newAmount)}</FinancialData></Button>}
        {newNext && <Button type="button" size="sm" variant="outline" onClick={() => onApply({ nextDate: newNext })}>Nächste {dateLabel(newNext)}</Button>}
        {offers > 1 && <Button type="button" size="sm" onClick={() => onApply(all)}>Alles übernehmen</Button>}
      </div>
    </section>
  );
}

function RulesStep({ form, errors, accounts, detected, matches, selectedSet, selectedRows, rule, onToggle, onChange, onAdopt }: {
  form: Form;
  errors: Errors;
  accounts: string[];
  detected: boolean;
  matches: Candidate[];
  selectedSet: Set<string>;
  selectedRows: Candidate[];
  rule: ContractMatch | null;
  onToggle: (on: boolean) => void;
  onChange: (patch: Partial<Form>) => void;
  onAdopt: (ids: string[]) => void;
}) {
  const fresh = matches.filter((candidate) => !selectedSet.has(candidate.row.id));
  const outside = rule ? selectedRows.filter((candidate) => !matches.includes(candidate)).length : 0;
  return (
    <>
      <ToggleRow checked={form.rule} onCheckedChange={onToggle}
        label="Neue Abbuchungen automatisch zuordnen"
        description="Finanzblick ordnet künftige Buchungen zu, die alle Kriterien erfüllen." />
      {!form.rule ? (
        <p className="rounded-xl bg-muted/50 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
          {detected
            ? "Ohne eigene Regel erkennt Finanzblick diesen Vertrag weiter automatisch an Händler, Betrag und Rhythmus."
            : "Ohne Regel bleiben nur die ausgewählten Buchungen zugeordnet."}
        </p>
      ) : (
        <>
          <Field label="Buchungstext enthält" error={errors.ruleText} hint="Groß- und Kleinschreibung sowie Umlaute spielen keine Rolle.">
            <Input value={form.ruleText} maxLength={80} placeholder="z. B. Netflix" autoComplete="off" onChange={(event) => onChange({ ruleText: event.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Betrag ab" error={errors.ruleMin}>
              <MoneyField value={form.ruleMin} onValueChange={(ruleMin) => onChange({ ruleMin })} />
            </Field>
            <Field label="Betrag bis" error={errors.ruleMax}>
              <MoneyField value={form.ruleMax} onValueChange={(ruleMax) => onChange({ ruleMax })} />
            </Field>
          </div>
          <Field label="Konto">
            <select className="select-input w-full" value={form.ruleAccount} onChange={(event) => onChange({ ruleAccount: event.target.value })}>
              <option value="">Alle Konten</option>
              {form.ruleAccount && !accounts.includes(form.ruleAccount) && <option value={form.ruleAccount}>{form.ruleAccount}</option>}
              {accounts.map((account) => <option key={account} value={account}>{account}</option>)}
            </select>
          </Field>
          <div aria-live="polite" className="space-y-3 rounded-2xl border border-border/70 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                <span className="font-semibold tabular-nums">{matches.length}</span> {matches.length === 1 ? "Buchung passt" : "Buchungen passen"}
                {fresh.length > 0 && <span className="text-muted-foreground"> · {fresh.length} noch nicht ausgewählt</span>}
              </p>
              {fresh.length > 0 && <Button type="button" size="sm" variant="soft" onClick={() => onAdopt(fresh.map((candidate) => candidate.row.id))}>Alle übernehmen</Button>}
            </div>
            {matches.length > 0 && (
              <ul className="space-y-1.5">
                {matches.slice(0, 3).map((candidate) => (
                  <li key={candidate.row.id} className="flex items-center gap-2 text-xs">
                    <span className="w-20 shrink-0 tabular-nums text-muted-foreground">{dateLabel(candidate.row.date)}</span>
                    <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                    <FinancialData as="span" className="shrink-0 font-medium tabular-nums">{currency(-candidate.amount)}</FinancialData>
                  </li>
                ))}
              </ul>
            )}
            {outside > 0 && (
              <p className="flex gap-2 text-xs text-muted-foreground">
                <AlertTriangle aria-hidden="true" className="mt-px size-3.5 shrink-0 text-warning" />
                {outside === 1 ? "1 ausgewählte Buchung passt nicht zur Regel" : `${outside} ausgewählte Buchungen passen nicht zur Regel`} – sie bleiben trotzdem zugeordnet.
              </p>
            )}
          </div>
        </>
      )}
    </>
  );
}

type PreviewData = {
  name: string;
  category: Category;
  type: ReturnType<typeof contractTypeOf>;
  amount: number | null;
  interval: ContractInterval;
  next?: string;
  deadline?: string;
  effectiveEnd?: string;
  hasNotice: boolean;
  today: string;
  bookings: number;
  latest?: Candidate;
  account?: string;
  upcoming: string[];
  rule: ContractMatch | null;
};

function ContractPreview({ data }: { data: PreviewData }) {
  const Icon = contractTypeIcon[data.type];
  const days = data.next ? daysBetween(data.today, data.next) : null;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">So sieht der Vertrag aus</h3>
      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 p-4">
          {data.latest
            ? <BookingMark candidate={data.latest} className="size-10" />
            : <span aria-hidden="true" className="inline-flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground"><Icon className="size-4.5" /></span>}
          <span className="min-w-0">
            <span className={cn("block truncate text-sm font-medium", !data.name && "text-muted-foreground")}>{data.name || "Neuer Vertrag"}</span>
            <FinancialData as="span" className="block truncate text-xs text-muted-foreground">{data.category}{data.account ? ` · ${data.account}` : ""}</FinancialData>
          </span>
          <FinancialData as="span" className="text-right">
            <span className="block text-sm font-semibold tabular-nums">{data.amount !== null ? currency(data.amount) : "– €"}</span>
            <span className="block text-2xs text-muted-foreground">{intervalAdverb[data.interval]}</span>
          </FinancialData>
        </div>
        <dl className="grid grid-cols-2 gap-px border-t border-border/60 bg-border/60 text-sm">
          <PreviewFact label="Nächste Abbuchung" value={data.next ? dateLabel(data.next) : "–"}
            note={days !== null ? days === 0 ? "heute" : `in ${days} ${days === 1 ? "Tag" : "Tagen"}` : undefined} />
          <PreviewFact label="Kündbar bis" value={data.deadline ? dateLabel(data.deadline) : data.hasNotice ? "–" : "Frist offen"}
            note={data.effectiveEnd ? `endet ${dateLabel(data.effectiveEnd)}` : undefined} tone={data.hasNotice ? undefined : "muted"} />
          <PreviewFact label="Im Jahr" value={data.amount !== null ? currency(round(data.amount * perYear[data.interval])) : "–"} financial />
          <PreviewFact label="Buchungen" value={data.bookings ? String(data.bookings) : "keine"} note={data.rule ? "plus neue per Regel" : undefined} />
        </dl>
      </div>
      {data.upcoming.length > 0 && (
        <ol aria-label="Nächste Abbuchungen" className="flex flex-wrap gap-1.5">
          {data.upcoming.map((date, index) => (
            <li key={date} className={cn("rounded-full px-2.5 py-1 text-2xs font-medium tabular-nums",
              index === 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{dateLabel(date)}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

function PreviewFact({ label, value, note, tone, financial = false }: { label: string; value: string; note?: string; tone?: "muted"; financial?: boolean }) {
  const content = <span className={cn("block font-semibold tabular-nums", tone === "muted" && "font-medium text-muted-foreground")}>{value}</span>;
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd>
        {financial ? <FinancialData as="span">{content}</FinancialData> : content}
        {note && <span className="block text-2xs text-muted-foreground">{note}</span>}
      </dd>
    </div>
  );
}

function PreviewChecks({ data }: { data: PreviewData }) {
  const items: { ok: boolean; text: ReactNode }[] = [
    {
      ok: data.hasNotice,
      text: data.hasNotice
        ? data.deadline ? `Erinnerung vor dem letzten Kündigungstag am ${dateLabel(data.deadline)}.` : "Kündigungsfrist ist hinterlegt."
        : "Ohne Kündigungsfrist gibt es keine Erinnerung vor Fristende.",
    },
    {
      ok: data.bookings > 0 || !!data.rule,
      text: data.bookings > 0
        ? `${data.bookings === 1 ? "1 Buchung" : `${data.bookings} Buchungen`} zugeordnet${data.rule ? ", neue kommen per Regel dazu" : ""}.`
        : data.rule ? "Neue Abbuchungen werden per Regel zugeordnet." : "Keine Buchungen zugeordnet – der Vertrag läuft nach Plan.",
    },
    { ok: !!data.next, text: data.next ? `Nächste Abbuchung am ${dateLabel(data.next)}, danach ${intervalLabel[data.interval]}.` : "Datum der nächsten Abbuchung fehlt." },
  ];
  return (
    <ul aria-label="Prüfung" className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3 rounded-xl px-1 py-1 text-sm">
          <span aria-hidden="true" className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
            item.ok ? "bg-success-soft text-success" : "bg-warning-soft text-warning")}>
            {item.ok ? <Check className="size-3" strokeWidth={3} /> : <CalendarClock className="size-3" />}
          </span>
          <span className="leading-relaxed">{item.text}</span>
        </li>
      ))}
    </ul>
  );
}
