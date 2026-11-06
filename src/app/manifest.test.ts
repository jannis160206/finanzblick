import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { appViewport as viewport } from "@/lib/viewport";

describe("web app manifest", () => {
  const data = manifest();
  it("is installable as a standalone app", () => {
    expect(data.display).toBe("standalone");
    expect(data.name).toBeTruthy();
    expect(data.short_name).toBe("Finanzblick");
    expect(data.start_url).toBe("/");
    expect(data.icons?.length).toBeGreaterThan(0);
  });
  it("only references icons that exist as app routes", async () => {
    const { existsSync } = await import("node:fs");
    for (const icon of data.icons ?? []) expect(existsSync(`src/app${icon.src}`)).toBe(true);
  });
  it("offers colors for light and dark themes", () => {
    expect(viewport.themeColor).toEqual([
      expect.objectContaining({ media: "(prefers-color-scheme: light)", color: "#f5f7f6" }),
      expect.objectContaining({ media: "(prefers-color-scheme: dark)", color: "#101313" }),
    ]);
  });
  it("does not ship a service worker", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync("public/sw.js")).toBe(false);
    expect(existsSync("src/app/sw.ts")).toBe(false);
  });
});
