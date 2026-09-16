import { expect, test } from "@playwright/test";
import { createSeed } from "../src/lib/seed";

for (const pending of [false, true]) test(`accepts a ${pending ? "pending" : "stored"} assignment promptly with 10000 bookings`, async ({ page }) => {
  test.setTimeout(180_000);
  const state = createSeed();
  state.settings.asOf = "2026-09-16";
  state.transactions = Array.from({ length: 10_000 }, (_, index) => ({
    id: `latency-${index}`,
    date: "2026-09-05",
    description: `Testgeschaeft ${index}`,
    amount: -25,
    bank: "Revolut",
    pocket: null,
    category: index < 50 ? "Prüfen" : "Freizeit",
    categoryOverride: index >= 50,
    includeInPlan: index >= 50,
    rawDetails: [`Testgeschaeft ${index}`, "Kartenzahlung EUR", `Referenz TEST-${index}`],
  }));
  state.reviewQueue = pending ? state.transactions.slice(0, 50).map((draft) => ({
    kind: "booking", id: draft.id, draft, message: "Kategorie noch offen oder widersprüchlich.",
  })) : [];
  if (pending) state.transactions = state.transactions.slice(50);
  const expectedCount = state.transactions.length + (pending ? 1 : 0);
  state.fixedReceipts = [];
  state.importStatus = { imported: state.transactions.length, issues: [] };
  await page.addInitScript((state) => {
    if (!localStorage.getItem("finanzdashboard.v1"))
      localStorage.setItem("finanzdashboard.v1", JSON.stringify(state));
  }, state);
  await page.goto("/umsaetze");
  await expect(page.getByText("Lokal gespeichert", { exact: true })).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Zuordnung prüfen", exact: true }).click();
  const section = page.getByRole("region", { name: "Buchung prüfen: Testgeschaeft 0", exact: true });
  await section.getByLabel("Kategorie", { exact: true }).selectOption("Shopping");
  const button = section.getByRole("button", { name: "Zuordnung übernehmen" });
  const profiler = process.env.REVIEW_PROFILE ? await page.context().newCDPSession(page) : undefined;
  if (profiler) {
    await profiler.send("Profiler.enable");
    await profiler.send("Profiler.start");
  }
  await button.evaluate((button) => button.addEventListener("click", () => performance.mark("approval-start"), { once: true }));
  await button.click();
  await expect(section).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Buchung prüfen: Testgeschaeft 1", exact: true })
    .getByLabel("Kategorie", { exact: true })).toBeEnabled();
  const elapsed = await page.evaluate(() => performance.measure("approval-duration", "approval-start").duration);
  console.log(`Click to next ${pending ? "pending" : "stored"} assignment with 10000 bookings: ${elapsed.toFixed(0)} ms`);
  if (profiler) {
    const { profile } = await profiler.send("Profiler.stop");
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const durations = new Map<string, number>();
    profile.samples?.forEach((id, index) => {
      const name = nodes.get(id)?.callFrame.functionName || "(anonymous)";
      durations.set(name, (durations.get(name) ?? 0) + (profile.timeDeltas?.[index] ?? 0));
    });
    console.log([...durations].sort((a, b) => b[1] - a[1]).slice(0, 20)
      .map(([name, time]) => `${(time / 1000).toFixed(0)} ms ${name}`).join("\n"));
    await profiler.detach();
  }
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("finanzdashboard.v1")!);
    return { count: saved.transactions.length, category: saved.transactions.find((row: { id: string }) => row.id === "latency-0").category };
  })).toEqual({ count: expectedCount, category: "Shopping" });
  // Allow development/browser overhead while detecting the former 7-8s rescan.
  expect(elapsed).toBeLessThan(3000);
});
