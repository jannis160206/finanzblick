"use client";

import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronRight, CircleHelp, Eye, EyeOff, FilePlus2, FileSignature, MoreHorizontal, Pencil, Receipt, Trash2, Users, type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { PremiumDialog, PremiumDialogBody, PremiumDialogContent, PremiumDialogHeader, PremiumDialogTrigger, PremiumDialogItem } from "@/components/ui/premium-dialog";
import type { BookingContractMode } from "@/components/booking-contract-dialogs";
import { ContractMark } from "@/components/contracts/contract-visuals";
import { useFinance } from "@/components/finance-provider";
import { MerchantMark } from "@/components/merchant-mark";
import { ShareConfirmDialog, SharedRowAction } from "@/components/shared-costs";
import { ReceiptSplitDialog } from "@/components/receipt-split-dialog";
import { accountLabel } from "@/lib/accounts";
import { classify } from "@/lib/calc";
import { canHoldContract, contractOfBooking } from "@/lib/contract-booking";
import { detectContracts, intervalLabel } from "@/lib/contracts";
import { currency, dateLabel } from "@/lib/format";
import { needsMerchantLookup } from "@/lib/merchant-lookup";
import { bookingDescription } from "@/lib/import/merchant-description";
import { isSharedHoliday, type AccountedTransaction } from "@/lib/shared-holiday";
import { cn } from "@/lib/utils";

export type LedgerAction = "edit" | "menu" | "lookup";

export function TransactionActions({
  booking,
  disabled,
  lookupPending,
  dialogOpen,
  onTrigger,
  onEdit,
  onLookup,
  onDelete,
  onToggleIgnored,
  onContract,
  compact = false,
}: {
  booking: AccountedTransaction;
  disabled: boolean;
  lookupPending: boolean;
  dialogOpen: boolean;
  onTrigger: (id: string, action: LedgerAction) => void;
  onEdit: () => void;
  onLookup: () => void;
  onDelete: () => void;
  onToggleIgnored: () => void;
  onContract?: (mode: BookingContractMode) => void;
  /** Cards and narrower tables: only edit and "⋯" stay inline, sharing and lookup move into the sheet. */
  compact?: boolean;
}) {
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // null until first requested, so the confirm dialog only mounts for bookings that need it.
  const [share, setShare] = useState<boolean | null>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const name = bookingDescription(booking);
  // Closes the sheet first, so the follow-up dialog never opens on top of it.
  const then = (action: () => void) => () => {
    onTrigger(booking.id, "menu");
    setSheetOpen(false);
    action();
  };
  return (
    <div className="flex items-center justify-end gap-1">
      <Tooltip label="Zuordnung ändern">
        <Button
          size="icon"
          variant="ghost"
          className="size-9"
          disabled={disabled}
          aria-label={`Zuordnung ändern: ${name}`}
          data-ledger-action="edit"
          data-booking-id={booking.id}
          onClick={() => {
            onTrigger(booking.id, "edit");
            onEdit();
          }}
        >
          <Pencil className="size-4" />
        </Button>
      </Tooltip>
      {!compact && <SharedRowAction booking={booking} />}
      {!compact && needsMerchantLookup(booking) && (
        <Tooltip label="Händlername nachschlagen">
          <Button
            size="icon"
            variant="ghost"
            className="size-9 text-muted-foreground"
            aria-label={`Name nachschlagen: ${name}`}
            disabled={lookupPending || disabled}
            data-ledger-action="lookup"
            data-booking-id={booking.id}
            onClick={() => {
              onTrigger(booking.id, "lookup");
              onLookup();
            }}
          >
            <CircleHelp className="size-4" />
          </Button>
        </Tooltip>
      )}
      <PremiumDialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <PremiumDialogTrigger asChild>
          <Button
            ref={menuTrigger}
            size="icon"
            variant="ghost"
            className="size-9"
            disabled={disabled}
            aria-label={`Weitere Aktionen: ${name}`}
            data-ledger-action="menu"
            data-booking-id={booking.id}
            onFocus={() => onTrigger(booking.id, "menu")}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </PremiumDialogTrigger>
        <PremiumDialogContent size="sm" onCloseAutoFocus={(event) => { if (dialogOpen || receiptOpen || share) event.preventDefault(); }}>
          <BookingSheet booking={booking} name={name} actions={{
            edit: then(onEdit),
            share: compact ? then(() => setShare(true)) : undefined,
            lookup: compact && needsMerchantLookup(booking) ? then(onLookup) : undefined,
            lookupPending,
            contract: onContract && canHoldContract(booking) ? (mode) => then(() => onContract(mode))() : undefined,
            receipt: booking.amount < 0 ? then(() => setReceiptOpen(true)) : undefined,
            ignore: then(onToggleIgnored),
            remove: then(onDelete),
          }} />
        </PremiumDialogContent>
      </PremiumDialog>
      {receiptOpen && <ReceiptSplitDialog booking={booking} onClose={() => setReceiptOpen(false)} />}
      {share !== null && <ShareConfirmDialog booking={booking} open={share} onOpenChange={setShare}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          menuTrigger.current?.focus();
        }} />}
    </div>
  );
}

type SheetActions = {
  edit: () => void;
  share?: () => void;
  lookup?: () => void;
  lookupPending?: boolean;
  contract?: (mode: BookingContractMode) => void;
  receipt?: () => void;
  ignore: () => void;
  remove: () => void;
};

