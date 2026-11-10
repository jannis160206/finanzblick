"use client";

import { useState, type FormEvent } from "react";
import { Ban, CalendarClock, Check, EyeOff, FileSignature, Pencil, RotateCcw, Trash2, TrendingUp } from "lucide-react";
import { CategorySelect } from "@/components/category-select";
import { FinancialData } from "@/components/financial-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogForm, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContractMark, contractTypeLabel } from "@/components/contracts/contract-visuals";
import { categories, type Category } from "@/lib/categories";
import { contractNotice } from "@/lib/contract-types";
import { daysBetween, intervalLabel, noticeLabel, type Contract } from "@/lib/contracts";
import { currency, dateLabel, number } from "@/lib/format";
import { parseMoneyText } from "@/lib/money-parse";
import { contractIntervals, contractOverrideSchema, type ContractInterval, type ContractNotice, type ContractOverride } from "@/lib/types";

export type ContractPatch = Partial<Omit<ContractOverride, "id" | "updatedAt">>;

type Form = {
  name: string;
  amount: string;
  interval: ContractInterval;
  nextDate: string;
  category: Category;
  noticeValue: string;
  noticeUnit: ContractNotice["unit"];
  termEnd: string;
  autoRenew: boolean;
  renewalMonths: string;
  note: string;
};

const unitLabel: Record<ContractNotice["unit"], string> = { days: "Tage", weeks: "Wochen", months: "Monate" };
const selectableCategory = (category: Category): Category => categories.includes(category as (typeof categories)[number]) ? category : "Sonstiges";

function formOf(contract: Contract | null, today: string): Form {
  return {
    name: contract?.name ?? "",
    amount: contract ? number(contract.amount) : "",
    interval: contract?.interval ?? "monthly",
    nextDate: contract?.nextDate ?? today,
    category: selectableCategory(contract?.category ?? "Abonnements"),
    noticeValue: contract?.notice ? String(contract.notice.value) : "",
    noticeUnit: contract?.notice?.unit ?? "months",
    termEnd: contract?.termEnd ?? "",
    autoRenew: contract?.autoRenew ?? true,
    renewalMonths: contract?.termEnd ? String(contract.renewalMonths) : "12",
    note: contract?.note ?? "",
  };
}

const fieldClass = "block text-sm font-medium";

