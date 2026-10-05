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
    <div className="grid items-start gap-4 sm:grid-cols-2">
      <fieldset>
        <legend className="text-sm font-medium">Akzentfarbe</legend>
        <div
          className="my-4 flex flex-wrap gap-3"
          role="radiogroup"
          aria-label="Akzentfarben"
        >
          {accentSwatches.map((swatch) => (
            <label
              key={swatch.color}
              className="accent-swatch"
              title={swatch.label}
            >
              <input
                type="radio"
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
                style={{
                  backgroundColor: swatch.color,
                  color: accentTokens(swatch.color)["--user-accent-foreground"],
                }}
              >
                {color === swatch.color && (
                  <Check className="size-4" aria-hidden="true" />
                )}
              </span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <input
            id="accent-picker"
            ref={inputRef}
            type="color"
            className="h-10 w-12 cursor-pointer rounded-md border bg-card p-1"
            value={color}
            onBlur={onBlur}
            onChange={(event) =>
              onChange({ ...value, accentColor: event.target.value })
            }
          />
          <div>
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
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.reduceMotion ?? false}
            onBlur={onBlur}
            onChange={(event) => onChange({ ...value, reduceMotion: event.target.checked })}
          />
          Bewegung reduzieren
        </label>
        <p className="text-xs text-muted-foreground">
          Saisonale Details automatisch · Akzentfarbe bleibt.
        </p>
      </div>
    </div>
  );
}
