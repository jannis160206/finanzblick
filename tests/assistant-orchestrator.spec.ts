import { expect, test, type Page } from "@playwright/test";
import { SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";
import { payrollFixture } from "./fixtures/payroll-state";

// Nur synthetische Daten. Die Pläne des Supervisors, die Antworten und die Folgefragen der KI sind gemockt; die Werkzeuge laufen echt.
const storageKey = "finanzdashboard.v1";

async function prepare(page: Page, width: number, theme: "light" | "dark") {
  await page.clock.setFixedTime(new Date("2026-10-15T12:00:00Z"));
  await page.setViewportSize({ width, height: width < 768 ? 812 : 1000 });
  // Follow-up questions from DeepSeek: two for the Bitcoin answer; otherwise unavailable, so the fixed suggestions stay.
  await page.route("**/api/ai/follow-ups", (route) => /Bitcoin/.test(route.request().postData() ?? "")
    ? route.fulfill({ json: { suggestions: ["Wie viel Bitcoin wäre vertretbar?", "Was ist ein ETF?"], models: [{ provider: "deepseek", model: "deepseek-flash", task: "suggest" }] } })
    : route.fulfill({ status: 503, json: { error: "DeepSeek: nicht eingerichtet." } }));
  await page.addInitScript(({ key, json, theme, activation }) => {
    localStorage.setItem("theme", theme);
    localStorage.setItem(activation, "off");
    if (!localStorage.getItem(key)) localStorage.setItem(key, json);
  }, { key: storageKey, json: JSON.stringify(payrollFixture()), theme, activation: SECURITY_ACTIVATION_KEY });
}

async function ask(page: Page, text: string) {
  const input = page.getByLabel("Nachricht an den Finanz-Assistenten", { exact: true });
  await input.fill(text);
  await input.press("Enter");
}

test.describe("assistant orchestrator", () => {
  test.skip(process.env.FINANZBLICK_AUTH === "true", "Seeds the browser-mode store.");

  for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
    test(`lets the supervisor answer every question with the droid and lays out the results at ${width}px (${theme})`, async ({ page }, testInfo) => {
      await prepare(page, width, theme);
      // The supervisor's plans are mocked (DeepSeek V4 Pro decides them in production); the workers run the real tools on synthetic data.
      const plans: Record<string, object> = {
        "Hallo": { agent: "general", steps: [] },
        "Was hältst du von Bitcoin?": { agent: "general", steps: [] },
        "Wie viel netto bekomme ich?": { agent: "payroll", steps: [{ tool: "payroll", question: "Wie viel netto bekomme ich?" }] },
        "Wird mein Konto knapp?": { agent: "budget", steps: [{ tool: "forecast", question: "Wird mein Konto knapp?" }] },
      };
      const routed: { message: string; overview?: Record<string, unknown> }[] = [];
      await page.route("**/api/ai/assistant", async (route) => {
        const body = route.request().postDataJSON() as { message: string; overview?: Record<string, unknown> };
        routed.push(body);
        await route.fulfill({ json: { ...plans[body.message], via: "supervisor", supervised: true, source: "KI",
          models: [{ provider: "deepseek", model: "deepseek-v4-pro", task: "supervise" }] } });
      });
      const answers: { question: string; agent?: string; facts?: Record<string, unknown>; evidence?: string; supervised?: boolean }[] = [];
      const replies: Record<string, string> = {
        "Hallo": "Hallo! Schön, dass du da bist.",
        "Was hältst du von Bitcoin?": "Spannend, aber ziemlich schwankend. Nur mit Geld, das du länger nicht brauchst.",
        "Wie viel netto bekomme ich?": "Du bekommst 2.780 € netto im Monat.",
        "Wird mein Konto knapp?": "Ja, dein Girokonto wird knapp.\n\nPlan die Sparrate erst nach dem Gehalt ein.",
      };
      await page.route("**/api/ai/answer**", async (route) => {
        const body = route.request().postDataJSON() as (typeof answers)[number];
        answers.push(body);
        const text = replies[body.question] ?? "Okay.";
        await route.fulfill({ contentType: "application/x-ndjson; charset=utf-8",
          body: [{ model: { provider: "deepseek", model: "deepseek-v4-pro", task: "synthesize" } }, { delta: text.slice(0, 6) }, { done: true, ok: true, text }]
            .map((event) => JSON.stringify(event)).join("\n") + "\n" });
      });
      await page.goto("/");
      await page.getByRole("button", { name: /^Finanz-Assistent öffnen/ }).click();
      const chat = page.getByRole("region", { name: "Chat mit dem Finanz-Assistenten" });

      // Even small talk goes to the supervisor and DeepSeek writes the answer; no fixed reply.
      await ask(page, "Hallo");
      await expect(chat.getByText("Hallo! Schön, dass du da bist.")).toBeVisible();
      // The supervisor sees an overview of the user's data: amounts, accounts and bookings, but no IBAN.
      expect(Object.keys(routed[0].overview ?? {})).toEqual(expect.arrayContaining(["accounts", "thisMonth", "budgets", "subscriptions", "goals", "recentBookings"]));
      expect(JSON.stringify(routed[0].overview)).not.toMatch(/\bAT\d{2}(?: ?\d{4}){4}/);

      // Nothing about own money: the general chat sees no personal facts.
      await ask(page, "Was hältst du von Bitcoin?");
      await expect(chat.getByText("Spannend, aber ziemlich schwankend. Nur mit Geld, das du länger nicht brauchst.")).toBeVisible();
      expect(answers.at(-1)).toMatchObject({ agent: "general", supervised: true });
      expect(Object.keys(answers.at(-1)?.facts ?? {})).toEqual(["today"]);
      await expect(chat.locator('[data-model="deepseek-v4-pro"]').last()).toHaveText("DeepSeek V4 Pro");
      await expect(chat.getByRole("group", { name: "Vorschläge von DeepSeek" }).getByRole("button")).toHaveText(["Wie viel Bitcoin wäre vertretbar?", "Was ist ein ETF?"]);

      // The payroll tool returns raw data; the supervisor writes the words, the result is a tile below.
      await ask(page, "Wie viel netto bekomme ich?");
      await expect(chat.getByText("Du bekommst 2.780 € netto im Monat.")).toBeVisible();
      expect(answers.at(-1)?.evidence).toMatch(/^Rohdaten der Spezialisten[\s\S]*\[Gehaltsübersicht\] Wie viel netto bekomme ich\?/);
      const payroll = chat.getByRole("list", { name: "Ergebnisse" }).last().getByRole("article", { name: /^Gehalt · / });
      await expect(payroll).toBeVisible();
      await payroll.getByRole("button", { name: "Details" }).click();
      await expect(payroll.getByText(/^Nächste Sonderzahlung/)).toBeVisible();

      // A forecast: key figures as badges, the trend as a sparkline, the key statement first.
      await ask(page, "Wird mein Konto knapp?");
      await expect(chat.getByText("Ja, dein Girokonto wird knapp.")).toBeVisible();
      await expect(chat.getByRole("list", { name: "Kennzahlen" }).last()).toBeVisible();
      await expect(chat.getByRole("img", { name: /^Verlauf / }).last()).toBeVisible();

      // Only the droid, and which specialist worked stays internal.
      const bots = await chat.locator("[data-bot-avatar]").evaluateAll((items) => [...new Set(items.map((item) => item.getAttribute("data-bot-avatar")))]);
      expect(bots).toEqual(["droid"]);
      const signatures = await chat.locator("[data-model]").allInnerTexts();
      expect(signatures.length).toBeGreaterThan(0);
      expect(signatures.filter((label) => /Gehalt & Steuern|Budget & Prognose|Umsätze|Verträge/.test(label))).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      await page.screenshot({ path: testInfo.outputPath(`assistant-${width}-${theme}.png`) });
    });
  }

  test("takes a new command after a name question as its own and saves a contract after a plain No", async ({ page }) => {
    await prepare(page, 1440, "light");
    await page.goto("/");
    await page.getByRole("button", { name: /^Finanz-Assistent öffnen/ }).click();
    const chat = page.getByRole("region", { name: "Chat mit dem Finanz-Assistenten" });

    // "Motorrad ist erreicht" after "Welches meinst du?" completes the goal; it does not pick a name for the earlier delete.
    await ask(page, "lösch mein sparziel Gibtsnicht");
    await expect(chat.getByText(/„Gibtsnicht“ finde ich nicht/)).toBeVisible();
    await ask(page, "Motorrad ist erreicht");
    await expect(chat.getByText(/„Motorrad“ als erreicht markieren/).first()).toBeVisible();
    await expect(chat.getByText(/Sparziel „Motorrad“ löschen/)).toHaveCount(0);

    // A plain "Nein" under the contract preview asks what to change; the following "Ja" still saves it.
    await ask(page, "Abbrechen");
    await ask(page, "neuer vertrag fitness park 39 € monatlich");
    await expect(chat.getByText(/^In welche Kategorie gehört „Fitness Park“/)).toBeVisible();
    // A full sentence that answers the open step stays in the wizard.
    for (const [answer, next] of [["Sport & Fitness", /^Gibt es eine Kündigungsfrist/], ["Die Kündigungsfrist ist 1 Monat", /^Gibt es eine Mindestlaufzeit/],
      ["Keine Mindestlaufzeit", /^Wann ist die nächste Abbuchung/], ["Am 1.11.", /^So würde ich „Fitness Park“ anlegen/]] as const) {
      await ask(page, answer);
      await expect(chat.getByText(next)).toBeVisible();
    }
    await ask(page, "Nein");
    await expect(chat.getByText(/^Was soll ich ändern\?/)).toBeVisible();
    await ask(page, "Ja");
    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}").contracts?.some((item: { name?: string }) => item.name === "Fitness Park"), storageKey))
      .toBe(true);
    // Every run records its tool calls for the admin view, the confirming "Ja" included.
    const calls = await page.evaluate((key) => (JSON.parse(localStorage.getItem(key) ?? "{}").assistantChat ?? [])
      .flatMap((item: { calls?: unknown[] }) => item.calls ?? []), storageKey);
    expect(calls).toContainEqual({ tool: "contract_new", ok: true, summary: "Lege Vertrag an" });
  });
});
