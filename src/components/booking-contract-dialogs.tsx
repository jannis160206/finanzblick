"use client";

import { useDeferredValue, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Check, FilePlus2, FileSignature, Search, Sparkles, Unlink } from "lucide-react";
import { toast } from "sonner";
import { ContractMark } from "@/components/contracts/contract-visuals";
import { useFinance } from "@/components/finance-provider";
import { MerchantMarksProvider } from "@/components/merchant-marks-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DialogEmpty, PremiumDialog, PremiumDialogBody, PremiumDialogContent, PremiumDialogFooter, PremiumDialogHeader,
} from "@/components/ui/premium-dialog";
import { merchantLogoBookingId, merchantLogoName } from "@/lib/automation/merchant-mark-name";
import { assignBookingToContract, contractFit, contractOfBooking, contractSeedFromBooking } from "@/lib/contract-booking";
import { detectContracts, intervalLabel, isRunning, upsertContractOverride, type Contract } from "@/lib/contracts";
import { currency, dateLabel } from "@/lib/format";
import { bookingDescription } from "@/lib/import/merchant-description";
import type { ContractOverride, Transaction } from "@/lib/types";
import { cn } from "@/lib/utils";

const ContractWizard = dynamic(() => import("@/components/contracts/contract-wizard"), { ssr: false });

export type BookingContractMode = "link" | "create";

const fold = (text: string) => text.toLocaleLowerCase("de-AT").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim();

/** Links a booking to an existing contract or creates a new one from it; both share the detected contracts. */
export function BookingContractDialogs({ booking, mode, open, onModeChange, onClose, returnFocus }: {
  booking: Transaction;
  mode: BookingContractMode;
  open: boolean;
  onModeChange: (mode: BookingContractMode) => void;
  onClose: () => void;
  returnFocus?: () => void;
}) {
  const { state, update, storageError, ready } = useFinance();
  const today = state.settings.asOf;
  const contracts = useMemo(() => detectContracts(state, today), [state, today]);
  const [seed] = useState(() => contractSeedFromBooking(state, booking, today));
  const disabled = !ready || !!storageError;
  const marks = useMemo(() => {
    const rows = contracts.flatMap((contract) => contract.booking ? [contract.booking] : []);
    return {
      merchantIds: [...new Set(rows.flatMap((row) => row.merchantId ? [row.merchantId] : []))],
      merchantNames: [...new Set(rows.flatMap((row) => merchantLogoName(row) ?? []))],
      bookingIds: [...new Set(rows.flatMap((row) => merchantLogoBookingId(row) ?? []))],
    };
  }, [contracts]);

  function save(next: (current: typeof state) => typeof state, message: string) {
    if (disabled) return;
    const previous = state.contracts;
    update(next);
    onClose();
    toast.success(message, { action: { label: "Rückgängig", onClick: () => update((current) => ({ ...current, contracts: previous })) } });
  }

  return (
    <MerchantMarksProvider {...marks}>
      <ContractLinkDialog open={open && mode === "link"} booking={booking} contracts={contracts} stored={state.contracts} today={today} disabled={disabled}
        storageError={storageError} onClose={onClose} onCreate={() => onModeChange("create")} returnFocus={returnFocus}
        onLink={(target) => save((current) => assignBookingToContract(current, contracts, booking.id, target?.id ?? null),
          target ? `Zu „${target.name}“ zugeordnet` : "Zuordnung zum Vertrag gelöst")} />
      {mode === "create" && (
        <ContractWizard open={open} contract={null} seed={seed} contracts={contracts} state={state} today={today}
          disabled={disabled} storageError={storageError} onClose={onClose} returnFocus={returnFocus}
          onSave={(patch) => {
            const id = `manual:${crypto.randomUUID()}`;
            // The picked bookings now belong to the new contract only.
            save((current) => {
              const released = (patch.bookingIds ?? []).reduce((next, bookingId) => assignBookingToContract(next, contracts, bookingId, null), current);
              return { ...released, contracts: upsertContractOverride(released.contracts, id, patch) };
            }, `Vertrag „${patch.name ?? seed.name}“ angelegt`);
          }} />
      )}
    </MerchantMarksProvider>
  );
}

function ContractLinkDialog({ open, onClose, returnFocus, ...props }: {
  open: boolean;
  booking: Transaction;
  contracts: Contract[];
  stored: ContractOverride[] | undefined;
  today: string;
  disabled: boolean;
  storageError: string | null;
  onClose: () => void;
  onCreate: () => void;
  onLink: (contract: Contract | null) => void;
  returnFocus?: () => void;
}) {
  return (
    <PremiumDialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <PremiumDialogContent size="md" onCloseAutoFocus={returnFocus ? (event) => { event.preventDefault(); returnFocus(); } : undefined}>
        <ContractPicker {...props} />
      </PremiumDialogContent>
    </PremiumDialog>
  );
}