/** One booking with everything that can be done with it – a bottom sheet on phones, a small dialog on larger screens. */
function BookingSheet({ booking, name, actions }: { booking: AccountedTransaction; name: string; actions: SheetActions }) {
  const { state } = useFinance();
  const classification = classify(booking);
  const contractable = !!actions.contract;
  const linked = useMemo(
    () => contractable ? contractOfBooking(detectContracts(state, state.settings.asOf), booking.id) : undefined,
    [contractable, state, booking.id],
  );
  return (
    <>
      <PremiumDialogHeader title={name} description={`${dateLabel(booking.date)} · ${accountLabel(booking)}`} />
      <PremiumDialogBody className="space-y-5">
        <PremiumDialogItem className="flex items-center gap-3 rounded-2xl bg-surface-sunken/70 p-3">
          <MerchantMark booking={booking} classification={classification} fallbackName={name} className="size-11 rounded-xl" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{classification.category}</span>
            <span className="block truncate text-xs text-muted-foreground">{booking.note || (booking.ignored ? "Ignoriert – zählt in keiner Statistik" : classification.reason || "Im Alltagsbudget berücksichtigt")}</span>
          </span>
          <span className={cn("amount shrink-0 text-lg", booking.amount > 0 ? "text-money-in" : booking.amount < 0 && "text-money-out")}>{currency(booking.amount)}</span>
        </PremiumDialogItem>
        {actions.contract && (
          <ActionGroup label="Vertrag">
            {linked ? (
              <li>
                <button type="button" onClick={() => actions.contract?.("link")} aria-label={`Vertrag ändern: ${linked.name}`}
                  className="grid min-h-16 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none">
                  <ContractMark contract={linked} className="size-9" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{linked.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">Zugeordnet · {currency(linked.amount)} {intervalLabel[linked.interval]}</span>
                  </span>
                  <span className="flex items-center gap-1 text-xs font-medium text-primary">Ändern<ChevronRight aria-hidden="true" className="size-4" /></span>
                </button>
              </li>
            ) : (
              <>
                <ActionRow icon={FileSignature} label="Vertrag zuordnen" hint="Zu einem bestehenden Vertrag oder Abo" ariaLabel={`Vertrag zuordnen: ${name}`}
                  onClick={() => actions.contract?.("link")} />
                <ActionRow icon={FilePlus2} label="Als Vertrag anlegen" hint="Vorausgefüllt mit Händler, Betrag und Datum" ariaLabel={`Als Vertrag anlegen: ${name}`}
                  onClick={() => actions.contract?.("create")} />
              </>
            )}
          </ActionGroup>
        )}
        <ActionGroup label="Buchung">
          <ActionRow icon={Pencil} label="Zuordnung ändern" hint="Kategorie, Name, Fixkosten und Notiz" ariaLabel={`Zuordnung ändern: ${name}`} onClick={actions.edit} />
          {actions.share && booking.amount < 0 && !classification.isTransfer && (
            <ActionRow icon={Users} label={isSharedHoliday(booking) ? "Bereits mit Raphael geteilt" : "Mit Raphael teilen"} hint="Es zählt nur noch die Hälfte"
              ariaLabel={`Mit Raphael teilen: ${name}`} disabled={isSharedHoliday(booking)} onClick={actions.share} />
          )}
          {actions.lookup && (
            <ActionRow icon={CircleHelp} label="Händlernamen nachschlagen" hint="Lesbaren Namen für den Buchungstext finden"
              ariaLabel={`Händlernamen nachschlagen: ${name}`} disabled={actions.lookupPending} onClick={actions.lookup} />
          )}
          {actions.receipt && (
            <ActionRow icon={Receipt} label={booking.splits?.length ? "Aufteilung ansehen" : "Kassenbon aufteilen"} hint="Artikel auf mehrere Kategorien verteilen"
              ariaLabel={`Kassenbon aufteilen: ${name}`} onClick={actions.receipt} />
          )}
          <ActionRow icon={booking.ignored ? Eye : EyeOff} label={booking.ignored ? "Wieder berücksichtigen" : "Ignorieren"}
            hint={booking.ignored ? "Zählt wieder in Budget und Auswertungen" : "Zählt in keiner Statistik und keinem Budget"}
            ariaLabel={`${booking.ignored ? "Wieder berücksichtigen" : "Ignorieren"}: ${name}`} onClick={actions.ignore} />
          <ActionRow icon={Trash2} label="Löschen" hint="Aus allen Berechnungen entfernen" tone="destructive" ariaLabel={`Löschen: ${name}`} onClick={actions.remove} />
        </ActionGroup>
      </PremiumDialogBody>
    </>
  );
}

function ActionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <PremiumDialogItem>
      <h3 className="eyebrow mb-2 px-1">{label}</h3>
      <ul aria-label={label} className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card">{children}</ul>
    </PremiumDialogItem>
  );
}

function ActionRow({ icon: Icon, label, hint, ariaLabel, tone, disabled, onClick }: {
  icon: LucideIcon; label: string; hint: string; ariaLabel: string; tone?: "destructive"; disabled?: boolean; onClick: () => void;
}) {
  return (
    <li>
      <button type="button" aria-label={ariaLabel} onClick={onClick} disabled={disabled}
        className="group grid min-h-14 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none">
        <span aria-hidden="true" className={cn("flex size-9 items-center justify-center rounded-xl transition-transform duration-150 ease-soft group-active:scale-90 motion-reduce:transition-none",
          tone === "destructive" ? "bg-destructive/10 text-destructive" : "bg-accent-muted text-primary")}>
          <Icon className="size-4" />
        </span>
        <span className="min-w-0">
          <span className={cn("block text-sm font-medium", tone === "destructive" && "text-destructive")}>{label}</span>
          <span className="block text-xs leading-snug text-muted-foreground">{hint}</span>
        </span>
        <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground/70 transition-transform duration-150 ease-soft group-hover:translate-x-0.5 motion-reduce:transition-none" />
      </button>
    </li>
  );
}
