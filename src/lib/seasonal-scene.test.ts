import { describe, expect, it, vi } from "vitest";
import {
  createMotifs,
  crossfadeSeconds,
  drawScene,
  fireFlicker,
  motifFrame,
  sceneFor,
  sceneLayers,
  type SceneKind,
} from "./seasonal-scene";
import { seasonalThemes } from "./seasonal-theme";

const kinds = Object.keys(sceneLayers) as SceneKind[];
const seeded = () => {
  let value = 0.3;
  return () => (value = (value * 9301 + 49297) % 233280 / 233280);
};
const first = (kind: SceneKind, layer: string) => createMotifs(kind, seeded()).filter((m) => m.layer === layer);

describe("seasonal scene", () => {
  it("gives every theme except the standard one a scene", () => {
    expect(kinds.sort()).toEqual(seasonalThemes.filter((theme) => theme !== "default").sort());
    expect(sceneFor("default")).toBeUndefined();
    for (const theme of seasonalThemes.filter((t) => t !== "default")) expect(sceneFor(theme)).toBe(theme);
  });

  it("cross-fades well under 400 ms", () => {
    expect(crossfadeSeconds).toBeLessThan(0.4);
  });

  it.each(kinds)("%s creates motifs inside sane bounds", (kind) => {
    const motifs = createMotifs(kind, seeded());
    expect(motifs.length).toBeGreaterThan(0);
    expect(motifs.length).toBeLessThanOrEqual(24);
    for (const motif of motifs) {
      for (const t of [0, 3.3, 41]) {
        const frame = motifFrame(motif, t, 1200, 800);
        expect(Number.isFinite(frame.x + frame.y + frame.size + frame.alpha)).toBe(true);
        expect(frame.alpha).toBeGreaterThanOrEqual(0);
        expect(frame.alpha).toBeLessThanOrEqual(1);
      }
    }
  });

  it("snow has three depth bands: near flakes are larger and faster", () => {
    const flakes = first("christmas", "flake");
    expect(new Set(flakes.map((f) => f.depth)).size).toBe(3);
    const far = flakes.find((f) => f.depth === 0.25)!;
    const near = flakes.find((f) => f.depth === 1)!;
    expect(near.speed).toBeGreaterThan(far.speed);
    expect(motifFrame(near, 0, 800, 600).size).toBeGreaterThan(motifFrame(far, 0, 800, 600).size);
  });

  it("bats fly a sine path and only flap occasionally", () => {
    const [bat] = first("halloween", "bat");
    const ys = [0, 1, 2, 3].map((t) => motifFrame(bat, t * 10, 800, 600).y);
    expect(new Set(ys.map((y) => Math.round(y))).size).toBeGreaterThan(1);
    const wings = Array.from({ length: 140 }, (_, i) => motifFrame(bat, i * 0.1, 800, 600).wing);
    expect(wings.filter((wing) => wing === 0.35).length).toBeGreaterThan(wings.length * 0.5);
    expect(wings.some((wing) => wing !== 0.35)).toBe(true);
  });

  it("the fire flicker stays within a warm, bounded range", () => {
    for (let t = 0; t < 30; t += 0.1) {
      expect(fireFlicker(t)).toBeGreaterThanOrEqual(0);
      expect(fireFlicker(t)).toBeLessThanOrEqual(1);
    }
  });

  it("sparks rise and fade out", () => {
    const motif = { layer: "spark" as const, x: 0.5, y: 0, depth: 0.5, speed: 0.1, phase: 0 };
    const early = motifFrame(motif, 0.5, 800, 600);
    const late = motifFrame(motif, 8, 800, 600);
    expect(late.y).toBeLessThan(early.y);
    expect(late.alpha).toBeLessThan(early.alpha);
  });

  it("the summer glow stays over the sidebar", () => {
    const [glow] = first("summer", "glow");
    for (let t = 0; t < 200; t += 5) expect(motifFrame(glow, t, 1400, 900).x).toBeLessThanOrEqual(224);
  });

  function stub() {
    const gradient = { addColorStop: vi.fn() };
    return {
      clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(),
      fill: vi.fn(), moveTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(),
      createRadialGradient: vi.fn(() => gradient), createLinearGradient: vi.fn(() => gradient),
      fillRect: vi.fn(), translate: vi.fn(), globalAlpha: 1, fillStyle: "",
    };
  }

  it.each(kinds)("draws %s with balanced save/restore, pointer and fade", (kind) => {
    const ctx = stub();
    drawScene(ctx as never, kind, createMotifs(kind, seeded()), 0.8, 1200, 800, { accent: "#a16207", ink: "#222" }, { x: 0.5, y: -0.5 }, 0.5);
    expect(ctx.save.mock.calls.length).toBe(ctx.restore.mock.calls.length);
  });

  it("only the new-year scene shines over the sidebar right after loading", () => {
    const colors = { accent: "#a16207", ink: "#222" };
    const early = stub();
    drawScene(early as never, "newyear", [], 0.5, 1200, 800, colors);
    expect(early.createLinearGradient).toHaveBeenCalled();
    const late = stub();
    drawScene(late as never, "newyear", [], 10, 1200, 800, colors);
    expect(late.createLinearGradient).not.toHaveBeenCalled();
  });
});
