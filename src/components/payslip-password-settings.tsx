"use client";

import { useState } from "react";
import { FileLock2, KeyRound, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PasswordInput } from "@/components/ui/password-input";
import { usePayslipPasswordStatus, usePayslipPasswordStore } from "@/components/payslip-password";
import { dateLabel } from "@/lib/format";
import { cn } from "@/lib/utils";

export function PayslipPasswordSettings() {
  const store = usePayslipPasswordStore();
  const status = usePayslipPasswordStatus(store);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"save" | "remove" | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const stored = status.state === "stored";
  const showForm = status.state === "none" || (stored && editing);
  const where = store.scope === "account" ? "verschlüsselt auf deinem Server" : "verschlüsselt nur in diesem Browser";

  async function save() {
    if (!value || busy) return;
    setBusy("save");
    setError("");
    try {
      await store.save(value);
      setValue("");
      setEditing(false);
      toast.success("PDF-Passwort gespeichert");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Passwort konnte nicht gespeichert werden.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    setBusy("remove");
    setError("");
    try {
      await store.clear();
      setConfirming(false);
      setEditing(false);
      toast.success("PDF-Passwort entfernt");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Passwort konnte nicht entfernt werden.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection id="pdf-passwort" title="PDF-Passwort" icon={KeyRound}
      description="Für passwortgeschützte Lohnzettel: Finanzblick versucht es automatisch beim Hochladen und beim Import aus Google Drive. Das Passwort wird verschlüsselt gespeichert und nie wieder angezeigt.">
      {status.state === "unavailable" ? (
        <p className="text-sm text-muted-foreground">Dieser Browser bietet keinen sicheren Speicher. Geschützte PDFs fragen beim Hochladen nach dem Passwort.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/70 bg-background/40 px-4 py-3">
            <span aria-hidden="true" className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl",
              stored ? "bg-accent-muted text-primary" : "bg-muted text-muted-foreground")}>
              <FileLock2 className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {status.state === "loading" ? "Wird geprüft …" : stored ? "Passwort hinterlegt" : status.state === "error" ? "Status nicht verfügbar" : "Kein Passwort hinterlegt"}
                {stored && <Badge variant="success">aktiv</Badge>}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {stored && status.updatedAt ? `Seit ${dateLabel(new Date(status.updatedAt).toISOString().slice(0, 10))} · ${where}` : `Wird ${where} gespeichert.`}
              </p>
            </div>
            {stored && !editing && (
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => { setEditing(true); setError(""); }}>Ändern</Button>
                <Button variant="ghost" size="icon" className="size-9 text-muted-foreground hover:text-destructive" aria-label="PDF-Passwort entfernen"
                  disabled={!!busy} onClick={() => setConfirming(true)}>
                  <Trash2 aria-hidden="true" className="size-4" />
                </Button>
              </div>
            )}
            {status.state === "error" && <Button variant="outline" size="sm" onClick={status.refresh}>Erneut prüfen</Button>}
          </div>
          {showForm && (
            <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={(event) => { event.preventDefault(); void save(); }}>
              <label className="min-w-0 flex-1 space-y-2 text-sm font-medium">
                <span className="block">{stored ? "Neues PDF-Passwort" : "PDF-Passwort"}</span>
                <PasswordInput value={value} maxLength={200} disabled={!!busy} autoFocus={editing}
                  aria-invalid={error ? true : undefined} onChange={(event) => setValue(event.target.value)} />
              </label>
              <div className="flex gap-2">
                {stored && <Button type="button" variant="ghost" disabled={!!busy} onClick={() => { setEditing(false); setValue(""); setError(""); }}>Abbrechen</Button>}
                <Button type="submit" disabled={!value || !!busy}>
                  {busy === "save" && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}Speichern
                </Button>
              </div>
            </form>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
      )}
      <Dialog open={confirming} onOpenChange={(open) => { if (!open && !busy) setConfirming(false); }}>
        <DialogContent variant="confirmation">
          <DialogHeader>
            <DialogTitle>PDF-Passwort entfernen?</DialogTitle>
            <DialogDescription>Geschützte Lohnzettel fragen danach wieder beim Öffnen nach dem Passwort.</DialogDescription>
          </DialogHeader>
          <DialogBody>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</DialogBody>
          <DialogFooter>
            <Button variant="outline" disabled={!!busy} onClick={() => setConfirming(false)}>Abbrechen</Button>
            <Button variant="destructive" disabled={!!busy} onClick={() => { void remove(); }}>
              {busy === "remove" && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}Entfernen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
