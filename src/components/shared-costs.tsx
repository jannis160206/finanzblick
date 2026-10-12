"use client";

import { useMemo, useState } from "react";
import { Users, X } from "lucide-react";
import { Tabs } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useFinance } from "@/components/finance-provider";
import { FinancialData } from "@/components/financial-data";
import { classify } from "@/lib/calc";
import { currency, dateLabel } from "@/lib/format";
import { parseStatementAmount } from "@/lib/import/statements";
import { bookingDescription } from "@/lib/import/merchant-description";
import { isSharedHoliday, personalAmount, selectSharedBookings, type AccountedTransaction, type HolidayReceivable } from "@/lib/shared-holiday";
import { matchesTransactionSearch } from "@/lib/transaction-tools";

function ShareRows({ items, onPaid, disabled }: { items: HolidayReceivable[]; onPaid: (id: string) => void; disabled: boolean }) {
  return <ul className="divide-y">
    {items.map((item) => <li key={item.bookingId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
      <div className="min-w-0 w-full">
        <p className="truncate font-medium" title={bookingDescription(item)}>{bookingDescription(item)}</p>
        <p className="text-muted-foreground">{dateLabel(item.date)} · Gesamt {currency(item.fullAmount)} · Meine Hälfte {currency(item.ownSpend)}</p>
      </div>
      <span className="text-primary">Offen</span>
      <Button size="sm" variant="ghost" disabled={disabled}
        aria-label={`Als bezahlt markieren: ${item.description}`}
        onClick={() => onPaid(item.bookingId)}>Als bezahlt markieren</Button>
    </li>)}
  </ul>;
}

export function SharedRowAction({ booking }: { booking: AccountedTransaction }) {
  const { update, storageError } = useFinance();
  const [open, setOpen] = useState(false);
  if (booking.amount >= 0 || classify(booking).isTransfer) return null;
  const shared = isSharedHoliday(booking);
  return <Dialog open={open} onOpenChange={setOpen}>
    <FinancialData as="span" className="inline-flex">
    <Tooltip label={shared ? "Bereits mit Raphael geteilt" : "Mit Raphael teilen"}>
    <DialogTrigger asChild>
      <Button size="icon" variant="ghost" className="size-9" disabled={shared || !!storageError}
        aria-label={`${shared ? "Bereits geteilt" : "Teilen"}: ${booking.description}`}
        title={shared ? "Bereits geteilt" : "Mit Raphael teilen"}>
        <Users className="size-3.5" />
      </Button>
    </DialogTrigger>
    </Tooltip>
    </FinancialData>
    <DialogContent variant="confirmation">
      <DialogHeader>
        <DialogTitle>Diese Buchung als geteilt markieren?</DialogTitle>
        <DialogDescription>Es zählt nur noch die Hälfte.</DialogDescription>
      </DialogHeader>
      <DialogBody className="min-w-0 space-y-2 text-sm">
        <p className="truncate font-medium" title={bookingDescription(booking)}>{bookingDescription(booking)}</p>
        <p className="text-muted-foreground">{dateLabel(booking.date)} · Gesamt {currency(Math.abs(booking.amount))}</p>
        <p>Meine Hälfte: {currency(Math.abs(personalAmount({ ...booking, sharedWithRaphael: true })))}</p>
        {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={() => setOpen(false)}>Abbrechen</Button>
        <Button disabled={!!storageError} onClick={() => {
          update((state) => selectSharedBookings(state, [booking.id]));
          setOpen(false);
        }}>Teilen</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
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
  const [limit, setLimit] = useState(50);
  const count = items.filter((item) => item.status === "Offen").length;
  const openItems = items.filter((item) => item.status === "Offen" && !paid.includes(item.bookingId));
  const pending = selected.length > 0 || paid.length > 0;
  const candidates = useMemo(() => open
    ? bookings.filter((row) => row.amount < 0 && !isSharedHoliday(row) && !classify(row).isTransfer)
    : [], [bookings, open]);
  const filtered = useMemo(() => {
    const total = Math.abs(parseStatementAmount(amount) ?? NaN);
    return candidates.filter((row) => matchesTransactionSearch(row, query) &&
      (!month || row.date.startsWith(month)) && (!amount || Math.abs(row.amount) === total))
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  }, [candidates, query, month, amount]);
  const invalidAmount = !!amount && parseStatementAmount(amount) === null;
  const changeOpen = (value: boolean) => { setOpen(value); setTab("search"); setSelected([]); setPaid([]); setLimit(50); };
  return <>
    <Dialog open={open} onOpenChange={changeOpen}>
    <Tooltip label="Geteilte Buchungen und offene Beträge">
    <DialogTrigger asChild>
    <Button size={iconOnly ? "icon" : "sm"} variant="outline" className={iconOnly ? "relative size-11" : undefined} disabled={!!storageError} aria-label="Geteilt" title="Geteilt">
      <Users className="size-3.5" />{!iconOnly && "Geteilt"}
      {count > 0 && <FinancialData as="span" aria-label={`${count} offene Teilungen`} className={`inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground${iconOnly ? " absolute -top-2 -right-2" : ""}`}>{count}</FinancialData>}
    </Button>
    </DialogTrigger>
    </Tooltip>
      <DialogContent variant="work" showCloseButton={false}>
        <Tabs.Root value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Geteilt</DialogTitle>
          <DialogDescription>Meine Hälfte 50 % · Raphael 50 %</DialogDescription>
          <Button size="icon" variant="ghost" className="absolute top-3 right-3 size-11 rounded-full text-muted-foreground hover:text-foreground sm:top-4 sm:right-4" aria-label="Geteilt schließen" onClick={() => changeOpen(false)}><X className="size-4" /></Button>
        <Tabs.List aria-label="Geteilt-Ansicht" className="mt-3 grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
          <Tabs.Trigger value="search" className="min-h-10 rounded px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:shadow-sm">Suchen</Tabs.Trigger>
          <Tabs.Trigger value="open" className="min-h-10 rounded px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=active]:bg-background data-[state=active]:shadow-sm">Offen · {openItems.length}</Tabs.Trigger>
        </Tabs.List>
        </DialogHeader>
        <DialogBody aria-label="Buchungslisten">
        <Tabs.Content value="search" className="space-y-5">
        <div className="grid gap-4 bg-card pb-4 sm:grid-cols-2 md:[@media(min-height:600px)]:sticky md:[@media(min-height:600px)]:top-0 md:[@media(min-height:600px)]:z-10">
          <label className="block text-sm font-medium sm:col-span-2">Händler / Text
            <Input className="mt-2" aria-label="Geteilte Buchungen suchen" placeholder="Buchungen durchsuchen" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(50); }} />
          </label>
          <label className="block text-sm font-medium">Monat
            <Input className="mt-2" aria-label="Geteilt Monat" type="month" value={month} onChange={(e) => { setMonth(e.target.value); setLimit(50); }} />
          </label>
          <label className="block text-sm font-medium">Gesamtbetrag (€)
            <Input className="mt-2" aria-label="Geteilt Gesamtbetrag" inputMode="decimal" placeholder="z. B. 100,00" value={amount} aria-invalid={invalidAmount} aria-describedby={invalidAmount ? "shared-amount-error" : undefined} onChange={(e) => { setAmount(e.target.value); setLimit(50); }} />
          </label>
        </div>
        {invalidAmount && <p id="shared-amount-error" role="alert" className="text-sm text-destructive">Bitte einen gültigen Gesamtbetrag eingeben, z. B. 100,00.</p>}
        <p className="text-xs text-muted-foreground">Auswahl erst mit „Speichern“ übernehmen.</p>
        <div className="rounded-md border">
          {filtered.slice(0, limit).map((row) => <label key={row.id} className="flex cursor-pointer items-center gap-3 border-b p-3 text-sm last:border-b-0">
            <input type="checkbox" className="accent-primary" aria-label={`Teilen: ${row.description} ${row.date}`}
              checked={selected.includes(row.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, row.id] : ids.filter((id) => id !== row.id))} />
            <span className="min-w-0 flex-1"><span className="block truncate font-medium" title={bookingDescription(row)}>{bookingDescription(row)}</span><span className="text-muted-foreground">{dateLabel(row.date)} · {row.bank}</span></span>
            <span className="shrink-0 text-right">
              <span className="block text-[10px] text-muted-foreground">Gesamt {currency(Math.abs(row.amount))}</span>
              {selected.includes(row.id) && <span className="block font-mono text-primary">Meine Hälfte (50 %)<br />{currency(Math.abs(personalAmount({ ...row, sharedWithRaphael: true })))}</span>}
            </span>
          </label>)}
          {!filtered.length && <p className="p-3 text-xs text-muted-foreground">Keine Buchungen gefunden.</p>}
          {filtered.length > limit && <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + 50)}>Mehr anzeigen</Button>}
        </div>
        </Tabs.Content>
        <Tabs.Content value="open" className="space-y-3">
          <h3 className="text-sm font-medium">Offen · Raphael Piber</h3>
          <p className="text-xs text-muted-foreground">Bezahlmarkierungen erst mit „Speichern“ übernehmen.</p>
          <ShareRows items={openItems} disabled={!!storageError} onPaid={(id) => setPaid((ids) => [...ids, id])} />
          {!openItems.length && <p className="mt-2 text-xs text-muted-foreground">Keine offenen Teilungen.</p>}
        </Tabs.Content>
        {storageError && <p role="alert" className="mt-4 text-sm text-destructive">{storageError}</p>}
        </DialogBody>
        <DialogFooter>
          {tab === "search" || pending ? <>
          <span role="status" className="mr-auto text-xs text-muted-foreground">{selected.length} ausgewählt{paid.length > 0 && ` · ${paid.length} bezahlt (ungespeichert)`}</span>
          <Button variant="outline" onClick={() => changeOpen(false)}>Abbrechen</Button>
          <Button disabled={!pending || !!storageError} onClick={() => {
            const ids = selected.filter((id) => candidates.some((row) => row.id === id));
            const paidIds = paid.filter((id) => items.some((item) => item.bookingId === id && item.status === "Offen"));
            update((state) => selectSharedBookings(selectSharedBookings(state, ids), paidIds, true));
            changeOpen(false);
          }}>Speichern</Button>
          </> : <Button variant="outline" onClick={() => changeOpen(false)}>Schließen</Button>}
        </DialogFooter>
        </Tabs.Root>
      </DialogContent>
    </Dialog>
  </>;
}
