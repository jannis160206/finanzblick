"use client";

import { useRef, useState } from "react";
import { Download, FileSpreadsheet, LoaderCircle, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFinance, useFinanceRestoration } from "@/components/finance-provider";
import { dateLabel } from "@/lib/format";
import { type ImportResult } from "@/lib/excel";
import { MAX_IMPORT_BYTES } from "@/lib/import/limits";
import { openReviewCount, queueLedgerReview } from "@/lib/import/review";
import { FinanceStorageError } from "@/lib/finance-storage";
import { useAccountWorkspace } from "@/components/account-context";
import { downloadFinanceBackup, parseFinanceBackup } from "@/lib/finance-backup";
import type { AppState } from "@/lib/types";

export function ExcelActions({ compact = false }: { compact?: boolean }) {
  const { state } = useFinance();
  const restore = useFinanceRestoration();
  const workspace = useAccountWorkspace();
  const fileInput = useRef<HTMLInputElement>(null);
  const restoreTrigger = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"import" | "export" | "restore" | null>(null);
  const [preview, setPreview] = useState<(ImportResult & { expected: AppState }) | null>(null);
  const [filename, setFilename] = useState("");
  const [actionError, setActionError] = useState("");
  function downloadJSON() {
    setActionError("");
    try {
      downloadFinanceBackup(state, `Finanzblick_${state.settings.asOf}.json`, workspace?.user.id ?? null);
      toast.success("JSON-Sicherung erstellt");
    } catch (error) {
      if (!(error instanceof FinanceStorageError)) throw error;
      setActionError(error.message);
      toast.error(error.message);
    }
  }
  async function download() {
    setActionError("");
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
      const message = error instanceof Error ? error.message : "Export fehlgeschlagen";
      setActionError(`Die Sicherung konnte nicht erstellt werden. ${message}`);
      toast.error(message);
    } finally {
      setBusy(null);
    }
  }
  async function upload(file: File) {
    setActionError("");
    if (!/\.(xlsx|json)$/i.test(file.name)) {
      setActionError("Bitte eine JSON- oder XLSX-Sicherung auswählen. Die vorhandenen Daten wurden nicht verändert.");
      toast.error("Bitte eine JSON- oder XLSX-Sicherung auswählen.");
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setActionError("Die Datei darf höchstens 20 MB groß sein. Die vorhandenen Daten wurden nicht verändert.");
      toast.error("Die Datei darf höchstens 20 MB groß sein.");
      return;
    }
    setBusy("import");
    setFilename(file.name);
    try {
      const result = /\.json$/i.test(file.name)
        ? { state: parseFinanceBackup(await file.text(), workspace?.user.id ?? null), kind: "backup" as const,
            source: "Finanzblick JSON", warnings: [], skipped: 0 }
        : await (await import("@/lib/excel")).parseWorkbook(await file.arrayBuffer());
      if (result.kind !== "backup") throw new FinanceStorageError(
        "Diese Datei enthält Buchungen, aber keine vollständige Sicherung. Bitte unter Umsätze importieren; vorhandene Guthaben und Einstellungen bleiben erhalten.",
      );
      setPreview({ ...result, expected: state });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import fehlgeschlagen";
      setActionError(`Die Sicherung konnte nicht eingelesen werden. Vorhandene Daten bleiben erhalten. ${message}`);
      toast.error(message);
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
        accept=".xlsx,.json,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        aria-label="Sicherungsdatei auswählen"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      {compact ? <div className="flex flex-wrap gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" disabled={!!busy}>
            <Download className="size-4" />Exportieren
          </Button></DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onSelect={downloadJSON}>JSON-Sicherung herunterladen</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void download()}>Excel-Sicherung herunterladen</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button ref={restoreTrigger} type="button" size="sm" variant="outline" disabled={!!busy} onClick={() => fileInput.current?.click()}>
          <Upload className="size-4" />Wiederherstellen
        </Button>
      </div> : <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={restoreTrigger} type="button" size="sm" variant="outline">Sicherung</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled={!!busy} onSelect={downloadJSON}>
            <Download className="size-4" />JSON-Sicherung herunterladen
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!!busy}
            onSelect={() => fileInput.current?.click()}
            aria-label="Sicherung wiederherstellen"
          >
            {busy === "import" ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            <span>Sicherung wiederherstellen</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!!busy}
            onSelect={() => void download()}
            aria-label="Excel herunterladen"
          >
            {busy === "export" ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            <span>Sicherung herunterladen</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
      {actionError && !preview && (
        <p role="alert" className="max-w-prose break-words text-sm text-destructive">{actionError}</p>
      )}
      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open && !busy) setPreview(null);
        }}
      >
        <DialogContent variant="work" onCloseAutoFocus={(event) => { event.preventDefault(); restoreTrigger.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>Sicherung wiederherstellen</DialogTitle>
            <DialogDescription className="break-all">
              {filename}
            </DialogDescription>
          </DialogHeader>
          {preview && (
            <>
              <DialogBody className="space-y-5">
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
                  { label: "Finanzzeilen", count: preview.state.financeRows.length },
                  { label: "Abrechnungen", count: preview.state.payslips?.length ?? 0 },
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
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                  <p className="mb-2 font-semibold">Hinweise zum Import</p>
                  <ul className="space-y-1.5">
                    {preview.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-sm text-muted-foreground">
                Ersetzt die Finanzdaten und Einstellungen {workspace ? "dieses Kontos" : "dieses Browsermodus"}.
                Andere Konten bleiben unverändert. Vorher eine Sicherung erstellen.
              </p>
              <Button
                variant="outline"
                disabled={!!busy}
                onClick={() => void download()}
              >
                <Download className="size-4" />
                Aktuelle Daten sichern
              </Button>
              {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
              {preview.expected !== state && <div className="space-y-2 rounded-lg border p-3 text-sm">
                <p role="alert">Seit der Vorschau wurde dein Finanzstand geändert. Bitte den aktuellen Stand sichern und erneut prüfen.</p>
                <Button variant="outline" disabled={!!busy} onClick={() => {
                  setPreview({ ...preview, expected: state });
                  setActionError("");
                }}>Vorschau auf aktuellen Stand beziehen</Button>
              </div>}
              </DialogBody>
              <DialogFooter>
                <Button variant="outline" disabled={!!busy} onClick={() => setPreview(null)}>
                  Abbrechen
                </Button>
                <Button
                  variant="destructive"
                  className="h-auto min-h-10 min-w-0 whitespace-normal sm:flex-1"
                  disabled={!!busy || preview.expected !== state}
                  onClick={async () => {
                    setBusy("restore");
                    setActionError("");
                    try {
                      await restore(preview.state, preview.expected);
                      toast.success(
                        "Sicherung wiederhergestellt und gespeichert",
                      );
                      setPreview(null);
                    } catch (error) {
                      if (!(error instanceof FinanceStorageError)) throw error;
                      setActionError(error.message);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === "restore" ? "Speichert Wiederherstellung …" : "Sicherung wiederherstellen und aktuelle Daten ersetzen"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
