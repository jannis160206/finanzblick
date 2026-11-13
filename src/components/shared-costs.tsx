"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Search, Users, X } from "lucide-react";
import { Tabs } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import {
  Field, PremiumDialog, PremiumDialogBody, PremiumDialogContent, PremiumDialogFooter, PremiumDialogHeader, PremiumDialogTrigger,
} from "@/components/ui/premium-dialog";
import { cn } from "@/lib/utils";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { MerchantMark } from "@/components/merchant-mark";
import { DrawnCheckbox } from "@/components/ui/drawn-checkbox";
import { classify, round } from "@/lib/calc";
import { currency, dateLabel } from "@/lib/format";
import { parseStatementAmount } from "@/lib/import/statements";
import { bookingDescription } from "@/lib/import/merchant-description";
import { decideSharedSettlement, isRaphaelPayment, isSharedHoliday, personalAmount, selectSharedBookings, type AccountedTransaction, type HolidayReceivable } from "@/lib/shared-holiday";
import { matchesTransactionSearch } from "@/lib/transaction-tools";

const tabClass = "min-h-10 rounded-lg px-2 py-2 text-sm sm:px-3 font-medium text-muted-foreground outline-none transition-[background-color,color,box-shadow] duration-150 ease-soft focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm motion-reduce:transition-none";

/** Total, my half and Raphael's half as one bar – the live preview of a split. */
function SplitPreview({ total, own, label, className }: { total: number; own: number; label?: ReactNode; className?: string }) {
  const partner = round(total - own);
  return (
    <FinancialData aria-label="Vorschau der Aufteilung" className={cn("space-y-2.5 rounded-2xl bg-surface-sunken/70 p-3 sm:space-y-3 sm:p-4", className)}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-muted-foreground">{label ?? "Gesamt"}</span>
        <span className="amount shrink-0">{currency(total)}</span>
      </div>
      <div aria-hidden="true" className="flex h-2 gap-0.5 overflow-hidden rounded-full">
        <span className="h-full rounded-l-full bg-primary" style={{ flexGrow: Math.max(own, 0.01) }} />
        <span className="h-full rounded-r-full bg-chart-3" style={{ flexGrow: Math.max(partner, 0.01) }} />
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="flex items-center gap-1.5 text-muted-foreground"><span aria-hidden="true" className="size-2 rounded-full bg-primary" />Meine Hälfte</dt>
          <dd className="amount text-sm">{currency(own)}</dd>
        </div>
        <div className="text-right">
          <dt className="flex items-center justify-end gap-1.5 text-muted-foreground"><span aria-hidden="true" className="size-2 rounded-full bg-chart-3" />Raphael</dt>
          <dd className="amount text-sm">{currency(partner)}</dd>
        </div>
      </dl>
    </FinancialData>
  );
}

function ShareRows({ items, onPaid, disabled }: { items: HolidayReceivable[]; onPaid: (id: string) => void; disabled: boolean }) {
  if (!items.length) return null;
  return <ul className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-card">
    {items.map((item) => <li key={item.bookingId} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-xs">
      <div className="min-w-0 flex-1 basis-56">
        <p className="truncate text-sm font-medium" title={bookingDescription(item)}>{bookingDescription(item)}</p>
        <p className="text-muted-foreground">{dateLabel(item.date)} · Gesamt {currency(item.fullAmount)} · Meine Hälfte {currency(item.ownSpend)}</p>
        {item.refundedAmount > 0 && <p className="text-muted-foreground">Händlererstattung {currency(item.refundedAmount)}</p>}
      </div>
      <span className="rounded-full bg-accent-muted px-2.5 py-1 font-medium text-primary tabular-nums">Offen {currency(item.outstanding)}</span>
      <Button size="sm" variant="soft" disabled={disabled}
        aria-label={`Als bezahlt markieren: ${item.description}`}
        onClick={() => onPaid(item.bookingId)}>Als bezahlt markieren</Button>
    </li>)}
  </ul>;
}

