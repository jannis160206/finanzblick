"use client";

import { useState } from "react";
import { Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useFinance } from "@/components/finance-provider";
import { classify } from "@/lib/calc";
import { currency, dateLabel } from "@/lib/format";
import { parseStatementAmount } from "@/lib/import/statements";
import { isSharedHoliday, selectSharedBookings, type AccountedTransaction, type HolidayReceivable } from "@/lib/shared-holiday";

function ShareRows({ items, onPaid }: { items: HolidayReceivable[]; onPaid?: (id: string) => void }) {
  const { update, storageError } = useFinance();
  return <ul className="divide-y">
    {items.map((item) => <li key={item.bookingId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium" title={item.description}>{item.description}</p>
        <p className="text-muted-foreground">{dateLabel(item.date)} · Gesamt {currency(item.fullAmount)} · Meine Hälfte {currency(item.ownSpend)}</p>
      </div>
      <span className={item.status === "Offen" ? "text-primary" : "text-muted-foreground"}>{item.status}</span>
      {item.status === "Offen" && <Button size="sm" variant="ghost" disabled={!!storageError}
        aria-label={`Als bezahlt markieren: ${item.description}`}
        onClick={() => onPaid ? onPaid(item.bookingId) : update((state) => selectSharedBookings(state, [item.bookingId], true))}>Als bezahlt markieren</Button>}
    </li>)}
  </ul>;
}

export function SharedOpenList({ items }: { items: HolidayReceivable[] }) {
  const open = items.filter((item) => item.status === "Offen");
  if (!open.length) return null;
  return <div className="border-b px-4 py-2" aria-label="Offene geteilte Kosten">
    <p className="text-xs font-medium">Offen · Raphael Piber</p>
    <ShareRows items={open.slice(0, 3)} />
    {open.length > 3 && <p className="text-xs text-muted-foreground">Weitere {open.length - 3} unter Geteilt</p>}
  </div>;
}

export function SharedCosts({ bookings, items }: { bookings: AccountedTransaction[]; items: HolidayReceivable[] }) {
  const { update, storageError } = useFinance();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState("");
  const [amount, setAmount] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [paid, setPaid] = useState<string[]>([]);
  const [limit, setLimit] = useState(50);
  const count = items.filter((item) => item.status === "Offen").length;
  const candidates = bookings.filter((row) => row.amount < 0 && !classify(row).isTransfer && !isSharedHoliday(row));
  const filtered = candidates.filter((row) => (!query || row.description.toLocaleLowerCase("de").includes(query.toLocaleLowerCase("de"))) &&
    (!month || row.date.startsWith(month)) && (!amount || Math.abs(row.amount) === Math.abs(parseStatementAmount(amount) ?? NaN)))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const changeOpen = (value: boolean) => { setOpen(value); setSelected([]); setPaid([]); setLimit(50); };
  return <>
    <Button size="sm" variant="outline" disabled={!!storageError} onClick={() => changeOpen(true)} aria-label="Geteilt">
      <Users className="size-3.5" />Geteilt
      {count > 0 && <span aria-label={`${count} offene Teilungen`} className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">{count}</span>}
    </Button>
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent showCloseButton={false} className="sm:max-w-2xl"
        style={{ display: "flex", flexDirection: "column", maxHeight: "80dvh", gap: 0, overflow: "hidden", padding: 0 }}>
        <div className="sticky top-0 z-10 shrink-0 border-b bg-background p-4">
        <DialogHeader className="relative pr-10">
          <DialogTitle>Geteilt mit Raphael Piber</DialogTitle>
          <DialogDescription>Meine Hälfte 50 % · Raphael 50 %</DialogDescription>
          <Button size="icon" variant="ghost" className="absolute top-0 right-0 size-8" aria-label="Geteilt schließen" onClick={() => changeOpen(false)}><X className="size-4" /></Button>
        </DialogHeader>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <Input aria-label="Geteilte Buchungen suchen" placeholder="Händler / Text" value={query} onChange={(e) => { setQuery(e.target.value); setLimit(50); }} />
          <Input aria-label="Geteilt Monat" type="month" value={month} onChange={(e) => { setMonth(e.target.value); setLimit(50); }} />
          <Input aria-label="Geteilt Gesamtbetrag" inputMode="decimal" placeholder="Gesamtbetrag (€)" value={amount} onChange={(e) => { setAmount(e.target.value); setLimit(50); }} />
        </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4" aria-label="Buchungslisten">
        <div className="rounded-md border">
          {filtered.slice(0, limit).map((row) => <label key={row.id} className="flex cursor-pointer items-center gap-3 border-b p-3 text-xs last:border-b-0">
            <input type="checkbox" className="accent-primary" aria-label={`Teilen: ${row.description} ${row.date}`}
              checked={selected.includes(row.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, row.id] : ids.filter((id) => id !== row.id))} />
            <span className="min-w-0 flex-1"><span className="block truncate font-medium">{row.description}</span><span className="text-muted-foreground">{dateLabel(row.date)} · {row.bank}</span></span>
            <span className="font-mono">{currency(Math.abs(row.amount))}</span>
          </label>)}
          {!filtered.length && <p className="p-3 text-xs text-muted-foreground">Keine Buchungen gefunden.</p>}
          {filtered.length > limit && <Button variant="ghost" size="sm" onClick={() => setLimit((n) => n + 50)}>Mehr anzeigen</Button>}
        </div>
        <section className="mt-4" aria-label="Geteilte Buchungen">
          <h3 className="text-sm font-medium">Geteilte Buchungen · {items.length}</h3>
          <ShareRows items={items.map((item) => paid.includes(item.bookingId) ? { ...item, status: "Bezahlt" } : item)} onPaid={(id) => setPaid((ids) => [...ids, id])} />
          {!items.length && <p className="mt-2 text-xs text-muted-foreground">Noch keine Buchungen geteilt.</p>}
        </section>
        </div>
        <DialogFooter className="sticky bottom-0 z-10 shrink-0 border-t bg-background p-4">
          <span className="mr-auto self-center text-xs text-muted-foreground">{selected.length} ausgewählt</span>
          <Button variant="outline" onClick={() => changeOpen(false)}>Abbrechen</Button>
          <Button disabled={(!selected.length && !paid.length) || !!storageError} onClick={() => {
            const ids = selected.filter((id) => candidates.some((row) => row.id === id));
            const paidIds = paid.filter((id) => items.some((item) => item.bookingId === id && item.status === "Offen"));
            update((state) => selectSharedBookings(selectSharedBookings(state, ids), paidIds, true));
            changeOpen(false);
          }}>Speichern</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
