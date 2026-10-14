import { describe, expect, it, vi } from "vitest";
import {
  createMotifs,
  drawScene,
  motifCount,
  motifFrame,
  sceneByTheme,
  type SceneKind,
} from "./seasonal-scene";
import { seasonalThemes } from "./seasonal-theme";

const kinds: SceneKind[] = ["bats", "snow", "sparks", "glow"];
const seeded = () => {
  let value = 0.3;
  return () => (value = (value * 9301 + 49297) % 233280 / 233280);
};

describe("seasonal scene", () => {
  it("maps only the four scene themes", () => {
    expect(Object.keys(sceneByTheme).sort()).toEqual(["christmas", "halloween", "newyear", "summer"]);
    for (const theme of Object.keys(sceneByTheme)) expect(seasonalThemes).toContain(theme);
  });

  it.each(kinds)("%s creates the planned number of motifs (max 12)", (kind) => {
    const motifs = createMotifs(kind, seeded());
    expect(motifs).toHaveLength(motifCount[kind]);
    expect(motifs.length).toBeLessThanOrEqual(12);
  });

  it("snow is staggered in depth: near flakes are larger and faster", () => {
    const motifs = createMotifs("snow", seeded());
    const far = motifs[0];
    const near = motifs[motifs.length - 1];
    expect(near.speed).toBeGreaterThan(far.speed);
    expect(motifFrame("snow", near, 0, 800, 600).size).toBeGreaterThan(motifFrame("snow", far, 0, 800, 600).size);
  });

  it("bats fly a sine path and only flap occasionally", () => {
    const [bat] = createMotifs("bats", seeded());
    const ys = [0, 1, 2, 3].map((t) => motifFrame("bats", bat, t * 10, 800, 600).y);
    expect(new Set(ys.map((y) => Math.round(y))).size).toBeGreaterThan(1);
    const wings = Array.from({ length: 140 }, (_, i) => motifFrame("bats", bat, i * 0.1, 800, 600).wing);
    expect(wings.filter((wing) => wing === 0.35).length).toBeGreaterThan(wings.length * 0.5);
    expect(wings.some((wing) => wing !== 0.35)).toBe(true);
  });

  it("sparks rise and fade out", () => {
    const motif = { x: 0.5, y: 0, depth: 0.5, speed: 0.1, phase: 0 };
    const early = motifFrame("sparks", motif, 0.5, 800, 600);
    const late = motifFrame("sparks", motif, 8, 800, 600);
    expect(late.y).toBeLessThan(early.y);
    expect(late.alpha).toBeLessThan(early.alpha);
  });

  it("the summer glow stays over the sidebar", () => {
    const [glow] = createMotifs("glow", seeded());
    for (let t = 0; t < 200; t += 5) {
      expect(motifFrame("glow", glow, t, 1400, 900).x).toBeLessThanOrEqual(224);
    }
  });

  it.each(kinds)("draws %s without throwing onto a stub context", (kind) => {
    const gradient = { addColorStop: vi.fn() };
    const ctx = {
      clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(),
      fill: vi.fn(), moveTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(),
      createRadialGradient: vi.fn(() => gradient), fillRect: vi.fn(), translate: vi.fn(),
      globalAlpha: 1, fillStyle: "",
    };
    drawScene(ctx as never, kind, createMotifs(kind, seeded()), 12.5, 1200, 800, { accent: "#a16207", ink: "#222" });
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 1200, 800);
    expect(ctx.save.mock.calls.length).toBe(ctx.restore.mock.calls.length);
  });
});
