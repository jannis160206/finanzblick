"use client";

import { Check, RotateCcw } from "lucide-react";
import {
  isManualSeasonalTheme,
  seasonalLabels,
  seasonalThemes,
  type SeasonalPreference,
  type SeasonalTheme,
} from "@/lib/seasonal-theme";
import { cn } from "@/lib/utils";

const themeColors: Record<SeasonalTheme, string> = {
  default: "#64748b",
  halloween: "#b45309",
  christmas: "#15803d",
  newyear: "#a16207",
  carnival: "#a21caf",
  easter: "#0f766e",
  summer: "#0369a1",
  betweenyears: "#1d4ed8",
};

export type ThemeChoice =
  | { mode: "fixed"; theme: SeasonalTheme }
  | { mode: "auto"; theme: "default" };

export function ThemePicker({
  preference,
  suggested,
  onChoose,
}: {
  preference: SeasonalPreference | undefined;
  suggested: SeasonalTheme;
  onChoose: (choice: ThemeChoice) => void;
}) {
  const manual = isManualSeasonalTheme(preference);
  const selected: SeasonalTheme | "auto" = manual
    ? preference?.mode === "default"
      ? "default"
      : (preference?.theme ?? "default")
    : "auto";
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium">Thema</legend>
      <div className="my-4 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4" role="radiogroup" aria-label="Thema">
        {seasonalThemes.map((theme) => (
          <label key={theme} className="relative min-w-0 cursor-pointer">
            <input
              type="radio"
              name="season-theme"
              className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0"
              value={theme}
              checked={selected === theme}
              onChange={() => onChoose({ mode: "fixed", theme })}
            />
            <span className={cn("flex min-h-12 items-center gap-2.5 rounded-xl border px-3 py-2 text-sm transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
              selected === theme ? "border-primary/50 bg-primary/5 font-medium" : "border-border/70 bg-background/40 hover:bg-accent")}>
              <span aria-hidden="true" className="size-3 shrink-0 rounded-full" style={{ backgroundColor: themeColors[theme] }} />
              <span className="min-w-0 flex-1 truncate">{seasonalLabels[theme]}</span>
              {selected === theme && <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" />}
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/15 p-3">
        <p className="text-xs leading-relaxed text-muted-foreground" aria-live="polite">
          {manual
            ? <>Eigene Wahl aktiv. Die Saison würde <strong className="font-medium text-foreground">{seasonalLabels[suggested]}</strong> vorschlagen.</>
            : <>Automatisch: Die Saison schlägt <strong className="font-medium text-foreground">{seasonalLabels[suggested]}</strong> vor.</>}
        </p>
        <button
          type="button"
          disabled={!manual}
          onClick={() => onChoose({ mode: "auto", theme: "default" })}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-input bg-background px-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw aria-hidden="true" className="size-3.5" />
          Automatisch (Saison)
        </button>
      </div>
    </fieldset>
  );
}
