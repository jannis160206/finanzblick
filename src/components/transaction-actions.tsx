"use client";

import { CircleHelp, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SharedRowAction } from "@/components/shared-costs";
import { needsMerchantLookup } from "@/lib/merchant-lookup";
import { bookingDescription } from "@/lib/import/merchant-description";
import type { AccountedTransaction } from "@/lib/shared-holiday";

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
}: {
  booking: AccountedTransaction;
  disabled: boolean;
  lookupPending: boolean;
  dialogOpen: boolean;
  onTrigger: (id: string, action: LedgerAction) => void;
  onEdit: () => void;
  onLookup: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Tooltip label="Zuordnung ändern">
        <Button
          size="icon"
          variant="ghost"
          className="size-9"
          disabled={disabled}
          aria-label={`Zuordnung ändern: ${bookingDescription(booking)}`}
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
      <SharedRowAction booking={booking} />
      {needsMerchantLookup(booking) && (
        <Tooltip label="Händlername nachschlagen">
          <Button
            size="icon"
            variant="ghost"
            className="size-9 text-muted-foreground"
            aria-label={`Name nachschlagen: ${bookingDescription(booking)}`}
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
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-9"
            disabled={disabled}
            aria-label={`Weitere Aktionen: ${bookingDescription(booking)}`}
            data-ledger-action="menu"
            data-booking-id={booking.id}
            onFocus={() => onTrigger(booking.id, "menu")}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          onCloseAutoFocus={(event) => {
            if (dialogOpen) event.preventDefault();
          }}
        >
          <DropdownMenuItem
            aria-label={`Löschen: ${bookingDescription(booking)}`}
            className="text-destructive data-[highlighted]:bg-destructive/10"
            onSelect={() => {
              onTrigger(booking.id, "menu");
              onDelete();
            }}
          >
            <Trash2 />
            Löschen
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
