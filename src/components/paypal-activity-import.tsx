"use client";

import { useRef, useState } from "react";
import { LoaderCircle, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFinance } from "@/components/finance-provider";
import { autoAssignOpenReviews } from "@/lib/ai/auto-assign";
import { isUnnamedPaypal, matchPaypalActivity, parsePaypalActivity } from "@/lib/import/paypal-activity";
import type { ReviewItem } from "@/lib/import/review";

const MAX_BYTES = 10 * 1024 * 1024;

// Shared by the hint below and the main import, which hands PayPal exports over instead of parsing them as statements.
export function usePaypalActivityImport() {
  const { state, update } = useFinance();
  return async (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error("Der PayPal-Export ist zu groß (maximal 10 MB).");
      return;
    }
    try {
      const activity = parsePaypalActivity(await file.text());
      const base = state;
      const result = matchPaypalActivity(base, activity);
      const auto = autoAssignOpenReviews(result.state);
      const assigned = auto.applied.length;
      if (result.matched.length)
        update((current) => current === base ? auto.state
          : autoAssignOpenReviews(matchPaypalActivity(current, activity).state).state);
      if (!result.matched.length) {
        toast.info("PayPal-Export gelesen – keine offene PayPal-Buchung passte eindeutig.", {
          description: `${result.rows} Zahlungen im Export. PayPal-Zahlungen werden nicht doppelt gebucht, sie ergänzen nur den Händler bei Amex- und Bankbuchungen.`,
        });
        return;
      }
      toast.success(`${result.matched.length} PayPal-Buchung${result.matched.length === 1 ? "" : "en"} mit Händler ergänzt`, {
        description: [
          assigned ? `${assigned} davon direkt zugeordnet.` : "",
          result.ambiguous ? `${result.ambiguous} nicht eindeutig, bitte selbst prüfen.` : "",
        ].filter(Boolean).join(" ") || undefined,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Der PayPal-Export konnte nicht gelesen werden.");
    }
  };
}

// The bank or Amex only shows "…/PAYPAL" or a cut name; PayPal's own export names the shop for the same amount and day.
export function PaypalActivityImport({ review, disabled }: { review: readonly ReviewItem[]; disabled?: boolean }) {
  const importActivity = usePaypalActivityImport();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const open = review.filter((item) => item.kind === "booking" && item.draft.amount !== null &&
    isUnnamedPaypal({ id: item.id, amount: item.draft.amount, description: item.draft.description, merchantAlias: item.draft.merchantAlias })).length;
  if (!open) return null;

  const read = async (file: File) => {
    setBusy(true);
    try {
      await importActivity(file);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">
        {open} PayPal-Buchung{open === 1 ? "" : "en"} ohne Händler. Mit dem PayPal-Aktivitätenexport (CSV) wird der Shop ergänzt – auch bei Amex.
      </span>
      <input ref={input} type="file" accept=".csv,text/csv" className="hidden" aria-label="PayPal-Export auswählen"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void read(file);
        }} />
      <Button type="button" variant="outline" size="sm" disabled={disabled || busy} onClick={() => input.current?.click()}>
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Upload className="size-4" />}
        PayPal-CSV abgleichen
      </Button>
    </div>
  );
}
