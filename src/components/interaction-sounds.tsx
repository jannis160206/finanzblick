"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createInteractionSounds } from "@/lib/interaction-sounds";
import { cn } from "@/lib/utils";

const SoundContext = createContext<ReturnType<
  typeof createInteractionSounds
> | null>(null);

export function InteractionSoundsProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [sounds] = useState(createInteractionSounds);
  useEffect(() => sounds.mount(), [sounds]);
  return (
    <SoundContext.Provider value={sounds}>{children}</SoundContext.Provider>
  );
}

export function InteractionSoundsSetting() {
  const sounds = useContext(SoundContext);
  if (!sounds)
    throw new Error(
      "InteractionSoundsSetting requires InteractionSoundsProvider",
    );
  return <SoundSetting sounds={sounds} />;
}

function SoundSetting({
  sounds,
}: {
  sounds: ReturnType<typeof createInteractionSounds>;
}) {
  const { enabled, volume, availability, storageAvailable } =
    useSyncExternalStore(
      sounds.subscribe,
      sounds.getSnapshot,
      sounds.getServerSnapshot,
    );
  const Icon = enabled && volume > 0 ? Volume2 : VolumeX;
  return (
    <div className="rounded-2xl border border-border/70 bg-muted/15 p-4">
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background/70">
          <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1 break-words">Interaktionsklänge</span>
        <span
          className="hidden text-xs font-normal text-muted-foreground sm:inline"
          aria-hidden="true"
        >
          {enabled ? (volume > 0 ? "An · dezent" : "An · lautlos") : "Aus"}
        </span>
        <span className="relative shrink-0">
        <input
          type="checkbox"
          role="switch"
          className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0"
          checked={enabled}
          aria-describedby="interaction-sounds-hint interaction-sounds-status"
          data-interaction-sound="off"
          onChange={(event) =>
            sounds.setEnabled(event.target.checked, event.nativeEvent)
          }
        />
        <span aria-hidden="true" className="block h-6 w-11 rounded-full bg-muted transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card">
          <span className={cn("block size-5 translate-x-0.5 translate-y-0.5 rounded-full bg-foreground/70 transition-transform", enabled && "translate-x-5 bg-primary-foreground")} />
        </span>
        </span>
      </label>
      <p
        id="interaction-sounds-hint"
        className="mt-2 text-xs leading-relaxed text-muted-foreground"
      >
        Sofort wirksam · nur in diesem Browser.
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border/60 pt-4">
        <label
          className="min-w-40 flex-1 text-xs"
          htmlFor="interaction-sounds-volume"
        >
          <span className="flex items-center justify-between gap-3">
            Lautstärke <span className="tabular-nums">{volume} %</span>
          </span>
          <input
            id="interaction-sounds-volume"
            type="range"
            min="0"
            max="100"
            step="5"
            className="mt-2 h-5 w-full accent-primary disabled:opacity-50"
            value={volume}
            disabled={!enabled}
            aria-label="Lautstärke der Interaktionsklänge"
            aria-valuetext={`${volume} Prozent${volume === 0 ? " – stumm" : ""}`}
            onChange={(event) => sounds.setVolume(Number(event.target.value))}
          />
        </label>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mb-0.5"
          disabled={!enabled || volume === 0 || availability === "unavailable"}
          data-interaction-sound="off"
          onClick={(event) => sounds.preview(event.nativeEvent)}
        >
          Klang testen
        </Button>
      </div>
      <p
        id="interaction-sounds-status"
        role="status"
        className="mt-1 text-xs text-muted-foreground"
      >
        {!storageAvailable
          ? "Nicht gespeichert – gilt nur bis zum Neuladen."
          : availability === "unavailable"
            ? "Dieser Browser unterstützt keine Interaktionsklänge."
            : availability === "blocked"
              ? enabled
                ? "Audioproblem im Browser. Bedienung bleibt möglich."
                : "Stumm · Audioproblem im Browser."
              : enabled && volume > 0
                ? "Klänge aktiv."
                : "Stumm."}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Kein Ton? Tab-Stummschaltung und Lautstärkemixer prüfen.
      </p>
    </div>
  );
}
