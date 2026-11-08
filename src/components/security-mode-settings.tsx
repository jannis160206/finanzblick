"use client";

import { useId } from "react";
import { Shield } from "lucide-react";
import { SettingsSection } from "@/components/settings-section";
import { useSecurityMode } from "@/components/security-mode-provider";
import { Button } from "@/components/ui/button";
import type { SecurityActivationPreference } from "@/lib/security-mode";

const options: { value: SecurityActivationPreference; title: string; description: string }[] = [
  { value: "automatic", title: "Automatisch", description: "Beim Wechseln des Tabs oder Fensters. Bleibt aktiv, bis du am Schild entsperrst." },
  { value: "manual", title: "Nur manuell", description: "Du aktivierst und beendest den Sichtschutz selbst über das Schild." },
  { value: "off", title: "Deaktiviert", description: "Kein Sichtschutz – auch nicht über das Schild." },
];

export function SecurityModeSettings() {
  const { preference, setPreference, ready, error, retry } = useSecurityMode();
  const id = useId();
  return <SettingsSection id="sichtschutz" title="Sicherheitsmodus" icon={Shield}
    description="Beträge unscharf anzeigen.">
    <fieldset disabled={!ready} aria-describedby={`${id}-local`} className="space-y-3">
      <legend className="mb-3 text-sm font-medium">Sichtschutz aktivieren</legend>
      <div className="grid gap-3 lg:grid-cols-3">
        {options.map((option) => <label key={option.value}
          className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-2xl border p-4 transition-colors focus-within:ring-2 focus-within:ring-ring ${preference === option.value ? "border-primary/40 bg-primary/5" : "border-border/70 bg-muted/15 hover:bg-muted/25"}`}>
          <input type="radio" name={`${id}-activation`} value={option.value} checked={preference === option.value}
            aria-label={option.title} aria-describedby={`${id}-${option.value}`}
            className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onChange={() => setPreference(option.value)} />
          <span><span className="block text-sm font-medium">{option.title}</span>
            <span id={`${id}-${option.value}`} className="mt-1 block text-xs leading-relaxed text-muted-foreground">{option.description}</span>
          </span>
        </label>)}
      </div>
    </fieldset>
    <p id={`${id}-local`} className="mt-4 text-xs leading-relaxed text-muted-foreground">Nur in diesem Browser.</p>
    {error && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4">
      <p role="alert" className="max-w-xl text-xs leading-relaxed">{error}</p>
      <Button type="button" variant="outline" size="lg" onClick={retry}>Erneut versuchen</Button>
    </div>}
  </SettingsSection>;
}
