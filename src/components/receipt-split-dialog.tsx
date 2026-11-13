"use client";

import { useRef, useState } from "react";
import { Receipt, Sparkles, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  PremiumDialog,
  PremiumDialogBody,
  PremiumDialogContent,
  PremiumDialogFooter,
  PremiumDialogHeader,
  PremiumDialogItem,
} from "@/components/ui/premium-dialog";
import { CategorySelect } from "@/components/category-select";
import { useFinance } from "@/components/finance-provider";
import { classify } from "@/lib/calc";
import { canonicalCategory, type Category } from "@/lib/categories";
import { currency, dateLabel } from "@/lib/format";
import { bookingDescription } from "@/lib/import/merchant-description";
import { parseReceiptText, receiptSplitPreview, type ParsedReceipt } from "@/lib/receipts/receipt";
import { validSplits } from "@/lib/splits";
import { assignTransactions } from "@/lib/transaction-tools";
import { transactionSchema, type Transaction } from "@/lib/types";

const RECEIPT_FALLBACKS: Category[] = ["Lebensmittel", "Drogerie", "Wohnen & Haushalt", "Haustiere", "Gesundheit", "Shopping"];

export function ReceiptSplitDialog({ booking, onClose }: { booking: Transaction; onClose: () => void }) {
  const { state, update, storageError } = useFinance();
  const current = state.transactions.find((row) => row.id === booking.id);
  const bookingCategory = canonicalCategory(classify(current ?? booking).category);
  const fallback = RECEIPT_FALLBACKS.includes(bookingCategory) ? bookingCategory : "Lebensmittel";
  const [receipt, setReceipt] = useState<ParsedReceipt | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const amount = current?.amount ?? booking.amount;
  const preview = receipt ? receiptSplitPreview(receipt, amount) : null;
  const unknown = receipt?.items.filter((item) => !item.known) ?? [];
  const existing = current && validSplits(current) ? current.splits : undefined;

  async function read(file: File) {
    setError(null);
    setReceipt(null);
    setProgress(0);
    try {
      const { readReceiptText } = await import("@/lib/receipts/receipt-ocr");
      const parsed = parseReceiptText(await readReceiptText(file, setProgress), fallback);
      if (!parsed.items.length) setError("Auf dem Kassenbon wurden keine Artikel mit Preis erkannt. Bitte ein schärferes, gerades Foto versuchen.");
      else setReceipt(parsed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Der Kassenbon konnte nicht gelesen werden.");
    } finally {
      setProgress(null);
    }
  }

  function setCategory(index: number, category: Category) {
    setReceipt((value) => value && {
      ...value,
      items: value.items.map((item, position) => (position === index ? { ...item, category, known: true } : item)),
    });
  }

  async function classifyUnknown() {
    if (!receipt || !unknown.length) return;
    setAiBusy(true);
    try {
      const names = [...new Set(unknown.map((item) => item.name.slice(0, 80)).filter((name) => name.length >= 2))].slice(0, 40);
      const response = await fetch("/api/ai/receipt-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ names }),
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as { categories?: (Category | null)[]; error?: string };
      if (!response.ok || !Array.isArray(body.categories)) throw new Error(body.error ?? "Die lokale KI ist gerade nicht erreichbar.");
      const answers = new Map(names.map((name, index) => [name, body.categories?.[index] ?? null]));
      const items = receipt.items.map((item) => {
        const category = item.known ? null : answers.get(item.name.slice(0, 80));
        return category ? { ...item, category, known: true, note: "KI-Vorschlag" } : item;
      });
      const assigned = items.filter((item, index) => item !== receipt.items[index]).length;
      setReceipt({ ...receipt, items });
      toast.success(assigned ? "KI-Vorschläge übernommen – bitte kurz prüfen." : "Die KI war sich bei keinem Artikel sicher.");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "KI-Zuordnung fehlgeschlagen.");
    } finally {
      setAiBusy(false);
    }
  }

  function save() {
    if (!current || !preview || preview.splits.length < 2) return;
    const splits = preview.splits;
    const candidate = transactionSchema.safeParse({ ...current, splits });
    if (!candidate.success) {
      toast.error("Die Aufteilung ist ungültig und wurde nicht gespeichert.");
      return;
    }
    update((latest) => {
      // An unassigned booking takes the largest part as its main category; the split decides the totals.
      const next = classify(current).category === "Prüfen"
        ? assignTransactions(latest, [current.id], { category: splits[0].category })
        : latest;
      return { ...next, transactions: next.transactions.map((row) => (row.id === current.id ? { ...row, splits } : row)) };
    });
    toast.success(`Kassenbon in ${splits.length} Buchungen aufgeteilt`);
    onClose();
  }

  function remove() {
    if (!current) return;
    update((latest) => ({
      ...latest,
      transactions: latest.transactions.map((row) => {
        if (row.id !== current.id) return row;
        const rest = { ...row };
        delete rest.splits;
        return rest;
      }),
    }));
    toast.success("Aufteilung entfernt");
    onClose();
  }

  return (
    <PremiumDialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <PremiumDialogContent size="lg">
        <PremiumDialogHeader icon={Receipt} title="Kassenbon aufteilen"
          description={`${bookingDescription(booking)} · ${dateLabel(booking.date)} · ${currency(amount)}. Foto oder PDF des Bons wählen – er wird nur auf diesem Gerät gelesen, die Artikel werden Kategorien zugeordnet.`} />
        <PremiumDialogBody className="space-y-5">
          {!current && <p role="alert" className="text-sm text-destructive">Diese Buchung gibt es nicht mehr.</p>}
          {existing && !receipt && (
            <section aria-label="Aktuelle Aufteilung" className="rounded-2xl bg-surface-sunken/70 p-4 text-sm">
              <p className="font-medium">Aktuell aufgeteilt</p>
              <ul className="mt-2 space-y-1">
                {existing.map((part) => (
                  <li key={part.category} className="flex justify-between gap-3">
                    <span>{canonicalCategory(part.category)}{part.note ? ` · ${part.note}` : ""}</span>
                    <span className="tabular-nums">{currency(part.amount)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <PremiumDialogItem className="flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-border p-4">
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="sr-only"
              aria-label="Kassenbon-Foto oder PDF wählen"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void read(file);
              }}
            />
            <Button type="button" variant="outline" disabled={progress !== null || !current} onClick={() => input.current?.click()}>
              <Upload />
              {receipt ? "Anderen Bon wählen" : "Foto oder PDF wählen"}
            </Button>
            {progress !== null && (
              <p role="status" className="text-sm text-muted-foreground">
                Kassenbon wird gelesen … {Math.round(progress * 100)} %
              </p>
            )}
          </PremiumDialogItem>
          {error && <p role="alert" className="text-sm font-medium text-destructive">{error}</p>}
          {receipt && preview && (
            <>
              <section aria-label="Erkannte Artikel">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{receipt.items.length} Artikel erkannt</p>
                  {unknown.length > 0 && (
                    <Button type="button" size="sm" variant="ghost" disabled={aiBusy} onClick={() => void classifyUnknown()}>
                      <Sparkles />
                      {aiBusy ? "KI ordnet zu …" : `${unknown.length} unbekannte mit KI zuordnen`}
                    </Button>
                  )}
                </div>
                <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {receipt.items.map((item, index) => (
                    <li key={`${index}-${item.name}`} className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[1fr_12rem_auto]">
                      <span className="min-w-0 truncate text-sm" title={item.name}>
                        {item.name}
                        {item.quantity && item.unitPrice ? <span className="text-muted-foreground"> · {item.quantity} × {currency(item.unitPrice)}</span> : null}
                        {item.discount ? <span className="text-muted-foreground"> · Rabatt {currency(item.discount)}</span> : null}
                        {!item.known && <span className="text-amber-700 dark:text-amber-400"> · unsicher</span>}
                        {item.note && <span className="text-muted-foreground"> · {item.note}</span>}
                      </span>
                      <CategorySelect
                        label={`Kategorie für ${item.name}`}
                        excludeReview
                        className="order-3 col-span-2 sm:order-none sm:col-span-1"
                        value={item.category}
                        onValueChange={(category) => setCategory(index, category)}
                      />
                      <span className="text-right text-sm tabular-nums">{currency(item.amount)}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <section aria-label="Aufteilung" className="rounded-2xl bg-surface-sunken/70 p-4 text-sm">
                <p className="font-medium">Aufteilung der Buchung</p>
                <ul className="mt-2 space-y-1">
                  {preview.splits.map((part) => (
                    <li key={part.category} className="flex justify-between gap-3">
                      <span>{canonicalCategory(part.category)}{part.note ? ` · ${part.note}` : ""}</span>
                      <span className="tabular-nums">{currency(part.amount)}</span>
                    </li>
                  ))}
                </ul>
                {receipt.total !== undefined && !receipt.totalMatches && (
                  <p className="mt-3 text-amber-700 dark:text-amber-400">
                    Die Artikel ergeben {currency(receipt.itemsTotal)}, die Bon-Summe ist {currency(receipt.total)}. Bitte prüfen, ob eine Zeile fehlt.
                  </p>
                )}
                {preview.bookingDifference !== 0 && (
                  <p className="mt-3 text-muted-foreground">
                    Der Bon ({currency(receipt.total ?? receipt.itemsTotal)}) weicht um {currency(Math.abs(preview.bookingDifference))} von der Buchung ab.
                    Die Kategorien werden anteilig auf {currency(Math.abs(amount))} umgerechnet.
                  </p>
                )}
                {preview.splits.length < 2 && (
                  <p className="mt-3 text-muted-foreground">
                    Alle Artikel gehören zu einer Kategorie – dafür reicht „Zuordnung ändern“.
                  </p>
                )}
              </section>
            </>
          )}
        </PremiumDialogBody>
        <PremiumDialogFooter>
          {existing && (
            <Button type="button" variant="ghost" className="text-destructive sm:mr-auto" disabled={!!storageError} onClick={remove}>
              <Trash2 />
              Aufteilung entfernen
            </Button>
          )}
          <Button type="button" variant="outline" onClick={onClose}>Abbrechen</Button>
          <Button type="button" disabled={!preview || preview.splits.length < 2 || !!storageError || !current} onClick={save}>
            <Receipt />
            Aufteilen
          </Button>
        </PremiumDialogFooter>
      </PremiumDialogContent>
    </PremiumDialog>
  );
}
