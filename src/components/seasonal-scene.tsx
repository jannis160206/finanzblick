"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useSeasonalTheme } from "@/components/seasonal-theme-provider";
import { createMotifs, drawScene, sceneByTheme } from "@/lib/seasonal-scene";

const frameInterval = 1000 / 30;

export function SeasonalScene() {
  const { theme, motionReduced } = useSeasonalTheme();
  const pathname = usePathname();
  const kind = sceneByTheme[theme];
  // The transaction list stays calm: no scene there.
  const active = kind !== undefined && !motionReduced && !pathname.startsWith("/umsaetze");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!active || !kind || !canvas || !context) return;
    const system = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (system.matches) return;

    const motifs = createMotifs(kind);
    const style = getComputedStyle(document.documentElement);
    const colors = {
      accent: style.getPropertyValue("--season-decoration").trim() || "#888888",
      ink: style.getPropertyValue("--foreground").trim() || "#444444",
    };
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = 0;
    let stopped = false;
    const started = performance.now();

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const tick = (now: number) => {
      if (stopped) return;
      frame = requestAnimationFrame(tick);
      if (now - last < frameInterval) return;
      last = now;
      drawScene(context, kind, motifs, (now - started) / 1000, width, height, colors);
    };
    const start = () => {
      if (stopped || frame) return;
      frame = requestAnimationFrame(tick);
    };
    const pause = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const onVisibility = () => (document.hidden ? pause() : start());
    const stop = () => {
      stopped = true;
      pause();
      context.clearRect(0, 0, canvas.width, canvas.height);
    };
    const onSystemChange = () => {
      if (system.matches) stop();
    };

    resize();
    start();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibility);
    system.addEventListener("change", onSystemChange);
    return () => {
      stop();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      system.removeEventListener("change", onSystemChange);
    };
  }, [active, kind]);

  if (!active) return null;
  return (
    <canvas
      ref={canvasRef}
      className="season-scene"
      data-season-scene={kind}
      aria-hidden="true"
    />
  );
}
