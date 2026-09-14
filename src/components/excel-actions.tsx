"use client";

import { useRef, useState } from "react";
import { Download, FileSpreadsheet, LoaderCircle, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFinance } from "@/components/finance-provider";
import { dateLabel } from "@/lib/format";
import { type ImportResult } from "@/lib/excel";
import { MAX_IMPORT_BYTES } from "@/lib/import/limits";
import { openReviewCount, queueLedgerReview } from "@/lib/import/review";

export function ExcelActions({ compact = false }: { compact?: boolean }) {
  const { state, replace } = useFinance();
  const fileInput = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"import" | "export" | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [filename, setFilename] = useState("");
  async function download() {
    setBusy("export");
    try {
      const { exportWorkbook } = await import("@/lib/excel");
      const buffer = await exportWorkbook(state);
      const url = URL.createObjectURL(
        new Blob([buffer], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `Finanzdashboard_${state.settings.asOf}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast.success("Excel-Sicherung erstellt");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Export fehlgeschlagen",
      );
    } finally {
      setBusy(null);
    }
  }
  async function upload(file: File) {
    if (!/\.xlsx$/i.test(file.name)) {
      toast.error("Bitte eine XLSX-Datei auswählen.");
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error("Die Datei darf höchstens 20 MB groß sein.");
      return;
    }
    setBusy("import");
    setFilename(file.name);
    try {
      const { parseWorkbook } = await import("@/lib/excel");
      setPreview(await parseWorkbook(await file.arrayBuffer()));
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Import fehlgeschlagen",
      );
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <input
        ref={fileInput}
        className="hidden"
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        aria-label="Excel-Datei auswählen"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      {compact ? <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => void download()}>
          <Download className="size-4" />Exportieren
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => fileInput.current?.click()}>
          <Upload className="size-4" />Wiederherstellen
        </Button>
      </div> : <details className="relative">
        <summary className="cursor-pointer rounded-md border px-3 py-2 text-xs">
          Sicherung
        </summary>
        <div className="absolute right-0 z-40 mt-2 flex min-w-64 flex-col gap-2 rounded-lg border bg-card p-3 shadow-lg">
          <Button
            size="sm"
            variant="ghost"
            disabled={!!busy}
            onClick={() => fileInput.current?.click()}
            aria-label="Sicherung wiederherstellen"
          >
            {busy === "import" ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            <span>Sicherung wiederherstellen</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy}
            onClick={() => void download()}
            aria-label="Excel herunterladen"
          >
            {busy === "export" ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            <span>Sicherung herunterladen</span>
          </Button>
        </div>
      </details>}
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Sicherung wiederherstellen</DialogTitle>
            <DialogDescription className="break-all">
              {filename}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-4">
                <FileSpreadsheet className="size-8 text-primary" />
                <div>
                  <p className="text-sm font-medium">{preview.source}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Berechnungsdatum {dateLabel(preview.state.settings.asOf)}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-center">
                {[
                  {
                    label: "Umsätze",
                    count: preview.state.transactions.length,
                  },
                  {
                    label: "Offen",
                    count: openReviewCount(queueLedgerReview(preview.state).reviewQueue ?? []),
                  },
                ].map((item) => (
                  <div className="rounded-lg border p-3" key={item.label}>
                    <p className="text-2xl font-semibold">{item.count}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.label}
                    </p>
                  </div>
                ))}
              </div>
              {preview.warnings.length > 0 && (
                <div className="max-h-40 overflow-auto rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
                  <p className="mb-2 font-semibold">Hinweise zum Import</p>
                  <ul className="space-y-1.5">
                    {preview.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                Der Import ersetzt alle lokalen Umsätze, Monatswerte und
                Einstellungen. Bestehende Daten vorher als Excel sichern.
              </p>
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => void download()}
              >
                <Download className="size-4" />
                Aktuelle Daten sichern
              </Button>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPreview(null)}>
                  Abbrechen
                </Button>
                <Button
                  disabled={!!busy}
                  onClick={() => {
                    replace(preview.state);
                    toast.success(
                      `${preview.state.transactions.length} Umsätze importiert`,
                    );
                    setPreview(null);
                  }}
                >
                  Sicherung wiederherstellen und aktuelle Daten ersetzen
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
