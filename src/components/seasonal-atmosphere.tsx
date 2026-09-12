"use client";

import { useSyncExternalStore, type CSSProperties } from "react";
import { useSeasonalTheme } from "@/components/seasonal-theme-provider";

function subscribeMotion(notify: () => void) {
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
}
function subscribeVisibility(notify: () => void) {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
}
const reducedSnapshot = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const hiddenSnapshot = () => document.hidden;
const serverSnapshot = () => true;

function Particles({ placement }: { placement: "header" | "shell" }) {
  const reduced = useSyncExternalStore(
    subscribeMotion,
    reducedSnapshot,
    serverSnapshot,
  );
  const hidden = useSyncExternalStore(
    subscribeVisibility,
    hiddenSnapshot,
    serverSnapshot,
  );
  if (reduced) return null;
  return (
    <div
      aria-hidden="true"
      className={`seasonal-atmosphere seasonal-particles seasonal-${placement}`}
      data-atmosphere={placement}
      data-paused={hidden}
    >
      {[8, 21, 37, 49, 63, 76, 89, 96].map((left, index) => (
        <span
          key={left}
          style={
            {
              "--particle-x": `${left}%`,
              "--particle-duration": `${19 + index * 3}s`,
              "--particle-delay": `${-index * 5}s`,
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

export function SeasonalAtmosphere({
  placement,
}: {
  placement: "hero" | "header" | "shell";
}) {
  const { theme } = useSeasonalTheme();
  if (theme === "default") return null;
  if (placement === "hero") {
    return (
      <div
        aria-hidden="true"
        className="seasonal-atmosphere seasonal-hero-light"
        data-atmosphere="hero"
      />
    );
  }
  if (
    (placement === "header" && theme === "halloween") ||
    (placement === "shell" && theme === "christmas")
  ) {
    return <Particles placement={placement} />;
  }
  return null;
}
