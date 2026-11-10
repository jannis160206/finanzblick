"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Link2, Loader2, Search } from "lucide-react";
import { BankLogo } from "@/components/bank-logo";
import { useKnownBanks } from "@/components/settings-summaries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DialogEmpty, DialogSkeleton, Field, PremiumDialog, PremiumDialogBody, PremiumDialogContent, PremiumDialogFooter, PremiumDialogHeader,
} from "@/components/ui/premium-dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { canonicalBank } from "@/lib/banks/registry";
import type { BankChoice } from "@/lib/banking/sync";

export type BankCountry = "AT" | "DE";
const countries = [{ value: "AT", label: "Österreich" }, { value: "DE", label: "Deutschland" }] as const;
const LIMIT = 60;
const fold = (text: string) => text.toLocaleLowerCase("de-AT").normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

/** "Bank hinzufügen": choose country and bank (with logos), or a BIC when the provider has no bank list. */
export function AddBankDialog({ open, onOpenChange, provider, country, onCountryChange, banks, busy, onConnect }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: "enablebanking" | "xs2a";
  country: BankCountry;
  onCountryChange: (country: BankCountry) => void;
  /** null while loading. */
  banks: BankChoice[] | null;
  busy: boolean;
  onConnect: (choice: { aspsp?: string; bic?: string }) => void;
}) {
  const [aspsp, setAspsp] = useState("");
  const [bic, setBic] = useState("");
  const normalizedBic = bic.replace(/\s/g, "").toUpperCase();
  const bicValid = !normalizedBic || /^[A-Z0-9]{8}([A-Z0-9]{3})?$/.test(normalizedBic);
  const enableBanking = provider === "enablebanking";
  const ready = enableBanking ? (banks ?? []).some((bank) => bank.name === aspsp) : bicValid;
  return (
    <PremiumDialog open={open} onOpenChange={(next) => { if (!next) { setAspsp(""); setBic(""); } onOpenChange(next); }}>
      <PremiumDialogContent size="md" snapPoints={enableBanking ? [0.92] : undefined}>
        <PremiumDialogHeader title="Bank hinzufügen" description="Du meldest dich bei deiner Bank an. Finanzblick sieht deine Zugangsdaten nie." />
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => {
          event.preventDefault();
          if (!ready || busy) return;
          onConnect(enableBanking ? { aspsp } : normalizedBic ? { bic: normalizedBic } : {});
        }}>
          <PremiumDialogBody className="space-y-5">
            <SegmentedControl label="Land der Bank" value={country} options={countries} className="w-full [&>button]:flex-1"
              onChange={(next) => { onCountryChange(next); setAspsp(""); }} />
            {enableBanking
              ? <BankList key={country} banks={banks} value={aspsp} onChange={setAspsp} />
              : <Field label="BIC der Bank" optional error={bicValid ? null : "Eine BIC hat 8 oder 11 Zeichen, z. B. RZKTAT2K."}
                hint="Ohne BIC wählst du die Bank im nächsten Fenster.">
                <Input aria-label="BIC der Bank" className="uppercase" placeholder="z. B. RZKTAT2K" maxLength={14} value={bic} onChange={(event) => setBic(event.target.value)} />
              </Field>}
          </PremiumDialogBody>
          <PremiumDialogFooter>
            <Button type="submit" disabled={!ready || busy}>
              {busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Link2 aria-hidden="true" className="size-4" />}Bank verbinden
            </Button>
          </PremiumDialogFooter>
        </form>
      </PremiumDialogContent>
    </PremiumDialog>
  );
}

function BankList({ banks, value, onChange }: { banks: BankChoice[] | null; value: string; onChange: (name: string) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const known = useKnownBanks();
  const knownIds = useMemo(() => new Set(known.map((name) => canonicalBank(name)?.id ?? fold(name))), [known]);
  const { mine, rest, more } = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean);
    const found = (banks ?? []).filter((bank) => terms.every((term) => fold(bank.name).includes(term)));
    const isMine = (bank: BankChoice) => knownIds.has(canonicalBank(bank.name)?.id ?? fold(bank.name));
    const mineList = found.filter(isMine);
    const restList = found.filter((bank) => !isMine(bank));
    return { mine: mineList, rest: restList.slice(0, LIMIT), more: Math.max(0, restList.length - LIMIT) };
  }, [banks, query, knownIds]);
  const options = [...mine, ...rest];
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter" && options[active] && options[active].name !== value) {
      event.preventDefault();
      onChange(options[active].name);
    }
  }

  const option = (bank: BankChoice, index: number) => {
    const selected = bank.name === value;
    return <li key={`${bank.country}-${bank.name}`} id={`${listId}-${index}`} data-index={index} role="option" aria-selected={selected}
      data-active={index === active || undefined} onMouseMove={() => setActive(index)} onClick={() => onChange(bank.name)}
      className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-2.5 py-1.5 text-sm transition-colors data-[active]:bg-muted aria-selected:bg-accent-muted">
      <BankLogo bank={bank.name} country={bank.country} size="md" />
      <span className="min-w-0 flex-1 truncate">{bank.name}</span>
      {selected && <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />}
    </li>;
  };

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input role="combobox" aria-label="Bank auswählen" aria-expanded aria-controls={listId} aria-autocomplete="list"
          aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
          className="pl-9" placeholder="Bank suchen, z. B. Raiffeisen" autoComplete="off" maxLength={200} value={query}
          onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={key} />
      </div>
      {banks === null ? <DialogSkeleton rows={4} label="Banken werden geladen …" />
        : !options.length ? <DialogEmpty icon={Search} title="Keine Bank gefunden">Probier einen kürzeren Namen, z. B. „Erste“ statt „Erste Bank und Sparkassen“.</DialogEmpty>
          : <ul ref={list} id={listId} role="listbox" aria-label="Banken" className="max-h-[min(24rem,48dvh)] overflow-y-auto overscroll-contain rounded-2xl border border-border/70 p-1">
            {mine.length > 0 && <li role="group" aria-label="Deine Banken">
              <p aria-hidden="true" className="px-2.5 pt-2 pb-1 text-2xs font-medium text-muted-foreground">Deine Banken</p>
              <ul role="presentation">{mine.map((bank, index) => option(bank, index))}</ul>
            </li>}
            <li role="group" aria-label={mine.length ? "Weitere Banken" : "Banken"}>
              {mine.length > 0 && <p aria-hidden="true" className="px-2.5 pt-3 pb-1 text-2xs font-medium text-muted-foreground">Weitere Banken</p>}
              <ul role="presentation">{rest.map((bank, index) => option(bank, mine.length + index))}</ul>
            </li>
          </ul>}
      {more > 0 && <p className="text-xs text-muted-foreground">{more} weitere – tippe weiter, um einzugrenzen.</p>}
    </div>
  );
}
