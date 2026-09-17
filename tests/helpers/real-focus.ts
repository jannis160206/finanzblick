import { spawn } from "node:child_process";
import path from "node:path";
import { chromium, expect, test as base, type Browser, type BrowserContext } from "@playwright/test";

// A separate disposable profile avoids Playwright's always-focused page emulation.
export const focusTest = base.extend<{ focusContext: BrowserContext }>({
  focusContext: async ({ browserName }, runFixture, testInfo) => {
    expect(browserName).toBe("chromium");
    const executable = process.platform === "win32"
      ? path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")
      : chromium.executablePath();
    const child = spawn(executable, [
      `--user-data-dir=${testInfo.outputPath("focus-profile")}`,
      "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
      "--disable-sync", "--disable-extensions", "--no-sandbox", "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let browser: Browser | undefined;
    const focusEvents: unknown[] = [];
    try {
      const endpoint = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error(`Focus browser did not start: ${output}`)), 30_000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Focus browser exited (${code}): ${output}`));
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-8000);
          const endpoint = /DevTools listening on (ws:\/\/[^\s]+)/.exec(output)?.[1];
          if (endpoint) { clearTimeout(timer); resolve(endpoint); }
        });
      });
      browser = await chromium.connectOverCDP(endpoint, { noDefaults: true });
      const context = browser.contexts()[0];
      context.on("page", (page) => {
        page.on("pageerror", (error) => focusEvents.push({ page: page.url(), error: error.message }));
      });
      await context.exposeBinding("__recordNativeFocus", ({ page }, event) => {
        focusEvents.push({ page: page.url(), ...event });
      });
      await context.addInitScript(() => {
        const record = (event: Event) => {
          queueMicrotask(() => {
            const recorder = (window as unknown as {
              __recordNativeFocus: (entry: unknown) => Promise<void>;
            }).__recordNativeFocus;
            void recorder({
              type: event.type, trusted: event.isTrusted, time: Date.now(),
              focused: document.hasFocus(), visibility: document.visibilityState,
              security: document.documentElement?.dataset.securityMode,
            });
          });
        };
        window.addEventListener("focus", record);
        window.addEventListener("blur", record);
        document.addEventListener("visibilitychange", record);
      });
      await runFixture(context);
    } finally {
      try {
        await testInfo.attach("native-focus-events", {
          body: JSON.stringify(focusEvents, null, 2), contentType: "application/json",
        });
        await browser?.close();
      } finally {
        if (child.exitCode === null) child.kill();
      }
    }
  },
});
