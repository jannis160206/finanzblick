import type { SeasonalTheme } from "@/lib/seasonal-theme";

export type SceneKind = Exclude<SeasonalTheme, "default">;
export type MotifLayer =
  | "bat" | "fog" | "flake" | "spark" | "veil" | "light" | "glow" | "haze" | "frost" | "mote";

export function sceneFor(theme: SeasonalTheme): SceneKind | undefined {
  return theme === "default" ? undefined : theme;
}

export const sceneLayers: Record<SceneKind, ReadonlyArray<readonly [MotifLayer, number]>> = {
  halloween: [["fog", 5], ["bat", 9]],
  christmas: [["flake", 15]],
  newyear: [["spark", 12]],
  carnival: [["veil", 4]],
  easter: [["light", 14]],
  summer: [["haze", 3], ["glow", 1]],
  betweenyears: [["frost", 10], ["mote", 8]],
};

export const sidebarWidth = 224;
/** Seconds a replaced scene needs to fade out while the new one fades in. */
export const crossfadeSeconds = 0.3;
/** Seconds the new-year shine needs to sweep the sidebar after loading. */
export const shineSeconds = 1.6;

export type Motif = {
  layer: MotifLayer;
  /** 0..1 anchors. */
  x: number;
  y: number;
  /** 0..1, larger is nearer (snow) or stronger. */
  depth: number;
  /** Full cycles per second. */
  speed: number;
  phase: number;
};

export type MotifFrame = {
  x: number;
  y: number;
  size: number;
  alpha: number;
  /** Wing opening 0..1, bats only. */
  wing: number;
};

export type SceneColors = { accent: string; ink: string };
export type Pointer = { x: number; y: number };

const fract = (value: number) => value - Math.floor(value);
const tau = Math.PI * 2;

export function createMotifs(kind: SceneKind, random: () => number = Math.random): Motif[] {
  return sceneLayers[kind].flatMap(([layer, count]) =>
    Array.from({ length: count }, (_, index) => {
      // Snow sits in three depth bands: far, middle, near.
      const depth = layer === "flake" ? [0.25, 0.6, 1][index % 3] : random();
      const speed =
        layer === "bat" ? 0.018 + random() * 0.014
        : layer === "flake" ? 0.012 + depth * 0.05
        : layer === "spark" ? 0.05 + random() * 0.06
        : layer === "fog" ? 0.006 + random() * 0.006
        : layer === "veil" ? 0.01 + random() * 0.008
        : layer === "glow" ? 0.012
        : layer === "haze" ? 0.008
        : 0.01 + random() * 0.02;
      return { layer, x: random(), y: random(), depth, speed, phase: random() };
    }),
  );
}

/** Pure path of one motif at `t` seconds inside a `width` x `height` area. */
export function motifFrame(motif: Motif, t: number, width: number, height: number): MotifFrame {
  const progress = fract(motif.phase + t * motif.speed);
  const margin = 60;
  const frame = (x: number, y: number, size: number, alpha: number, wing = 0): MotifFrame => ({ x, y, size, alpha, wing });
  switch (motif.layer) {
    case "bat": {
      const flapping = fract((t + motif.phase * 9) / 7) < 0.22;
      return frame(
        -40 + progress * (width + 80),
        height * (0.1 + 0.5 * motif.y) + Math.sin(progress * tau * 3 + motif.phase * 6) * (18 + 24 * motif.depth),
        9 + motif.depth * 9,
        0.16 + motif.depth * 0.12,
        flapping ? 0.5 + 0.5 * Math.sin(t * 16 + motif.phase * 6) : 0.35,
      );
    }
    case "fog":
      return frame(
        -margin * 2 + progress * (width + margin * 4),
        height * (0.55 + 0.4 * motif.y),
        220 + motif.depth * 160,
        0.07 + 0.05 * Math.sin(t * 0.3 + motif.phase * tau) ** 2,
      );
    case "flake":
      return frame(
        motif.x * width + Math.sin(t * (0.5 + motif.depth) + motif.phase * tau) * 22 * motif.depth,
        -margin + progress * (height + margin * 2),
        1.5 + motif.depth * 3.5,
        0.3 + motif.depth * 0.45,
      );
    case "spark":
      return frame(
        motif.x * width + Math.sin(progress * 9 + motif.phase * tau) * 14,
        height - progress * height * (0.45 + 0.3 * motif.depth),
        1 + motif.depth * 2,
        Math.max(0, 1 - progress) ** 1.6 * 0.8,
      );
    case "veil":
      return frame(
        width * (0.1 + 0.8 * motif.x) + Math.sin(t * 0.08 + motif.phase * tau) * width * 0.18,
        height * (0.15 + 0.7 * fract(motif.y + t * motif.speed * 0.5)),
        Math.max(width, height) * (0.28 + 0.2 * motif.depth),
        0.05 + 0.04 * Math.sin(t * 0.2 + motif.phase * tau) ** 2,
      );
    case "light":
      return frame(
        width * fract(motif.x + Math.sin(t * motif.speed + motif.phase * tau) * 0.05),
        height * fract(motif.y - t * motif.speed * 0.25),
        2 + motif.depth * 3,
        0.25 + 0.35 * Math.sin(t * (0.6 + motif.depth) + motif.phase * tau) ** 2,
      );
    case "haze":
      return frame(
        width * (0.2 + 0.6 * motif.x) + Math.sin(t * 0.05 + motif.phase * tau) * 80,
        height * (0.7 + 0.25 * motif.y),
        260 + motif.depth * 140,
        0.07 + 0.03 * Math.sin(t * 0.25 + motif.phase * tau),
      );
    case "frost":
      return frame(
        motif.x * width,
        motif.y * height,
        2 + motif.depth * 3,
        0.5 * Math.max(0, Math.sin(t * (0.8 + motif.depth) + motif.phase * tau)) ** 3,
      );
    case "mote":
      return frame(
        motif.x * width + Math.sin(t * 0.3 + motif.phase * tau) * 30,
        height - progress * (height + margin),
        1.5 + motif.depth * 2,
        0.25 * Math.sin(progress * Math.PI),
      );
    case "glow":
      return frame(
        Math.min(width, sidebarWidth) * (0.5 + 0.35 * Math.sin(progress * tau)),
        height * (0.15 + 0.7 * progress),
        190,
        0.32 * Math.sin(progress * Math.PI),
      );
  }
}

