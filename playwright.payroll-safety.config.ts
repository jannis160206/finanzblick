import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["payslip-safety.spec.ts", "restoration-safety.spec.ts"],
  fullyParallel: true,
  workers: 1,
  reporter: "list",
  use: { browserName: "chromium", channel: process.platform === "win32" ? "msedge" : undefined, headless: process.platform !== "win32", trace: "off" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1280, height: 900 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
});
