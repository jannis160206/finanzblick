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
    for (const shortcut of data.shortcuts ?? [])
      for (const icon of shortcut.icons ?? []) expect(existsSync(`src/app${icon.src}`)).toBe(true);
  });
  it("provides raster and maskable icons plus shortcuts to the main areas", () => {
    expect(data.id).toBe("/");
    expect(data.icons).toEqual(expect.arrayContaining([
      expect.objectContaining({ sizes: "192x192", type: "image/png" }),
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    ]));
    expect(data.shortcuts?.map((shortcut) => shortcut.url)).toEqual(["/umsaetze", "/budget", "/sparen"]);
  });
  it("offers colors for light and dark themes", () => {
    expect(viewport.themeColor).toEqual([
      expect.objectContaining({ media: "(prefers-color-scheme: light)", color: "#f5f7f6" }),
      expect.objectContaining({ media: "(prefers-color-scheme: dark)", color: "#101313" }),
    ]);
  });
  it("ships a notification-only service worker without offline caching", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    expect(existsSync("public/sw.js")).toBe(true);
    const worker = readFileSync("public/sw.js", "utf8");
    expect(worker).toContain("notificationclick");
    expect(worker).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(existsSync("src/app/sw.ts")).toBe(false);
  });
});