/** Create a manual contract (contract = null) or correct a detected one. */
export function ContractEditDialog({ contract, open, today, disabled, storageError, onClose, onSave }: {
  contract: Contract | null;
  open: boolean;
  today: string;
  disabled: boolean;
  storageError: string | null;
  onClose: () => void;
  onSave: (patch: ContractPatch) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{contract ? `${contract.name} bearbeiten` : "Vertrag hinzufügen"}</DialogTitle>
          <DialogDescription>{contract
            ? "Korrekturen bleiben erhalten, auch wenn neue Buchungen dazukommen."
            : "Für Verträge, die nicht über dein Konto abgebucht werden."}</DialogDescription>
        </DialogHeader>
        {open && <ContractForm key={contract?.id ?? "new"} contract={contract} today={today} disabled={disabled} storageError={storageError} onClose={onClose} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  );
}

function ContractForm({ contract, today, disabled, storageError, onClose, onSave }: {
  contract: Contract | null;
  today: string;
  disabled: boolean;
  storageError: string | null;
  onClose: () => void;
  onSave: (patch: ContractPatch) => void;
}) {
  const [form, setForm] = useState<Form>(() => formOf(contract, today));
  const [error, setError] = useState<{ field: keyof Form; message: string } | null>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (error?.field === key) setError(null);
  };
  const typical = contract ? contractNotice[contract.type] : null;
  const invalid = (field: keyof Form) => error?.field === field;
  const described = (field: keyof Form) => error?.field === field ? "contract-form-error" : undefined;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const fail = (field: keyof Form, message: string) => {
      setError({ field, message });
      const input = event.currentTarget.elements.namedItem(field);
      if (input instanceof HTMLElement) input.focus();
    };
    const name = form.name.trim();
    if (!name || name.length > 100) return fail("name", "Bitte einen Namen mit 1 bis 100 Zeichen eingeben.");
    const amount = parseMoneyText(form.amount);
    if (amount === null || amount <= 0 || amount > 1_000_000) return fail("amount", "Bitte einen Betrag größer als 0 eingeben, z. B. 12,99.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.nextDate)) return fail("nextDate", "Bitte das Datum der nächsten Abbuchung angeben.");
    const noticeValue = form.noticeValue.trim() ? Number(form.noticeValue) : null;
    if (noticeValue !== null && (!Number.isInteger(noticeValue) || noticeValue < 1 || noticeValue > 730)) {
      return fail("noticeValue", "Die Kündigungsfrist muss eine ganze Zahl zwischen 1 und 730 sein.");
    }
    const renewalMonths = Number(form.renewalMonths);
    if (form.termEnd && form.autoRenew && (!Number.isInteger(renewalMonths) || renewalMonths < 1 || renewalMonths > 60)) {
      return fail("renewalMonths", "Die Verlängerung muss zwischen 1 und 60 Monaten liegen.");
    }
    // Unchanged core fields stay out of the patch so earlier corrections and future detection updates survive.
    const patch: ContractPatch = {
      ...(!contract || name !== contract.name ? { name } : {}),
      ...(!contract || amount !== contract.amount ? { amount } : {}),
      ...(!contract || form.interval !== contract.interval ? { interval: form.interval } : {}),
      ...(!contract || form.nextDate !== contract.nextDate ? { nextDate: form.nextDate } : {}),
      ...(!contract || form.category !== selectableCategory(contract.category) ? { category: form.category } : {}),
      notice: noticeValue === null ? undefined : { value: noticeValue, unit: form.noticeUnit },
      termEnd: form.termEnd || undefined,
      autoRenew: form.termEnd ? form.autoRenew : undefined,
      renewalMonths: form.termEnd && form.autoRenew ? renewalMonths : undefined,
      note: form.note.trim() || undefined,
      ...(contract ? contract.status === "review" ? { status: "confirmed" as const } : {} : { manual: true, status: "confirmed" as const }),
    };
    const parsed = contractOverrideSchema.safeParse({
      id: contract?.id ?? "check",
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
      updatedAt: 0,
    });
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? "name");
      return fail(field in form ? field as keyof Form : "name", "Bitte die Eingaben prüfen.");
    }
    onSave(patch);
  }

  return (
    <DialogForm noValidate onSubmit={submit}>
      <DialogBody className="space-y-5">
        <label className={fieldClass}>Name
          <Input name="name" className="mt-2" autoFocus value={form.name} maxLength={100} aria-invalid={invalid("name")} aria-describedby={described("name")}
            onChange={(event) => set("name", event.target.value)} required />
        </label>
        <div className="grid gap-5 sm:grid-cols-2">
          <label className={fieldClass}>Betrag (€)
            <Input name="amount" className="mt-2 text-right tabular-nums" inputMode="decimal" placeholder="0,00" value={form.amount} aria-invalid={invalid("amount")} aria-describedby={described("amount")}
              onChange={(event) => set("amount", event.target.value)} required />
          </label>
          <label className={fieldClass}>Rhythmus
            <select name="interval" className="select-input mt-2 w-full" value={form.interval}
              onChange={(event) => set("interval", contractIntervals.find((item) => item === event.target.value) ?? "monthly")}>
              {contractIntervals.map((interval) => <option key={interval} value={interval}>{intervalLabel[interval]}</option>)}
            </select>
          </label>
          <label className={fieldClass}>Nächste Abbuchung
            <Input name="nextDate" className="mt-2" type="date" value={form.nextDate} aria-invalid={invalid("nextDate")} aria-describedby={described("nextDate")}
              onChange={(event) => set("nextDate", event.target.value)} required />
          </label>
          <div className={fieldClass}>Kategorie
            <CategorySelect label="Kategorie" name="category" excludeReview className="mt-2" value={form.category} onValueChange={(value) => set("category", value)} />
          </div>
        </div>
        <fieldset className="space-y-3 rounded-2xl border border-border/70 p-4">
          <legend className="px-1 text-sm font-medium">Kündigung</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className={fieldClass}>
              <span id="contract-notice-label">Kündigungsfrist</span>
              <div className="mt-2 flex gap-2">
                <Input name="noticeValue" aria-labelledby="contract-notice-label" className="w-24 tabular-nums" inputMode="numeric" placeholder="–" value={form.noticeValue}
                  aria-invalid={invalid("noticeValue")} aria-describedby={described("noticeValue")} onChange={(event) => set("noticeValue", event.target.value.replace(/\D/g, ""))} />
                <select aria-label="Einheit der Kündigungsfrist" className="select-input min-w-0 flex-1" value={form.noticeUnit}
                  onChange={(event) => set("noticeUnit", event.target.value === "days" ? "days" : event.target.value === "weeks" ? "weeks" : "months")}>
                  {(Object.keys(unitLabel) as ContractNotice["unit"][]).map((unit) => <option key={unit} value={unit}>{unitLabel[unit]}</option>)}
                </select>
              </div>
            </div>
            <label className={fieldClass}>Mindestlaufzeit bis
              <Input name="termEnd" className="mt-2" type="date" value={form.termEnd} onChange={(event) => set("termEnd", event.target.value)} />
            </label>
          </div>
          {form.termEnd && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <label className="inline-flex min-h-11 items-center gap-2">
              <input type="checkbox" className="size-4 accent-primary" checked={form.autoRenew} onChange={(event) => set("autoRenew", event.target.checked)} />
              Verlängert sich automatisch
            </label>
            {form.autoRenew && <label className="inline-flex items-center gap-2">um
              <Input name="renewalMonths" className="w-20 tabular-nums" inputMode="numeric" value={form.renewalMonths} aria-label="Verlängerung in Monaten"
                aria-invalid={invalid("renewalMonths")} aria-describedby={described("renewalMonths")} onChange={(event) => set("renewalMonths", event.target.value.replace(/\D/g, ""))} />
              Monate</label>}
          </div>}
          <p className="text-xs leading-relaxed text-muted-foreground">
            {typical ? `${typical.label}: ${typical.text}` : "Mit Frist und Laufzeit erinnert dich Finanzblick rechtzeitig vor dem letzten Kündigungstag."}
          </p>
        </fieldset>
        <label className={fieldClass}>Notiz
          <textarea name="note" rows={2} maxLength={500} value={form.note} onChange={(event) => set("note", event.target.value)}
            className="mt-2 block w-full resize-y rounded-xl border border-input bg-background/50 px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="z. B. Kundennummer oder Kündigungsweg" />
        </label>
        {error && <p id="contract-form-error" role="alert" className="text-sm text-destructive">{error.message}</p>}
        {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Abbrechen</Button>
        <Button type="submit" disabled={disabled}>Speichern</Button>
      </DialogFooter>
    </DialogForm>
  );
}