function ContractPicker({ booking, contracts, stored, today, disabled, storageError, onCreate, onLink }: {
  booking: Transaction;
  today: string;
  contracts: Contract[];
  stored: ContractOverride[] | undefined;
  disabled: boolean;
  storageError: string | null;
  onCreate: () => void;
  onLink: (contract: Contract | null) => void;
}) {
  const current = useMemo(() => contractOfBooking(contracts, booking.id), [contracts, booking.id]);
  const [selected, setSelected] = useState(current?.id ?? "");
  const [query, setQuery] = useState("");
  const needle = fold(useDeferredValue(query));
  const options = useMemo(() => {
    const matchOf = new Map((stored ?? []).map((entry) => [entry.id, entry]));
    return contracts.filter((contract) => contract.status !== "ignored")
      .map((contract) => ({ contract, fit: contractFit(contract, booking, matchOf.get(contract.id)), running: isRunning(contract, today) }))
      .sort((a, b) => Number(b.contract.id === current?.id) - Number(a.contract.id === current?.id) || b.fit - a.fit ||
        Number(b.running) - Number(a.running) || a.contract.name.localeCompare(b.contract.name, "de"));
  }, [contracts, booking, stored, current, today]);
  const shown = needle ? options.filter(({ contract }) => fold(`${contract.name} ${contract.category}`).includes(needle)) : options;
  const choice = contracts.find((contract) => contract.id === selected);
  const name = bookingDescription(booking);

  return (
    <>
      <PremiumDialogHeader icon={FileSignature} title="Vertrag zuordnen"
        description={`${name} · ${dateLabel(booking.date)} · ${currency(booking.amount)}`} />
      <PremiumDialogBody className="space-y-4">
        {!options.length ? (
          <DialogEmpty icon={FileSignature} title="Noch keine Verträge">
            Lege aus dieser Buchung deinen ersten Vertrag an – Abo, Versicherung oder Handyvertrag.
          </DialogEmpty>
        ) : (
          <>
            {options.length > 5 && (
              <div className="relative">
                <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input type="search" aria-label="Verträge durchsuchen" placeholder="Vertrag suchen …" className="pl-9" value={query}
                  onChange={(event) => setQuery(event.target.value)} />
              </div>
            )}
            <fieldset className="min-w-0">
              <legend className="sr-only">Verträge</legend>
              <ul className="space-y-2">
                {shown.map(({ contract, fit, running }) => {
                  const on = selected === contract.id;
                  return (
                    <li key={contract.id}>
                      <label className={cn(
                        "grid min-h-16 cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border px-3 py-2.5 transition-[background-color,border-color,box-shadow] duration-150 ease-soft has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring motion-reduce:transition-none",
                        on ? "border-primary/60 bg-accent-muted shadow-sm" : "border-border/70 hover:bg-muted/50",
                        !running && "opacity-75")}>
                        <input type="radio" name="booking-contract" value={contract.id} checked={on} className="sr-only"
                          onChange={() => setSelected(contract.id)} />
                        <ContractMark contract={contract} className="size-10" />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{contract.name}</span>
                            {contract.id === current?.id && <Badge variant="outline">Aktuell</Badge>}
                            {contract.id !== current?.id && fit >= 2 && <Badge variant="info"><Sparkles aria-hidden="true" />Passt</Badge>}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {currency(contract.amount)} {intervalLabel[contract.interval]}
                            {contract.status === "review" ? " · neu erkannt" : !running ? " · beendet" : contract.nextDate ? ` · nächste ${dateLabel(contract.nextDate)}` : ""}
                          </span>
                        </span>
                        <span aria-hidden="true" className={cn("flex size-6 items-center justify-center rounded-full border transition-[background-color,border-color,scale] duration-150 ease-soft motion-reduce:transition-none",
                          on ? "scale-100 border-primary bg-primary text-primary-foreground" : "scale-90 border-input")}>
                          {on && <Check className="size-3.5" strokeWidth={3} />}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {!shown.length && <p role="status" className="py-6 text-center text-sm text-muted-foreground">Kein Vertrag passt zu „{query.trim()}“.</p>}
            </fieldset>
          </>
        )}
        {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
      </PremiumDialogBody>
      <PremiumDialogFooter>
        <Button type="button" variant="ghost" className="sm:mr-auto" disabled={disabled} onClick={onCreate}>
          <FilePlus2 aria-hidden="true" />Neuen Vertrag anlegen
        </Button>
        {current && (
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => onLink(null)}>
            <Unlink aria-hidden="true" />Zuordnung lösen
          </Button>
        )}
        <Button type="button" disabled={disabled || !choice || choice.id === current?.id} onClick={() => choice && onLink(choice)}>
          {current && choice && choice.id !== current.id ? "Verschieben" : "Zuordnen"}
        </Button>
      </PremiumDialogFooter>
    </>
  );
}
