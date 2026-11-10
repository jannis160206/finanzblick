"use client";

import { useState } from "react";
import { Ban, CalendarClock, Check, EyeOff, FileSignature, Pencil, RotateCcw, Trash2, TrendingUp } from "lucide-react";
import { FinancialData } from "@/components/financial-data";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContractMark, contractTypeLabel } from "@/components/contracts/contract-visuals";
import { Field } from "@/components/ui/premium-dialog";
import { contractNotice } from "@/lib/contract-types";
import { daysBetween, intervalLabel, noticeLabel, type Contract } from "@/lib/contracts";
import { currency, dateLabel } from "@/lib/format";
import type { ContractOverride } from "@/lib/types";

export type ContractPatch = Partial<Omit<ContractOverride, "id" | "updatedAt">>;

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
          <Field label="Vertrag endet am" error={/^\d{4}-\d{2}-\d{2}$/.test(value) ? null : "Bitte ein gültiges Enddatum wählen."}>
            <Input type="date" value={value} onChange={(event) => setEndDate(event.target.value)} />
          </Field>
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
