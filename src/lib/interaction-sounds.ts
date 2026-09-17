export const interactionSoundsKey = "finanzblick.interaction-sounds.v1";
export const interactionSoundsVolumeKey =
  "finanzblick.interaction-sounds-volume.v1";
export const defaultInteractionSoundsVolume = 60;
export const interactionSoundInterval = 140;

type Sound = "click" | "on" | "off";
type SoundSnapshot = {
  enabled: boolean;
  volume: number;
  storageAvailable: boolean;
  availability: "ready" | "unavailable" | "blocked";
};

const initialSnapshot: SoundSnapshot = {
  enabled: true,
  volume: defaultInteractionSoundsVolume,
  storageAvailable: true,
  availability: "ready",
};

export function interactionSoundFor(event: MouseEvent): Sound | null {
  if (
    !event.isTrusted ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return null;
  if (!(event.target instanceof Element)) return null;
  const control = event.target.closest(
    'button, a[href], input[type="checkbox"], input[type="radio"], input[type="button"], input[type="submit"], input[type="reset"], [role="button"], [role="switch"], [role="checkbox"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"]',
  );
  if (
    !control ||
    control.closest(
      ':disabled, [aria-disabled="true"], [inert], [hidden], [data-interaction-sound="off"]',
    )
  )
    return null;
  // A checkbox's native checked state has already changed during click dispatch.
  if (
    control instanceof HTMLInputElement &&
    ["checkbox", "radio"].includes(control.type)
  ) {
    return control.checked ? "on" : "off";
  }
  const checked =
    control.getAttribute("aria-checked") ??
    control.getAttribute("aria-pressed");
  return checked === null ? "click" : checked === "true" ? "off" : "on";
}

export function createInteractionSounds() {
  let snapshot = initialSnapshot;
  const subscribers = new Set<() => void>();
  let context: AudioContext | null = null;
  const voices = new Set<() => void>();
  let mounted = false;
  let away = false;
  let generation = 0;
  let lastInteraction = -Infinity;

  const publish = (patch: Partial<SoundSnapshot>) => {
    if (
      Object.entries(patch).every(
        ([key, value]) => snapshot[key as keyof SoundSnapshot] === value,
      )
    )
      return;
    snapshot = { ...snapshot, ...patch };
    subscribers.forEach((listener) => listener());
  };

  const audioConstructor = () =>
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  const silence = () => {
    generation++;
    voices.forEach((dispose) => dispose());
    const previous = context;
    context = null;
    if (previous && previous.state !== "closed") {
      // Closing is best-effort; nodes are disconnected synchronously even if it fails.
      let closing: Promise<void>;
      try {
        closing = previous.close();
      } catch {
        publish({ availability: "blocked" });
        return;
      }
      void closing.catch(() => publish({ availability: "blocked" }));
    }
  };

  const readPreference = () => {
    let stored: string | null;
    let storedVolume: string | null | undefined;
    let storageAvailable = true;
    try {
      stored = window.localStorage.getItem(interactionSoundsKey);
    } catch {
      publish({ storageAvailable: false });
      return;
    }
    try {
      storedVolume = window.localStorage.getItem(interactionSoundsVolumeKey);
    } catch {
      storageAvailable = false;
    }
    const enabled = stored !== "off";
    const parsedVolume = storedVolume?.trim() ? Number(storedVolume) : NaN;
    const volume =
      storedVolume === undefined
        ? snapshot.volume
        : Number.isFinite(parsedVolume) &&
            parsedVolume >= 0 &&
            parsedVolume <= 100
          ? Math.round(parsedVolume)
          : defaultInteractionSoundsVolume;
    if (!enabled || volume === 0) silence();
    publish({ enabled, volume, storageAvailable });
  };

  const canPlay = () =>
    mounted &&
    snapshot.enabled &&
    snapshot.volume > 0 &&
    !document.hidden &&
    !away;

  const schedule = (audio: AudioContext, sound: Sound) => {
    let oscillator: OscillatorNode | undefined;
    let gain: GainNode | undefined;
    let started = false;
    const dispose = () => {
      if (oscillator) {
        oscillator.onended = null;
        if (started) oscillator.stop();
        oscillator.disconnect();
      }
      gain?.disconnect();
      voices.delete(dispose);
    };
    try {
      oscillator = audio.createOscillator();
      gain = audio.createGain();
      const now = audio.currentTime;
      const duration = sound === "click" ? 0.09 : 0.11;
      const peak = (0.2 * snapshot.volume) / 100;
      const [start, end] =
        sound === "on" ? [620, 880] : sound === "off" ? [580, 420] : [760, 520];
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(start, now);
      oscillator.frequency.exponentialRampToValueAtTime(end, now + duration);
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(peak, now + 0.006);
      gain.gain.linearRampToValueAtTime(peak * 0.8, now + 0.024);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      gain.gain.setValueAtTime(0, now + duration + 0.005);
      oscillator.connect(gain);
      gain.connect(audio.destination);
      oscillator.onended = dispose;
      voices.add(dispose);
      oscillator.start(now);
      started = true;
      oscillator.stop(now + duration + 0.008);
    } catch {
      // Audio-device failures must never interrupt the underlying UI action.
      dispose();
      publish({ availability: "blocked" });
      return;
    }
    publish({ availability: "ready" });
  };

  const play = (sound: Sound, event: Event) => {
    if (!event.isTrusted || !canPlay()) return;
    const time = performance.now();
    if (time - lastInteraction < interactionSoundInterval) return;
    lastInteraction = time;
    const revision = ++generation;
    if (!context || context.state === "closed") {
      const Audio = audioConstructor();
      if (!Audio) {
        publish({ availability: "unavailable" });
        return;
      }
      try {
        context = new Audio();
      } catch {
        publish({ availability: "blocked" });
        return;
      }
    }
    const audio = context;
    if (audio.state === "running") {
      schedule(audio, sound);
      return;
    }
    // No sounds are queued in a suspended context or replayed after leaving the page.
    let resuming: Promise<void>;
    try {
      resuming = audio.resume();
    } catch {
      publish({ availability: "blocked" });
      return;
    }
    void resuming.then(
      () => {
        if (
          revision === generation &&
          context === audio &&
          canPlay() &&
          audio.state === "running" &&
          performance.now() - time < interactionSoundInterval
        ) {
          schedule(audio, sound);
        }
      },
      () => {
        if (revision === generation) publish({ availability: "blocked" });
      },
    );
  };

  const onClick = (event: MouseEvent) => {
    const sound = interactionSoundFor(event);
    if (sound) play(sound, event);
  };
  const leave = () => {
    away = true;
    silence();
  };
  const enter = () => {
    away = document.hidden;
  };
  const onVisibility = () => {
    if (document.hidden) leave();
    else enter();
  };
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === interactionSoundsKey ||
      event.key === interactionSoundsVolumeKey ||
      event.key === null
    )
      readPreference();
  };

  const persistPreference = () => {
    let storageAvailable = true;
    try {
      window.localStorage.setItem(
        interactionSoundsKey,
        snapshot.enabled ? "on" : "off",
      );
      window.localStorage.setItem(
        interactionSoundsVolumeKey,
        String(snapshot.volume),
      );
    } catch {
      storageAvailable = false;
    }
    publish({ storageAvailable });
  };

  return {
    subscribe(listener: () => void) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initialSnapshot,
    setEnabled(enabled: boolean, event: Event) {
      if (!enabled) silence();
      publish({ enabled });
      persistPreference();
      if (enabled) play("on", event);
    },
    setVolume(value: number) {
      if (!Number.isFinite(value)) return;
      const volume = Math.max(0, Math.min(100, Math.round(value)));
      if (volume === 0) silence();
      publish({ volume });
      persistPreference();
    },
    preview(event: Event) {
      play("click", event);
    },
    mount() {
      mounted = true;
      away = document.hidden;
      readPreference();
      publish({ availability: audioConstructor() ? "ready" : "unavailable" });
      document.addEventListener("click", onClick, true);
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("blur", leave);
      window.addEventListener("pagehide", leave);
      window.addEventListener("focus", enter);
      window.addEventListener("pageshow", enter);
      window.addEventListener("storage", onStorage);
      return () => {
        mounted = false;
        silence();
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("blur", leave);
        window.removeEventListener("pagehide", leave);
        window.removeEventListener("focus", enter);
        window.removeEventListener("pageshow", enter);
        window.removeEventListener("storage", onStorage);
      };
    },
  };
}
