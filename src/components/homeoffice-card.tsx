"use client";

import { useMemo, useState } from "react";
import { Calculator, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  articleType, articleTypes, calculateHomeOffice, estimateIncome, guessArticle, homeOfficeCandidates, homeOfficeResultCard, yearExpenses,
  type ArticleTypeId, type HomeOfficeItem,
} from "@/lib/assistant/homeoffice";
import { currency, dateLabel } from "@/lib/format";
import { matchesTransactionSearch } from "@/lib/transaction-tools";
import type { AppState, AssistantCard, Transaction } from "@/lib/types";

const money = (value: string) => {
  const parsed = Number(value.trim().replace(/\s|€/g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};
const label = (row: Transaction) => (row.merchantAlias || row.description).slice(0, 120);
const rates = [0, 20, 30, 40, 48, 50];
const currentYear = () => new Date().getFullYear();

// Step 1: pick the purchases, step 2: say what each one was, step 3: days and income; then the code calculates the refund.
export function HomeOfficeCard({ card, state, disabled, onResult }: {
  card: AssistantCard; state: AppState; disabled: boolean; onResult: (result: { text: string; card: AssistantCard }) => void;
}) {
  const year = card.year ?? currentYear();
  const candidates = useMemo(() => homeOfficeCandidates(state, year), [state, year]);
  const expenses = useMemo(() => yearExpenses(state, year), [state, year]);
  const byId = useMemo(() => new Map(expenses.map((row) => [row.id, row])), [expenses]);
  const estimate = useMemo(() => estimateIncome(state, year), [state, year]);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Record<string, { type: ArticleTypeId; business: number; note: string }>>({});
  const [days, setDays] = useState("100");
  const [employer, setEmployer] = useState("0");
  const [other, setOther] = useState("0");
  const [income, setIncome] = useState(estimate ? String(estimate.income).replace(".", ",") : "");
  const [rate, setRate] = useState(30);
  const [error, setError] = useState("");

  const found = query.trim().length >= 2 ? expenses.filter((row) => matchesTransactionSearch(row, query)).slice(0, 30) : [];
  const shown = [...new Map([...candidates, ...found, ...Object.keys(picked).flatMap((id) => byId.get(id) ?? [])].map((row) => [row.id, row])).values()];
  const selected = Object.keys(picked).flatMap((id) => byId.get(id) ?? []);
  const toggle = (row: Transaction) => setPicked((current) => {
    if (current[row.id]) {
      const next = { ...current };
      delete next[row.id];
      return next;
    }
    const type = guessArticle(row);
    return { ...current, [row.id]: { type, business: articleType(type).business, note: "" } };
  });
  const patch = (id: string, value: Partial<{ type: ArticleTypeId; business: number; note: string }>) =>
    setPicked((current) => ({ ...current, [id]: { ...current[id], ...value } }));

  const calculate = () => {
    const dayCount = money(days);
    const paid = money(employer);
    const otherCosts = money(other);
    const yearly = income.trim() ? money(income) : undefined;
    if (!selected.length) return setError("Bitte wähl mindestens eine Buchung aus.");
    if (dayCount === undefined || dayCount > 366 || paid === undefined || otherCosts === undefined || (income.trim() && yearly === undefined))
      return setError("Bitte die Angaben prüfen: nur Zahlen, Homeoffice-Tage höchstens 366.");
    setError("");
    const items: HomeOfficeItem[] = selected.map((row) => ({
      id: row.id, date: row.date, price: Math.abs(row.amount), type: picked[row.id].type, business: picked[row.id].business,
      label: (picked[row.id].note.trim() || label(row)).slice(0, 120),
    }));
    const input = { year, items, days: dayCount, employerPaid: paid, otherCosts, ...(yearly ? { income: yearly } : { rate: rate / 100 }) };
    onResult(homeOfficeResultCard(input, calculateHomeOffice(input)));
  };

  return <article className="space-y-4 rounded-2xl border border-primary/40 bg-background/40 p-4" aria-label={card.title}>
    <div>
      <p className="text-2xs uppercase tracking-wide text-muted-foreground">Arbeitnehmerveranlagung</p>
      <h3 className="text-sm font-semibold">{card.title}</h3>
    </div>
    <section aria-label="Buchungen auswählen" className="space-y-2">
      <p className="text-xs font-medium">1. Welche Käufe waren für dein Home-Office?</p>
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input aria-label={`Ausgaben aus ${year} durchsuchen`} placeholder={`Alle Ausgaben aus ${year} durchsuchen, z. B. „Amazon“`} value={query}
          onChange={(event) => setQuery(event.target.value)} className="pl-8" />
      </div>
      {shown.length ? <ul className="max-h-72 divide-y divide-border/50 overflow-y-auto rounded-xl border border-border/60 bg-background/60 text-xs">
        {shown.map((row) => <li key={row.id}>
          <label className="flex cursor-pointer items-center gap-3 px-3 py-2">
            <input type="checkbox" className="size-4 shrink-0" checked={!!picked[row.id]} onChange={() => toggle(row)} aria-label={`${label(row)} ${dateLabel(row.date)} auswählen`} />
            <span className="min-w-0 flex-1"><span className="block truncate">{label(row)}</span><span className="text-muted-foreground">{dateLabel(row.date)}{row.bank ? ` · ${row.bank}` : ""}</span></span>
            <span className="shrink-0 tabular-nums">{currency(row.amount)}</span>
          </label>
        </li>)}
      </ul> : <p className="text-xs text-muted-foreground">Keine passenden Buchungen. Such oben nach dem Händler.</p>}
    </section>
    {selected.length > 0 && <section aria-label="Artikel angeben" className="space-y-2">
      <p className="text-xs font-medium">2. Was war das jeweils?</p>
      <ul className="space-y-2">
        {selected.map((row) => {
          const item = picked[row.id];
          const type = articleType(item.type);
          return <li key={row.id} className="grid gap-2 rounded-xl border border-border/60 bg-background/60 p-3 text-xs sm:grid-cols-[1fr_1fr_6rem]">
            <div className="sm:col-span-3 flex justify-between gap-3"><span className="truncate font-medium">{label(row)} · {dateLabel(row.date)}</span><span className="tabular-nums">{currency(Math.abs(row.amount))}</span></div>
            <select className="select-input w-full" aria-label={`Artikel: ${label(row)}`} value={item.type}
              onChange={(event) => { const next = event.target.value as ArticleTypeId; patch(row.id, { type: next, business: articleType(next).business }); }}>
              {articleTypes.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
            <Input aria-label={`Bezeichnung: ${label(row)}`} placeholder="Was genau? z. B. „Dell 27-Zoll-Monitor“" value={item.note} maxLength={120}
              onChange={(event) => patch(row.id, { note: event.target.value })} />
            <Input aria-label={`Beruflicher Anteil in Prozent: ${label(row)}`} inputMode="numeric" value={String(item.business)} disabled={type.group !== "work"}
              onChange={(event) => { const value = Number(event.target.value.replace(/\D/g, "")); patch(row.id, { business: Math.min(100, Number.isFinite(value) ? value : 0) }); }} />
            <p className="sm:col-span-3 text-muted-foreground">{type.hint}{type.group === "work" ? ` · beruflich ${item.business} %` : ""}</p>
          </li>;
        })}
      </ul>
    </section>}
    {selected.length > 0 && <section aria-label="Angaben zum Jahr" className="space-y-2">
      <p className="text-xs font-medium">3. Angaben für {year}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="ho-days" label="Homeoffice-Tage im Jahr" value={days} onChange={setDays} />
        <Field id="ho-employer" label="Telearbeitspauschale vom Arbeitgeber (€)" value={employer} onChange={setEmployer} />
        <Field id="ho-income" label={estimate ? `Steuerpflichtiges Jahreseinkommen (€, geschätzt aus ${estimate.months} Lohnzetteln ${estimate.year})` : "Steuerpflichtiges Jahreseinkommen (€)"}
          value={income} onChange={setIncome} />
        {!income.trim() && <div className="space-y-1.5">
          <Label htmlFor="ho-rate" className="text-xs">Ohne Einkommen: Grenzsteuersatz</Label>
          <select id="ho-rate" className="select-input w-full" value={rate} onChange={(event) => setRate(Number(event.target.value))}>
            {rates.map((value) => <option key={value} value={value}>{value} %</option>)}
          </select>
        </div>}
        <Field id="ho-other" label="Weitere Werbungskosten im Jahr (€, optional)" value={other} onChange={setOther} />
      </div>
    </section>}
    {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <Button type="button" size="sm" className="min-h-10" disabled={disabled || !selected.length} onClick={calculate}>
        <Calculator aria-hidden="true" className="size-4" />Erstattung berechnen{selected.length ? ` (${selected.length})` : ""}
      </Button>
      <span className="text-xs text-muted-foreground">Nichts wird an deinen Buchungen geändert.</span>
    </div>
    {card.note && <p className="text-xs text-muted-foreground">{card.note}</p>}
  </article>;
}

function Field({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return <div className="space-y-1.5">
    <Label htmlFor={id} className="text-xs">{label}</Label>
    <Input id={id} inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} />
  </div>;
}