export function SharedRowAction({ booking }: { booking: AccountedTransaction }) {
  const { update, storageError } = useFinance();
  const [open, setOpen] = useState(false);
  const classification = booking.amount < 0 ? classify(booking) : null;
  if (!classification || classification.isTransfer) return null;
  const shared = isSharedHoliday(booking);
  return <PremiumDialog open={open} onOpenChange={setOpen}>
    <FinancialData as="span" className="inline-flex">
    <Tooltip label={shared ? "Bereits mit Raphael geteilt" : "Mit Raphael teilen"}>
    <PremiumDialogTrigger asChild>
      <Button size="icon" variant="ghost" className="size-9" disabled={shared || !!storageError}
        aria-label={`${shared ? "Bereits geteilt" : "Teilen"}: ${booking.description}`}
        title={shared ? "Bereits geteilt" : "Mit Raphael teilen"}>
        <Users className="size-3.5" />
      </Button>
    </PremiumDialogTrigger>
    </Tooltip>
    </FinancialData>
    <PremiumDialogContent size="sm" variant="confirmation">
      <PremiumDialogHeader icon={Users} title="Diese Buchung als geteilt markieren?" description="Es zählt nur noch die Hälfte." />
      <PremiumDialogBody className="min-w-0 space-y-3 text-sm">
        <div className="flex items-center gap-3">
          <MerchantMark booking={booking} classification={classification} fallbackName={bookingDescription(booking)} className="size-10 rounded-xl" />
          <span className="min-w-0">
            <span className="block truncate font-medium" title={bookingDescription(booking)}>{bookingDescription(booking)}</span>
            <span className="block text-xs text-muted-foreground">{dateLabel(booking.date)}</span>
          </span>
        </div>
        <SplitPreview total={Math.abs(booking.amount)} own={Math.abs(personalAmount({ ...booking, sharedWithRaphael: true }))} />
        {storageError && <p role="alert" className="text-sm font-medium text-destructive">{storageError}</p>}
      </PremiumDialogBody>
      <PremiumDialogFooter>
        <Button variant="outline" onClick={() => setOpen(false)}>Abbrechen</Button>
        <Button disabled={!!storageError} onClick={() => {
          update((state) => selectSharedBookings(state, [booking.id]));
          setOpen(false);
        }}>Teilen</Button>
      </PremiumDialogFooter>
    </PremiumDialogContent>
  </PremiumDialog>;
}

