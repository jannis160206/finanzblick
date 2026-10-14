"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useSeasonalTheme } from "@/components/seasonal-theme-provider";
import {
  createMotifs,
  crossfadeSeconds,
  drawScene,
  sceneFor,
  type Motif,
  type SceneKind,
} from "@/lib/seasonal-scene";

const frameInterval = 1000 / 30;
const fadeMs = crossfadeSeconds * 1000;

type Playing = { kind: SceneKind; motifs: Motif[]; started: number };
type Leaving = Playing & { left: number };

export function SeasonalScene() {
  const { theme, motionReduced } = useSeasonalTheme();
  const pathname = usePathname();
  const kind = sceneFor(theme);
  // The transaction list stays calm: no scene there.
  const allowed = !motionReduced && !pathname.startsWith("/umsaetze");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const leavingRef = useRef<Leaving | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!allowed || !canvas || !context) return;
    const system = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (system.matches) return;

    const started = performance.now();
    const playing: Playing | null = kind ? { kind, motifs: createMotifs(kind), started } : null;
    const style = getComputedStyle(document.documentElement);
    const colors = {
      accent: style.getPropertyValue("--season-decoration").trim() || "#888888",
      ink: style.getPropertyValue("--foreground").trim() || "#444444",
    };
    const target = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0 };
    let leaving = leavingRef.current && started - leavingRef.current.left < fadeMs ? leavingRef.current : null;
    leavingRef.current = null;
    let width = 0;
    let height = 0;
    let frame = 0;
    let last = 0;
    let stopped = false;

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
      if (now - last < frameInterval) {
        frame = requestAnimationFrame(tick);
        return;
      }
      last = now;
      pointer.x += (target.x - pointer.x) * 0.06;
      pointer.y += (target.y - pointer.y) * 0.06;
      context.clearRect(0, 0, width, height);
      if (leaving) {
        const fade = 1 - (now - leaving.left) / fadeMs;
        if (fade > 0) {
          drawScene(context, leaving.kind, leaving.motifs, (now - leaving.started) / 1000, width, height, colors, pointer, fade);
        } else {
          leaving = null;
        }
      }
      if (playing) {
        const fade = Math.min(1, (now - playing.started) / fadeMs);
        drawScene(context, playing.kind, playing.motifs, (now - playing.started) / 1000, width, height, colors, pointer, fade);
      }
      frame = leaving || playing ? requestAnimationFrame(tick) : 0;
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
    const onPointer = (event: PointerEvent) => {
      target.x = (event.clientX / window.innerWidth) * 2 - 1;
      target.y = (event.clientY / window.innerHeight) * 2 - 1;
    };
    const onSystemChange = () => {
      if (!system.matches) return;
      stopped = true;
      pause();
      context.clearRect(0, 0, width, height);
    };

    resize();
    start();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointer, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    system.addEventListener("change", onSystemChange);
    return () => {
      stopped = true;
      pause();
      if (playing) leavingRef.current = { ...playing, left: performance.now() };
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointer);
      document.removeEventListener("visibilitychange", onVisibility);
      system.removeEventListener("change", onSystemChange);
    };
  }, [allowed, kind]);

  if (!allowed) return null;
  return (
    <canvas
      ref={canvasRef}
      className="season-scene"
      data-season-scene={kind ?? "none"}
      aria-hidden="true"
    />
  );
}
