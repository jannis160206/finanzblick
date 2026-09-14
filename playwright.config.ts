import { defineConfig } from "@playwright/test";

const production = process.env.PLAYWRIGHT_PRODUCTION === "1";
const baseURL = production ? "http://127.0.0.1:3100" : "http://localhost:3000";

export default defineConfig({
  testDir: "./tests",
  workers: 1,
  // Multi-page acceptance includes full reloads of the local Excel start data.
  timeout: production ? 180_000 : 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL,
    channel: process.platform === "win32" ? "msedge" : undefined,
    headless: process.platform !== "win32",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: production ? "npm run start -- --port 3100" : "npm run dev",
    url: baseURL,
    reuseExistingServer: !production,
    timeout: 180_000,
  },
});
