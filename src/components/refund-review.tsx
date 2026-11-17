"use client";

import { useId, useState } from "react";
import { ArrowRight, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { accountLabel } from "@/lib/accounts";
import { classify } from "@/lib/calc";
import { currency, dateLabel } from "@/lib/format";
import { bookingDescription } from "@/lib/import/merchant-description";
import type { StatementDraft } from "@/lib/import/statements";
import { linkedRefund, ownCostAfterRefund, type RefundQuestion } from "@/lib/refund-link";
import { transactionSchema, type ReviewItem, type Transaction } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A credit in "Kontoauszüge prüfen", laid out like a changed fixed cost: which purchase it refunds (picked from a list
 * when Amex does not say, as for benefit credits), what was paid and what stays the user's own cost after the refund.
 */
export function RefundReview({ item, draft, question, disabled, save, decline }: {
  item: Extract<ReviewItem, { kind: "booking" }>;
  draft: StatementDraft;
  question: RefundQuestion;
  disabled: boolean;
  save: (row: Transaction, id: string) => void;
  /** "Keine Rückerstattung": the credit is reviewed like any other booking. */
  decline: () => void;
}) {
  const [picked, setPicked] = useState(question.suggested);
  const [choosing, setChoosing] = useState(!question.suggested);
  const hintId = useId();
  const credit = Math.abs(draft.amount ?? 0);
  const selected = question.candidates.find((candidate) => candidate.booking.id === picked);
  const own = selected ? ownCostAfterRefund(selected, credit) : undefined;
  const parsed = selected && draft.date
    ? transactionSchema.safeParse(linkedRefund({ ...draft, date: draft.date, amount: credit } as Transaction, selected.booking.id))
    : undefined;
  const shown = choosing ? question.candidates : question.candidates.filter((candidate) => candidate.booking.id === picked);
  const name = bookingDescription(draft);
  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card p-4 shadow-xs" aria-label={`Gutschrift prüfen: ${name}`}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-muted text-primary"><Undo2 className="size-4.5" /></span>
        <div className="min-w-0 flex-1">
          <p className="break-words font-medium">{name}</p>
          <p className="text-xs text-muted-foreground">Gutschrift +{currency(credit)} · {draft.date ? dateLabel(draft.date) : "ohne Datum"}</p>
        </div>
        {own !== undefined && (
          <span className="shrink-0 rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium tabular-nums text-warning"
            title="Was du nach der Erstattung selbst bezahlt hast">
            Eigenanteil {currency(own)}
          </span>
        )}
      </div>
      <div aria-hidden="true" className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-center">
        <div className="rounded-xl bg-surface-sunken/70 px-3 py-2">
          <p className="text-2xs text-muted-foreground">Bezahlt</p>
          <p className="text-sm font-semibold tabular-nums text-muted-foreground line-through decoration-muted-foreground/50">
            {selected ? currency(selected.paid - selected.refunded) : "–"}
          </p>
        </div>
        <ArrowRight className="size-4 text-muted-foreground" />
        <div className="rounded-xl bg-accent-muted px-3 py-2">
          <p className="text-2xs text-primary">Nach Erstattung</p>
          <p className="text-sm font-semibold tabular-nums">{own !== undefined ? currency(own) : "–"}</p>
        </div>
      </div>
      <fieldset className="min-w-0" aria-describedby={hintId}>
        <legend className="sr-only">Für welche Buchung war die Gutschrift?</legend>
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70">
          {shown.map((candidate) => {
            const { booking } = candidate;
            const label = bookingDescription(booking);
            const facts = [dateLabel(booking.date), accountLabel(booking), candidate.exact ? "gleicher Betrag" : "",
              candidate.refunded ? `schon ${currency(candidate.refunded)} erstattet` : ""].filter(Boolean).join(" · ");
            const body = <>
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 break-words font-medium">{label}</p>
                <span className="shrink-0 font-medium tabular-nums">{currency(-candidate.paid)}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{facts}</p>
            </>;
            return choosing ? (
              <label key={booking.id} className={cn("flex cursor-pointer items-start gap-3 px-3 py-2.5 text-sm transition-colors duration-150 hover:bg-muted/40 motion-reduce:transition-none",
                picked === booking.id && "bg-accent-muted/60")}>
                <input type="radio" name={`refund-${item.id}`} className="mt-1 size-4 shrink-0 accent-primary" checked={picked === booking.id}
                  disabled={disabled} onChange={() => setPicked(booking.id)} aria-label={`${label}, ${facts}, ${currency(-candidate.paid)}`} />
                <div className="min-w-0 flex-1">{body}</div>
              </label>
            ) : (
              <div key={booking.id} className="px-3 py-2.5 text-sm" aria-label={`Erkannte Buchung: ${label}`}>{body}</div>
            );
          })}
        </div>
      </fieldset>
      {!choosing && question.candidates.length > 1 && (
        <Button type="button" variant="ghost" size="sm" className="-ml-2 text-muted-foreground" disabled={disabled} onClick={() => setChoosing(true)}>
          Andere Buchung wählen
        </Button>
      )}
      <p className="text-sm">
        {selected
          ? <>War das eine Rückerstattung für {bookingDescription(selected.booking)} vom {dateLabel(selected.booking.date)}?</>
          : "Für welche Buchung war die Gutschrift?"}
      </p>
      <p id={hintId} className="text-xs text-muted-foreground">
        {question.kind === "benefit" && "Amex nennt bei dieser Gutschrift nicht, für welchen Einkauf sie war. "}
        Die Gutschrift senkt dann die Ausgabe dieser Buchung.
      </p>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-3">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={decline}>
          Keine Rückerstattung
        </Button>
        <Button size="sm" disabled={disabled || !parsed?.success}
          onClick={() => { if (parsed?.success) save({ ...parsed.data, includeInPlan: classify(parsed.data).includeInPlan }, item.id); }}>
          Rückerstattung übernehmen
        </Button>
      </div>
    </section>
  );
}