export function ContractCancelDialog({ contract, today, disabled, onClose, onConfirm }: {
  contract: Contract | null;
  today: string;
  disabled: boolean;
  onClose: () => void;
  onConfirm: (endDate: string) => void;
}) {
  const [endDate, setEndDate] = useState("");
  const value = endDate || contract?.effectiveEnd || contract?.nextDate || today;
  return (
    <Dialog open={!!contract} onOpenChange={(next) => { if (!next) { setEndDate(""); onClose(); } }}>
      <DialogContent variant="confirmation">
        <DialogHeader>
          <DialogTitle>Als gekündigt markieren?</DialogTitle>
          <DialogDescription>{contract?.name} zählt ab dem Enddatum nicht mehr zu deinen laufenden Kosten und zur Prognose.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <label className={fieldClass}>Vertrag endet am
            <Input type="date" className="mt-2" value={value} onChange={(event) => setEndDate(event.target.value)} />
          </label>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setEndDate(""); onClose(); }}>Abbrechen</Button>
          <Button disabled={disabled || !/^\d{4}-\d{2}-\d{2}$/.test(value)} onClick={() => { setEndDate(""); onConfirm(value); }}>Als gekündigt markieren</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type ContractAction = "confirm" | "ignore" | "restore" | "cancel" | "reactivate" | "reset" | "remove" | "prepare" | "edit";