type Ctx = Pick<
  CanvasRenderingContext2D,
  | "clearRect" | "save" | "restore" | "beginPath" | "arc" | "fill" | "moveTo"
  | "quadraticCurveTo" | "closePath" | "createRadialGradient" | "createLinearGradient"
  | "fillRect" | "translate" | "globalAlpha" | "fillStyle"
>;

function drawBat(ctx: Ctx, frame: MotifFrame) {
  const { size: s, wing } = frame;
  const lift = -s * (0.2 + wing * 0.7);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-s * 0.5, lift, -s * 1.5, lift * 0.4 + s * 0.1);
  ctx.quadraticCurveTo(-s * 1.05, s * 0.2, -s * 0.8, s * 0.4);
  ctx.quadraticCurveTo(-s * 0.4, s * 0.1, 0, s * 0.45);
  ctx.quadraticCurveTo(s * 0.4, s * 0.1, s * 0.8, s * 0.4);
  ctx.quadraticCurveTo(s * 1.05, s * 0.2, s * 1.5, lift * 0.4 + s * 0.1);
  ctx.quadraticCurveTo(s * 0.5, lift, 0, 0);
  ctx.closePath();
  ctx.fill();
}

function softSpot(ctx: Ctx, x: number, y: number, radius: number, color: string) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, "transparent");
  ctx.fillStyle = gradient;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

const warm = "#ff9a3c";

/** Warm, uneven flicker as if a fire burned just outside the frame (0..1). */
export function fireFlicker(t: number): number {
  return 0.5 + 0.25 * Math.sin(t * 7.3) + 0.15 * Math.sin(t * 13.1 + 1.7) + 0.1 * Math.sin(t * 29 + 0.4);
}

/** Draws one scene; `fade` (0..1) scales its opacity for cross-fading. Does not clear. */
export function drawScene(
  ctx: Ctx,
  kind: SceneKind,
  motifs: readonly Motif[],
  t: number,
  width: number,
  height: number,
  colors: SceneColors,
  pointer: Pointer = { x: 0, y: 0 },
  fade = 1,
) {
  if (kind === "halloween") {
    ctx.save();
    ctx.globalAlpha = fade * (0.1 + 0.1 * fireFlicker(t));
    softSpot(ctx, 0, height, Math.max(width, height) * 0.55, warm);
    ctx.restore();
  }
  if (kind === "newyear" && t < shineSeconds) {
    const sweep = t / shineSeconds;
    const edge = sidebarWidth * (sweep * 1.6 - 0.3);
    const band = ctx.createLinearGradient(edge - 70, 0, edge + 70, 0);
    band.addColorStop(0, "transparent");
    band.addColorStop(0.5, colors.accent);
    band.addColorStop(1, "transparent");
    ctx.save();
    ctx.globalAlpha = fade * 0.35 * Math.sin(sweep * Math.PI);
    ctx.fillStyle = band;
    ctx.fillRect(0, 0, sidebarWidth, height);
    ctx.restore();
  }
  for (const motif of motifs) {
    const frame = motifFrame(motif, t, width, height);
    const alpha = frame.alpha * fade;
    if (alpha <= 0.004) continue;
    const parallax = (motif.depth - 0.5) * 24;
    const x = frame.x + pointer.x * parallax;
    const y = frame.y + pointer.y * parallax * 0.6;
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha);
    switch (motif.layer) {
      case "bat":
        ctx.fillStyle = colors.ink;
        ctx.translate(x, y);
        drawBat(ctx, frame);
        break;
      case "fog":
      case "veil":
      case "glow":
        softSpot(ctx, x, y, frame.size, colors.accent);
        break;
      case "haze":
        softSpot(ctx, x, y, frame.size, warm);
        break;
      case "frost":
        ctx.fillStyle = colors.accent;
        ctx.fillRect(x - frame.size, y - 0.5, frame.size * 2, 1);
        ctx.fillRect(x - 0.5, y - frame.size, 1, frame.size * 2);
        break;
      default:
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.arc(x, y, frame.size, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.restore();
  }
}
