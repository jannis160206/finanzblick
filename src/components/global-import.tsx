"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp, LoaderCircle, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useFinance } from "@/components/finance-provider";
import { deliverImport, guessImportKind, type ImportKind } from "@/lib/import-inbox";
import { cn } from "@/lib/utils";
import { OPEN_IMPORT_EVENT } from "@/lib/shell-events";

async function classify(file: File): Promise<ImportKind> {
  const guess = guessImportKind(file);
  if (guess !== "pdf") return guess;
  try {
    const { parsePayslipPdf, PayslipPasswordError } = await import("@/lib/import/payslip");
    try {
      return (await parsePayslipPdf(await file.arrayBuffer())).drafts.length ? "payslip" : "statement";
    } catch (cause) {
      return cause instanceof PayslipPasswordError ? "payslip" : "statement";
    }
  } catch {
    return "statement";
  }
}

// One import for everything: bank/Amex/PayPal CSV, Excel, PDF statements, screenshots and payslips.
export function GlobalImport() {
  const router = useRouter();
  const { ready, storageError } = useFinance();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_IMPORT_EVENT, show);
    return () => window.removeEventListener(OPEN_IMPORT_EVENT, show);
  }, []);

  async function route(files: File[]) {
    if (!files.length || busy) return;
    setBusy(true);
    try {
      const kinds = await Promise.all(files.map(classify));
      const statements = files.filter((_, index) => kinds[index] === "statement");
      const payslips = files.filter((_, index) => kinds[index] === "payslip");
      deliverImport("statement", statements);
      deliverImport("payslip", payslips);
      setOpen(false);
      if (statements.length) {
        router.push("/umsaetze");
        if (payslips.length) toast.info(`${payslips.length} Lohnabrechnung(en) erkannt`, {
          description: "Sie werden eingelesen, sobald du „Gehalt & Steuern“ öffnest.",
          action: { label: "Öffnen", onClick: () => router.push("/gehalt-steuern") },
        });
      } else router.push("/gehalt-steuern");
    } finally {
      setBusy(false);
    }
  }

  const disabled = !ready || !!storageError || busy;
  return <>
    <Button variant="ghost" size="sm" className="h-9 gap-1.5 px-2.5" disabled={!ready} onClick={() => setOpen(true)} aria-label="Dateien importieren">
      <Upload aria-hidden="true" className="size-4" /><span className="hidden sm:inline">Importieren</span>
    </Button>
    <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
      <DialogContent variant="work" className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>Importieren</DialogTitle>
          <DialogDescription>Die Art der Datei wird automatisch erkannt.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div role="group" aria-label="Dateiablage für alle Importe"
            className={cn("flex flex-col items-center gap-3 rounded-2xl border border-dashed p-6 text-center transition-colors motion-reduce:transition-none", dragging && "border-primary bg-primary/5")}
            onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); if (!disabled) void route(Array.from(event.dataTransfer.files)); }}>
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary/5"><FileUp aria-hidden="true" className="size-5 text-muted-foreground" /></span>
            <p className="text-sm font-medium">Dateien hier ablegen</p>
            <input ref={input} type="file" multiple className="hidden" aria-label="Importdateien auswählen"
              accept=".csv,.xlsx,.pdf,.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp,application/pdf"
              onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; void route(files); }} />
            <Button variant="outline" className="min-h-11" disabled={disabled} onClick={() => input.current?.click()}>
              {busy ? <><LoaderCircle aria-hidden="true" className="size-4 animate-spin" />Wird erkannt …</> : "Dateien auswählen"}
            </Button>
            {storageError && <p role="alert" className="text-xs text-destructive">{storageError}</p>}
          </div>
          <ul className="mt-4 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <li><span className="font-medium text-foreground">Kontoauszüge</span> · CSV, Excel oder PDF der Bank</li>
            <li><span className="font-medium text-foreground">Amex</span> · activity.csv, PDF oder Screenshot</li>
            <li><span className="font-medium text-foreground">PayPal</span> · Aktivitäten-CSV</li>
            <li><span className="font-medium text-foreground">Lohnabrechnung</span> · PDF, auch mit Passwort</li>
          </ul>
        </DialogBody>
      </DialogContent>
    </Dialog>
  </>;
}
