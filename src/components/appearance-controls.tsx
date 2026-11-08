"use client";

import { Check } from "lucide-react";
import type { Ref } from "react";
import { Label } from "@/components/ui/label";
import {
  accentSwatches,
  accentTokens,
  defaultAccentColor,
} from "@/lib/appearance";
import type { SeasonalPreference } from "@/lib/seasonal-theme";
import { cn } from "@/lib/utils";

export function AppearanceControls({
  value,
  onChange,
  onBlur,
  inputRef,
}: {
  value: SeasonalPreference;
  onChange: (value: SeasonalPreference) => void;
  onBlur: () => void;
  inputRef: Ref<HTMLInputElement>;
}) {
  const color = value.accentColor?.toLowerCase() ?? defaultAccentColor;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1.1fr_1fr]">
      <fieldset className="min-w-0">
        <legend className="text-sm font-medium">Akzentfarbe</legend>
        <div
          className="my-4 grid grid-cols-3 gap-2"
          role="radiogroup"
          aria-label="Akzentfarben"
        >
          {accentSwatches.map((swatch) => (
            <label
              key={swatch.color}
              className="relative min-w-0 cursor-pointer"
              title={swatch.label}
            >
              <input
                type="radio"
                className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0"
                name="accent-swatch"
                aria-label={swatch.label}
                value={swatch.color}
                checked={color === swatch.color}
                onBlur={onBlur}
                onChange={() =>
                  onChange({ ...value, accentColor: swatch.color })
                }
              />
              <span
                className={cn("flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border px-2 py-3 transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
                  color === swatch.color ? "border-primary/50 bg-primary/5" : "border-border/70 bg-background/40 hover:bg-accent")}
              >
                <span className="flex size-7 items-center justify-center rounded-full shadow-sm" style={{
                  backgroundColor: swatch.color,
                  color: accentTokens(swatch.color)["--user-accent-foreground"],
                }}>
                  {color === swatch.color && <Check className="size-3.5" aria-hidden="true" />}
                </span>
                <span className="text-2xs font-medium">{swatch.label}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/15 p-3">
          <input
            id="accent-picker"
            ref={inputRef}
            type="color"
            className="h-11 w-12 shrink-0 cursor-pointer rounded-lg border bg-card p-1"
            value={color}
            onBlur={onBlur}
            onChange={(event) =>
              onChange({ ...value, accentColor: event.target.value })
            }
          />
          <div className="flex-1">
            <Label htmlFor="accent-picker">Eigene Akzentfarbe</Label>
            <p
              className="mt-1 font-mono text-xs text-muted-foreground"
              aria-hidden="true"
            >
              {color.toUpperCase()}
            </p>
          </div>
        </div>
      </fieldset>
      <div className="space-y-4">
        <label className="flex cursor-pointer items-center gap-3 rounded-2xl border border-border/70 bg-muted/15 p-4">
          <span className="flex-1">
            <span className="block text-sm font-medium">Bewegung reduzieren</span>
            <span className="mt-1 block text-xs text-muted-foreground">Weniger Animationen</span>
          </span>
          <span className="relative shrink-0">
            <input
            type="checkbox"
            className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0"
            aria-label="Bewegung reduzieren"
            checked={value.reduceMotion ?? false}
            onBlur={onBlur}
            onChange={(event) => onChange({ ...value, reduceMotion: event.target.checked })}
            />
            <span aria-hidden="true" className="block h-6 w-11 rounded-full bg-muted transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card">
              <span className={cn("block size-5 translate-x-0.5 translate-y-0.5 rounded-full bg-foreground/70 transition-transform", value.reduceMotion && "translate-x-5 bg-primary-foreground")} />
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
