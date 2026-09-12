import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: "http://localhost:3000",
    channel: process.platform === "win32" ? "msedge" : undefined,
    headless: process.platform !== "win32",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