export function SharedCosts({ bookings, items, iconOnly = false }: { bookings: AccountedTransaction[]; items: HolidayReceivable[]; iconOnly?: boolean }) {
  const { update, storageError } = useFinance();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("search");
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState("");
  const [amount, setAmount] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [paid, setPaid] = useState<string[]>([]);
  const [settlements, setSettlements] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(50);
  const count = items.filter((item) => item.status === "Offen").length;
  const openItems = items.filter((item) => item.status === "Offen" && !paid.includes(item.bookingId));
  const pending = selected.length > 0 || paid.length > 0 || Object.keys(settlements).length > 0;
  const incoming = open ? bookings.filter((row) => row.amount > 0 &&
    (row.holidayRefundFor || row.holidayRefundPending || row.sharedRefundFor || row.sharedRefundUnlinked ||
      row.sharedRepaymentFor || isRaphaelPayment(row) ||
      (!classify(row).isTransfer && !["Gehalt", "Rufbereitschaft"].includes(classify(row).category) &&
        items.some((item) => !item.bookingId.startsWith("planned:") && item.date <= row.date && item.fullAmount >= row.amount)))) : [];
  const overpaidItems = items.filter((item) => item.overpaid > 0);
  // Classify once per opened booking list; searching reuses the stored merchant name.
  const { candidates, merchants, classes } = useMemo(() => {
    const rows: AccountedTransaction[] = [];
    const names = new Map<string, string>();
    const results = new Map<string, ReturnType<typeof classify>>();
    if (open) for (const row of bookings) {
      if (row.amount >= 0 || isSharedHoliday(row)) continue;
      const result = classify(row);
      if (result.isTransfer) continue;
      rows.push(row);
      names.set(row.id, result.merchant);
      results.set(row.id, result);
    }
    return { candidates: rows, merchants: names, classes: results };
  }, [bookings, open]);
  const filtered = useMemo(() => {
    const total = Math.abs(parseStatementAmount(amount) ?? NaN);
    return candidates.filter((row) => matchesTransactionSearch(row, query, merchants.get(row.id) ?? "") &&
      (!month || row.date.startsWith(month)) && (!amount || Math.abs(row.amount) === total))
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  }, [candidates, merchants, query, month, amount]);
  const invalidAmount = !!amount && parseStatementAmount(amount) === null;
  const chosen = candidates.filter((row) => selected.includes(row.id));
  const chosenTotal = round(chosen.reduce((total, row) => total + Math.abs(row.amount), 0));
  const chosenOwn = round(chosen.reduce((total, row) => total + Math.abs(personalAmount({ ...row, sharedWithRaphael: true })), 0));
  const changeOpen = (value: boolean) => { setOpen(value); setTab("search"); setSelected([]); setPaid([]); setSettlements({}); setLimit(50); };
  return <>
    <PremiumDialog open={open} onOpenChange={changeOpen}>
    <Tooltip label="Geteilte Buchungen und offene Beträge">
    <PremiumDialogTrigger asChild>
    <Button size={iconOnly ? "icon" : "sm"} variant="outline" className={iconOnly ? "relative size-11" : undefined} disabled={!!storageError} aria-label="Geteilt" title="Geteilt">
      <Users className="size-3.5" />{!iconOnly && "Geteilt"}
      {count > 0 && <FinancialData as="span" aria-label={`${count} offene Teilungen`} data-count={count} className={`after:content-[attr(data-count)] inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-2xs font-semibold text-primary-foreground${iconOnly ? " absolute -top-2 -right-2" : ""}`} />}
    </Button>
    </PremiumDialogTrigger>
    </Tooltip>
      <PremiumDialogContent size="xl" variant="work" snapPoints={[0.92]} showCloseButton={false}>
        <Tabs.Root value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PremiumDialogHeader icon={Users} title="Geteilt" description="Meine Hälfte 50 % · Raphael 50 %">
          <Button size="icon" variant="ghost" className="absolute top-3 right-3 size-11 rounded-full text-muted-foreground hover:text-foreground sm:top-4 sm:right-4" aria-label="Geteilt schließen" onClick={() => changeOpen(false)}><X className="size-4" /></Button>
        <Tabs.List aria-label="Geteilt-Ansicht" className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
          <Tabs.Trigger value="search" className={tabClass}>Suchen</Tabs.Trigger>
          <Tabs.Trigger value="open" className={tabClass}>Offen · {openItems.length}</Tabs.Trigger>
          <Tabs.Trigger value="refunds" className={cn(tabClass, "px-2")}>Erstattungen{incoming.some((row) => row.holidayRefundPending) ? " · Prüfen" : ""}</Tabs.Trigger>
        </Tabs.List>
        </PremiumDialogHeader>
        <PremiumDialogBody aria-label="Buchungslisten">
        <Tabs.Content value="search" className="space-y-4">
        <div className="space-y-3">
          <div className="relative">
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input aria-label="Geteilte Buchungen suchen" className="h-11 pl-9" placeholder="Händler oder Text suchen …" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(50); }} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Monat">
              <Input aria-label="Geteilt Monat" type="month" className="h-11" value={month} onChange={(e) => { setMonth(e.target.value); setLimit(50); }} />
            </Field>
            <Field label="Gesamtbetrag (€)" error={invalidAmount ? "Bitte einen gültigen Gesamtbetrag eingeben, z. B. 100,00." : null}>
              <Input aria-label="Geteilt Gesamtbetrag" inputMode="decimal" className="h-11" placeholder="z. B. 100,00" value={amount} onChange={(e) => { setAmount(e.target.value); setLimit(50); }} />
            </Field>
          </div>
        </div>
        <div role="group" aria-label="Buchungen zum Teilen" className="overflow-hidden rounded-2xl border border-border/70 bg-card">
          {filtered.slice(0, limit).map((row) => {
            const on = selected.includes(row.id);
            return <label key={row.id} className={cn("flex min-h-14 cursor-pointer items-center gap-3 border-b border-border/60 px-3 py-2.5 text-sm transition-colors duration-150 last:border-b-0 hover:bg-muted/40 motion-reduce:transition-none", on && "bg-accent-muted/60 hover:bg-accent-muted/80")}>
              <DrawnCheckbox checked={on} disabled={false} label={`Teilen: ${row.description} ${row.date}`}
                onChange={(checked) => setSelected((ids) => checked ? [...ids, row.id] : ids.filter((id) => id !== row.id))} />
              <MerchantMark booking={row} classification={classes.get(row.id)!} fallbackName={bookingDescription(row)} className="size-9 rounded-xl" />
              <span className="min-w-0 flex-1"><span className="block truncate font-medium" title={bookingDescription(row)}>{bookingDescription(row)}</span><span className="block text-xs text-muted-foreground">{dateLabel(row.date)} · {row.bank}</span></span>
              <span className="shrink-0 text-right">
                <span className="block text-sm font-medium tabular-nums">{currency(Math.abs(row.amount))}</span>
                {on ? <span className="block text-2xs font-medium text-primary">Meine Hälfte (50 %) {currency(Math.abs(personalAmount({ ...row, sharedWithRaphael: true })))}</span>
                  : <span className="block text-2xs text-muted-foreground">Gesamt</span>}
              </span>
            </label>;
          })}
          {!filtered.length && <p className="p-4 text-center text-xs text-muted-foreground">Keine Buchungen gefunden.</p>}
          {filtered.length > limit && <div className="border-t border-border/60 p-2 text-center"><Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + 50)}>Mehr anzeigen</Button></div>}
        </div>
        {chosen.length > 0
          ? <SplitPreview className="sticky bottom-0 border border-primary/20 bg-card/95 shadow-raised backdrop-blur-md"
              label={`${chosen.length} ${chosen.length === 1 ? "Buchung" : "Buchungen"} · Gesamt`} total={chosenTotal} own={chosenOwn} />
          : <p className="text-center text-xs text-muted-foreground">Buchungen antippen – die Aufteilung erscheint hier. Übernommen wird erst mit „Speichern“.</p>}
        </Tabs.Content>
        <Tabs.Content value="open" className="space-y-4">
          <div className="flex items-end justify-between gap-3 px-1">
            <div>
              <h3 className="text-sm font-semibold">Offen · Raphael Piber</h3>
              <p className="text-xs text-muted-foreground">Bezahlmarkierungen erst mit „Speichern“ übernehmen.</p>
            </div>
            {openItems.length > 0 && <FinancialData as="p" className="shrink-0 text-right">
              <span className="block text-2xs text-muted-foreground">Offen gesamt</span>
              <span className="amount text-base text-primary">{currency(round(openItems.reduce((total, item) => total + item.outstanding, 0)))}</span>
            </FinancialData>}
          </div>
          <ShareRows items={openItems} disabled={!!storageError} onPaid={(id) => setPaid((ids) => [...ids, id])} />
          {!openItems.length && <p className="rounded-2xl border border-dashed border-border bg-surface-sunken/60 p-6 text-center text-xs text-muted-foreground">Keine offenen Teilungen.</p>}
          {overpaidItems.length > 0 && <section className="space-y-2 rounded-2xl bg-warning-soft p-4">
            <h3 className="text-sm font-semibold">An Raphael zurückzuzahlen</h3>
            <p className="text-xs text-muted-foreground">Partnerzahlungen bleiben erhalten, auch wenn der Händler den Kauf erstattet. Keine automatische Verrechnung mit anderen Käufen.</p>
            {overpaidItems.map((item) => <p key={item.bookingId} className="text-sm">{item.description} · {currency(item.overpaid)}</p>)}
          </section>}
        </Tabs.Content>
        <Tabs.Content value="refunds" className="space-y-3">
          <p className="text-xs text-muted-foreground">Eindeutige Händlererstattungen werden anteilig zurückgenommen. Bei mehreren möglichen Käufen ist Ihre Zuordnung erforderlich. Partnerzahlungen sind keine Händlererstattungen.</p>
          {incoming.map((row) => <div key={row.id} className="space-y-2 rounded-2xl border border-border/70 p-4 text-sm">
            <p className="font-medium">{bookingDescription(row)} · {currency(row.amount)}</p>
            {row.holidayRefundPending && <p role="alert" className="text-xs text-destructive">Ursprung nicht eindeutig. Bis zur Entscheidung bleibt die ursprüngliche Buchungsrechnung bestehen.</p>}
            {row.holidayRefundFor && <p className="text-xs text-muted-foreground">Eigene Erstattung {currency(personalAmount(row))} · Partneranteil wird ebenfalls reduziert.</p>}
            <label className="block text-xs">Ursprung und Zahlungsart
              <select className="select-input mt-1 block w-full" aria-label={`Zuordnung: ${row.description} ${row.date}`}
                value={settlements[row.id] ?? (row.sharedRepaymentFor ? `repayment:${row.sharedRepaymentFor}` : row.sharedRefundUnlinked ? "unlinked" : row.sharedRefundFor || row.holidayRefundFor ? `refund:${row.sharedRefundFor ?? row.holidayRefundFor}` : "")}
                onChange={(event) => setSettlements((values) => ({ ...values, [row.id]: event.target.value }))}>
                <option value="">Bitte ausdrücklich auswählen</option>
                <option value="unlinked">Keine geteilte Erstattung oder Partnerzahlung</option>
                {items.filter((item) => !item.bookingId.startsWith("planned:") && item.date <= row.date && item.fullAmount >= row.amount).map((item) =>
                  <option key={`refund:${item.bookingId}`} value={`refund:${item.bookingId}`}>Händlererstattung: {item.description} · {dateLabel(item.date)} · {currency(item.fullAmount)}</option>)}
                {isRaphaelPayment(row) && items.map((item) =>
                  <option key={`repayment:${item.bookingId}`} value={`repayment:${item.bookingId}`}>Partnerzahlung: {item.description} · {dateLabel(item.date)}</option>)}
              </select>
            </label>
          </div>)}
          {!incoming.length && <p className="text-xs text-muted-foreground">Keine geteilten Erstattungen oder Partnerzahlungen.</p>}
        </Tabs.Content>
        {storageError && <p role="alert" className="mt-4 text-sm font-medium text-destructive">{storageError}</p>}
        </PremiumDialogBody>
        <PremiumDialogFooter>
          {tab === "search" || pending ? <>
          <span role="status" className="text-xs text-muted-foreground sm:mr-auto">{selected.length} ausgewählt{paid.length > 0 && ` · ${paid.length} bezahlt (ungespeichert)`}</span>
          <Button variant="outline" onClick={() => changeOpen(false)}>Abbrechen</Button>
          <Button disabled={!pending || !!storageError} onClick={() => {
            const ids = selected.filter((id) => candidates.some((row) => row.id === id));
            const paidIds = paid.filter((id) => items.some((item) => item.bookingId === id && item.status === "Offen"));
            update((state) => Object.entries(settlements).reduce((next, [id, decision]) => {
              if (!decision) return next;
              if (decision === "unlinked") return decideSharedSettlement(next, id, null);
              const separator = decision.indexOf(":");
              return decideSharedSettlement(next, id, decision.slice(separator + 1), decision.startsWith("repayment:") ? "repayment" : "refund");
            }, selectSharedBookings(selectSharedBookings(state, ids), paidIds, true)));
            changeOpen(false);
          }}>Speichern</Button>
          </> : <Button variant="outline" onClick={() => changeOpen(false)}>Schließen</Button>}
        </PremiumDialogFooter>
        </Tabs.Root>
      </PremiumDialogContent>
    </PremiumDialog>
  </>;
}
