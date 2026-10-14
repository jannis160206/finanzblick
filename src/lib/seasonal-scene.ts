import type { SeasonalTheme } from "@/lib/seasonal-theme";

export type SceneKind = "bats" | "snow" | "sparks" | "glow";

export const sceneByTheme: Partial<Record<SeasonalTheme, SceneKind>> = {
  halloween: "bats",
  christmas: "snow",
  newyear: "sparks",
  summer: "glow",
};

export const motifCount: Record<SceneKind, number> = {
  bats: 9,
  snow: 12,
  sparks: 10,
  glow: 1,
};

export const sidebarWidth = 224;

export type Motif = {
  /** 0..1 horizontal / vertical anchor. */
  x: number;
  y: number;
  /** 0..1, larger is nearer (snow) or stronger (sparks). */
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

export function createMotifs(kind: SceneKind, random: () => number = Math.random): Motif[] {
  return Array.from({ length: motifCount[kind] }, (_, index) => {
    const depth = kind === "snow" ? 0.25 + 0.75 * (index / (motifCount[kind] - 1)) : random();
    const speed =
      kind === "bats" ? 0.018 + random() * 0.014
      : kind === "snow" ? 0.02 + depth * 0.05
      : kind === "sparks" ? 0.05 + random() * 0.06
      : 0.012;
    return { x: random(), y: random(), depth, speed, phase: random() };
  });
}

const fract = (value: number) => value - Math.floor(value);

/** Pure path of one motif at time `t` seconds inside a `width` x `height` area. */
export function motifFrame(kind: SceneKind, motif: Motif, t: number, width: number, height: number): MotifFrame {
  const progress = fract(motif.phase + t * motif.speed);
  const margin = 40;
  if (kind === "bats") {
    const flapCycle = fract((t + motif.phase * 9) / 7);
    const flapping = flapCycle < 0.22;
    return {
      x: -margin + progress * (width + margin * 2),
      y: height * (0.1 + 0.5 * motif.y) + Math.sin(progress * Math.PI * 2 * 3 + motif.phase * 6) * (18 + 24 * motif.depth),
      size: 9 + motif.depth * 9,
      alpha: 0.16 + motif.depth * 0.12,
      wing: flapping ? 0.5 + 0.5 * Math.sin(t * 16 + motif.phase * 6) : 0.35,
    };
  }
  if (kind === "snow") {
    return {
      x: motif.x * width + Math.sin(t * (0.5 + motif.depth) + motif.phase * 6.28) * 22 * motif.depth,
      y: -margin + progress * (height + margin * 2),
      size: 1.5 + motif.depth * 3.5,
      alpha: 0.3 + motif.depth * 0.45,
      wing: 0,
    };
  }
  if (kind === "sparks") {
    return {
      x: motif.x * width + Math.sin(progress * 9 + motif.phase * 6.28) * 14,
      y: height - progress * height * (0.45 + 0.3 * motif.depth),
      size: 1 + motif.depth * 2,
      alpha: Math.max(0, 1 - progress) ** 1.6 * 0.8,
      wing: 0,
    };
  }
  const reach = Math.min(width, sidebarWidth);
  return {
    x: reach * (0.5 + 0.35 * Math.sin(progress * Math.PI * 2)),
    y: height * (0.15 + 0.7 * progress),
    size: 190,
    alpha: 0.32 * Math.sin(progress * Math.PI),
    wing: 0,
  };
}

type Ctx = Pick<
  CanvasRenderingContext2D,
  | "clearRect" | "save" | "restore" | "beginPath" | "arc" | "fill" | "moveTo" | "quadraticCurveTo"
  | "closePath" | "createRadialGradient" | "fillRect" | "translate" | "globalAlpha" | "fillStyle"
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

export function drawScene(
  ctx: Ctx,
  kind: SceneKind,
  motifs: readonly Motif[],
  t: number,
  width: number,
  height: number,
  colors: SceneColors,
) {
  ctx.clearRect(0, 0, width, height);
  for (const motif of motifs) {
    const frame = motifFrame(kind, motif, t, width, height);
    if (frame.alpha <= 0.005) continue;
    ctx.save();
    ctx.globalAlpha = Math.min(1, frame.alpha);
    if (kind === "glow") {
      const gradient = ctx.createRadialGradient(frame.x, frame.y, 0, frame.x, frame.y, frame.size);
      gradient.addColorStop(0, colors.accent);
      gradient.addColorStop(1, "transparent");
      ctx.fillStyle = gradient;
      ctx.fillRect(frame.x - frame.size, frame.y - frame.size, frame.size * 2, frame.size * 2);
    } else if (kind === "bats") {
      ctx.fillStyle = colors.ink;
      ctx.translate(frame.x, frame.y);
      drawBat(ctx, frame);
    } else {
      ctx.fillStyle = colors.accent;
      ctx.beginPath();
      ctx.arc(frame.x, frame.y, frame.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}
