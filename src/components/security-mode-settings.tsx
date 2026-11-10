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
  const selected = options.find((option) => option.value === preference);
  return <SettingsSection id="sichtschutz" title="Sicherheitsmodus" icon={Shield}
    description="Blendet Beträge unscharf aus, z. B. wenn jemand mitschaut. Gilt nur in diesem Browser.">
    <fieldset disabled={!ready} className="space-y-3">
      <legend className="sr-only">Sichtschutz aktivieren</legend>
      <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
        {options.map((option) => <label key={option.value}
          className={`relative flex min-h-11 cursor-pointer items-center justify-center rounded-lg px-2 text-center text-sm font-medium transition-colors focus-within:ring-2 focus-within:ring-ring ${preference === option.value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
          <input type="radio" name={`${id}-activation`} value={option.value} checked={preference === option.value}
            aria-label={option.title} aria-describedby={`${id}-${option.value}`}
            className="absolute inset-0 size-full cursor-pointer appearance-none rounded-lg opacity-0" onChange={() => setPreference(option.value)} />
          {option.title}
          <span id={`${id}-${option.value}`} className="sr-only">{option.description}</span>
        </label>)}
      </div>
      {selected && <p aria-hidden="true" className="text-xs leading-relaxed text-muted-foreground">{selected.description}</p>}
    </fieldset>
    {error && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4">
      <p role="alert" className="max-w-xl text-xs leading-relaxed">{error}</p>
      <Button type="button" variant="outline" size="lg" onClick={retry}>Erneut versuchen</Button>
    </div>}
  </SettingsSection>;
}
