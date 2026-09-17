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
    <div className="mt-4 border-t pt-4">
      <label className="flex cursor-pointer items-center gap-3 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        <span className="flex-1">Interaktionsklänge</span>
        <span
          className="text-xs font-normal text-muted-foreground"
          aria-hidden="true"
        >
          {enabled ? (volume > 0 ? "An · dezent" : "An · lautlos") : "Aus"}
        </span>
        <input
          type="checkbox"
          role="switch"
          className="size-4 accent-primary"
          checked={enabled}
          aria-describedby="interaction-sounds-hint interaction-sounds-status"
          data-interaction-sound="off"
          onChange={(event) =>
            sounds.setEnabled(event.target.checked, event.nativeEvent)
          }
        />
      </label>
      <p
        id="interaction-sounds-hint"
        className="mt-2 text-xs leading-relaxed text-muted-foreground"
      >
        Kurze, leise Klicks beim Drücken und Umschalten. Keine Klänge beim
        Tippen oder Darüberfahren. Gilt sofort und nur in diesem Browser –
        unabhängig vom Speichern oben.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
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
          ? "Diese Auswahl gilt nur bis zum Neuladen; der Browser erlaubt gerade kein lokales Speichern."
          : availability === "unavailable"
            ? "Dieser Browser unterstützt keine Interaktionsklänge."
            : availability === "blocked"
              ? enabled
                ? "Der Browser meldet ein Audioproblem. Die Bedienung bleibt unverändert."
                : "Alle Interaktionsklänge sind stumm. Der Browser meldet ein Audioproblem."
              : enabled && volume > 0
                ? "Kurze Klänge · ohne Audiodateien oder Netzwerkzugriff."
                : "Alle Interaktionsklänge sind stumm."}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        Nichts zu hören? Prüfe die Tab-Stummschaltung und die Browser-Lautstärke
        im Systemmixer.
      </p>
    </div>
  );
}
