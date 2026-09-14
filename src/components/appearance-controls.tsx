"use client";

import { Check } from "lucide-react";
import type { Ref } from "react";
import { Label } from "@/components/ui/label";
import {
  accentSwatches,
  accentTokens,
  defaultAccentColor,
} from "@/lib/appearance";
import {
  seasonalLabels,
  selectableSeasonalThemes,
  type SeasonalPreference,
} from "@/lib/seasonal-theme";

export function AppearanceControls({
  value,
  onChange,
  onBlur,
  inputRef,
}: {
  value: SeasonalPreference;
  onChange: (value: SeasonalPreference) => void;
  onBlur: () => void;
  inputRef: Ref<HTMLSelectElement>;
}) {
  const color = value.accentColor?.toLowerCase() ?? defaultAccentColor;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_1.4fr]">
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-1">
        <div>
          <Label htmlFor="seasonal-mode">Modus</Label>
          <select
            id="seasonal-mode"
            ref={inputRef}
            onBlur={onBlur}
            className="select-input mt-2 w-full"
            value={value.mode}
            onChange={(event) =>
              onChange({
                ...value,
                mode: event.target.value as SeasonalPreference["mode"],
              })
            }
          >
            <option value="auto">Automatisch</option>
            <option value="default">Immer Standard</option>
            <option value="fixed">Festes Theme</option>
          </select>
        </div>
        {value.mode === "fixed" && (
          <div>
            <Label htmlFor="seasonal-theme">Festes Theme</Label>
            <select
              id="seasonal-theme"
              onBlur={onBlur}
              className="select-input mt-2 w-full"
              value={value.theme}
              onChange={(event) =>
                onChange({
                  ...value,
                  theme: event.target.value as SeasonalPreference["theme"],
                })
              }
            >
              {selectableSeasonalThemes.map((theme) => (
                <option value={theme} key={theme}>
                  {seasonalLabels[theme]}
                </option>
              ))}
              {value.theme === "newyear" && (
                <option value="newyear">Neujahr (bisherige Auswahl)</option>
              )}
            </select>
          </div>
        )}
      </div>
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
    </div>
  );
}