export function ContractDetailDialog({ contract, today, disabled, onClose, onAction }: {
  contract: Contract | null;
  today: string;
  disabled: boolean;
  onClose: () => void;
  onAction: (action: ContractAction, contract: Contract) => void;
}) {
  return (
    <Dialog open={!!contract} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent variant="panel">
        {contract && <ContractDetail contract={contract} today={today} disabled={disabled} onAction={onAction} />}
      </DialogContent>
    </Dialog>
  );
}

function ContractDetail({ contract, today, disabled, onAction }: {
  contract: Contract;
  today: string;
  disabled: boolean;
  onAction: (action: ContractAction, contract: Contract) => void;
}) {
  const typical = contractNotice[contract.type];
  const running = contract.status === "active" || contract.status === "review";
  const deadlineDays = contract.deadline ? daysBetween(today, contract.deadline) : null;
  const facts: [string, string][] = [
    ["Betrag", `${currency(contract.amount)} ${intervalLabel[contract.interval]}`],
    ["Im Monat", currency(contract.monthly)],
    ["Im Jahr", currency(contract.yearly)],
    ...(contract.nextDate && running ? [["Nächste Abbuchung", dateLabel(contract.nextDate)] as [string, string]] : []),
    ...(contract.lastDate ? [["Zuletzt abgebucht", dateLabel(contract.lastDate)] as [string, string]] : []),
    ...(contract.account ? [["Konto", contract.account] as [string, string]] : []),
    ["Kategorie", contract.category],
    ["Kündigungsfrist", contract.notice ? noticeLabel(contract.notice) : "nicht hinterlegt"],
    ...(contract.termEnd ? [["Mindestlaufzeit bis", dateLabel(contract.termEnd)] as [string, string]] : []),
    ...(contract.cancelledAt ? [["Endet am", dateLabel(contract.cancelledAt)] as [string, string]] : []),
  ];
  const source = contract.source === "manual" ? "Manuell angelegt" : contract.source === "fixed" ? "Aus deinen Fixkosten" : `Erkannt aus ${contract.charges.length} Abbuchungen`;
  return (
    <>
      <DialogHeader className="space-y-4">
        <div className="flex items-center gap-3">
          <ContractMark contract={contract} className="size-12 rounded-2xl" />
          <div className="min-w-0">
            <DialogTitle className="break-words">{contract.name}</DialogTitle>
            <DialogDescription>{contractTypeLabel[contract.type]} · {source}</DialogDescription>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {contract.status === "review" && <Badge variant="info">Neu erkannt</Badge>}
          {contract.status === "cancelled" && <Badge variant="secondary">Gekündigt</Badge>}
          {contract.status === "ignored" && <Badge variant="secondary">Ignoriert</Badge>}
          {contract.edited && <Badge variant="outline">Bearbeitet</Badge>}
          {contract.priceChange && contract.priceChange.percent > 0 && <Badge variant="warning"><TrendingUp aria-hidden="true" />+{contract.priceChange.percent.toLocaleString("de-AT")} %</Badge>}
        </div>
      </DialogHeader>
      <DialogBody className="space-y-6 pt-0">
        {running && contract.deadline && contract.effectiveEnd && deadlineDays !== null && (
          <FinancialData as="div" className={deadlineDays <= 14 ? "rounded-2xl bg-warning-soft p-4" : "rounded-2xl bg-surface-sunken p-4"}>
            <p className="flex items-center gap-2 text-sm font-semibold"><CalendarClock aria-hidden="true" className="size-4" />Kündigen bis {dateLabel(contract.deadline)}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {deadlineDays === 0 ? "Heute ist der letzte Tag" : `Noch ${deadlineDays} ${deadlineDays === 1 ? "Tag" : "Tage"}`}, damit der Vertrag am {dateLabel(contract.effectiveEnd)} endet. Danach verlängert er sich.
            </p>
          </FinancialData>
        )}
        <FinancialData as="dl" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2.5 text-sm">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words text-right font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </FinancialData>
        {!contract.notice && running && (
          <p className="rounded-2xl border border-dashed border-border p-4 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Üblich bei {typical.label}:</span> {typical.text} Trage die Frist aus deinem Vertrag ein, dann erinnern wir dich rechtzeitig.
          </p>
        )}
        {contract.note && <p className="whitespace-pre-line text-sm text-muted-foreground">{contract.note}</p>}
        {(running || (contract.edited && contract.source !== "manual")) && (
          <div className="-mx-2 flex flex-wrap gap-1 border-t border-border/60 pt-4">
            {running && <Button variant="ghost" size="sm" onClick={() => onAction("prepare", contract)}><FileSignature aria-hidden="true" />Kündigung vorbereiten</Button>}
            {running && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onAction("cancel", contract)}><Ban aria-hidden="true" />Als gekündigt markieren</Button>}
            {contract.edited && contract.source !== "manual" && <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onAction("reset", contract)}><RotateCcw aria-hidden="true" />Änderungen verwerfen</Button>}
          </div>
        )}
        {contract.charges.length > 0 && (
          <section aria-labelledby="contract-charges-title">
            <h3 id="contract-charges-title" className="mb-2 text-sm font-semibold">Abbuchungen</h3>
            <FinancialData as="ul" className="divide-y divide-border/60 rounded-2xl border border-border/70">
              {contract.charges.slice(0, 12).map((charge) => (
                <li key={charge.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span className="text-muted-foreground">{dateLabel(charge.date)}</span>
                  <span className="font-medium tabular-nums">{currency(-charge.amount)}</span>
                </li>
              ))}
            </FinancialData>
          </section>
        )}
      </DialogBody>
      <DialogFooter>
        {running && contract.source !== "manual" && <Button variant="ghost" className="sm:mr-auto" disabled={disabled} onClick={() => onAction("ignore", contract)}><EyeOff aria-hidden="true" />Kein Vertrag</Button>}
        {contract.source === "manual" && <Button variant="ghost" className="text-destructive sm:mr-auto" disabled={disabled} onClick={() => onAction("remove", contract)}><Trash2 aria-hidden="true" />Entfernen</Button>}
        <Button variant={contract.status === "review" ? "outline" : "default"} disabled={disabled} onClick={() => onAction("edit", contract)}><Pencil aria-hidden="true" />Bearbeiten</Button>
        {contract.status === "review" && <Button disabled={disabled} onClick={() => onAction("confirm", contract)}><Check aria-hidden="true" />Bestätigen</Button>}
        {contract.status === "cancelled" && <Button variant="outline" disabled={disabled} onClick={() => onAction("reactivate", contract)}><RotateCcw aria-hidden="true" />Wieder aktiv</Button>}
        {contract.status === "ignored" && <Button variant="outline" disabled={disabled} onClick={() => onAction("restore", contract)}><RotateCcw aria-hidden="true" />Wiederherstellen</Button>}
      </DialogFooter>
    </>
  );
}
