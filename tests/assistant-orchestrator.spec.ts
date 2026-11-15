import { expect, test, type Page } from "@playwright/test";
import { SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";
import { payrollFixture } from "./fixtures/payroll-state";

// Nur synthetische Daten. Die Schritte des Orchestrators und der Spezialisten, die Antworten und die Folgefragen der KI sind gemockt;
// die Werkzeuge laufen echt im Browser.
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
    test(`lets the orchestrator answer every question through its specialists with the droid at ${width}px (${theme})`, async ({ page }, testInfo) => {
      await prepare(page, width, theme);
      // The agents' steps are mocked (DeepSeek in production); the specialists' tools run for real on synthetic data in the browser.
      type Call = { id: string; name: string; arguments: string };
      type Step = { agent: string; message: string; turns: { calls: Call[]; results: { id: string; content: string }[] }[]; overview?: Record<string, unknown>;
        history?: { role: string; text: string }[]; correction?: boolean; evidence?: string };
      const pro = { provider: "deepseek", model: "deepseek-v4-pro", task: "orchestrate" };
      const flash = { provider: "deepseek", model: "deepseek-flash", task: "delegate" };
      const limits = { maxSteps: 5, maxToolCalls: 8, timeoutMs: 120_000, maxTokens: 900 };
      const call = (id: string, name: string, args: Record<string, string>): Call => ({ id, name, arguments: JSON.stringify(args) });
      // What the orchestrator delegates first (none: it answers right away), what the specialist calls, and the final words.
      const plans: Record<string, { delegate?: Call; tool?: Call; finding?: string; text: string }> = {
        "Hallo": { text: "Hallo! Schön, dass du da bist." },
        "Was hältst du von Bitcoin?": { text: "Spannend, aber ziemlich schwankend. Nur mit Geld, das du länger nicht brauchst." },
        "Wie viel netto bekomme ich?": { delegate: call("o1", "gehalt", { aufgabe: "Nettogehalt laut letzter Lohnabrechnung" }),
          tool: call("s1", "payroll", { frage: "Wie viel netto bekomme ich?" }), finding: "Netto laut letzter Abrechnung: 2.780 €.",
          text: "Du bekommst 2.780 € netto im Monat." },
        "Wird mein Konto knapp?": { delegate: call("o1", "budget", { aufgabe: "Prognose des Girokontos bis zum Gehalt" }),
          tool: call("s1", "forecast", { frage: "Wird mein Konto knapp?" }), finding: "Das Girokonto wird vor dem Gehalt knapp.",
          text: "Ja, dein Girokonto wird knapp.\n\nPlan die Sparrate erst nach dem Gehalt ein." },
        "Nein, ich meine das Sparkonto": { text: "Am Sparkonto ist alles im grünen Bereich, da bleibt genug übrig." },
      };
      const steps: Step[] = [];
      let task = "";
      const ndjson = (events: object[]) => ({ contentType: "application/x-ndjson; charset=utf-8", body: `${events.map((event) => JSON.stringify(event)).join("\n")}\n` });
      await page.route("**/api/ai/agent**", async (route) => {
        const body = route.request().postDataJSON() as Step;
        steps.push(body);
        if (body.agent === "orchestrator") {
          task = body.message;
          const plan = plans[body.message];
          const head = [{ limits }, { prompt: "Du bist der Orchestrator (Test-Prompt)." }, { model: pro }];
          if (plan.delegate && !body.turns.length) return route.fulfill(ndjson([...head, { calls: [plan.delegate] }]));
          // The forecast's answer takes a moment, so the live status can be seen.
          if (body.message === "Wird mein Konto knapp?") await new Promise((resolve) => setTimeout(resolve, 1500));
          return route.fulfill(ndjson([...head, { delta: plan.text.slice(0, 6) }, { done: true, ok: true, text: plan.text }]));
        }
        const plan = plans[task];
        return route.fulfill({ json: body.turns.length ? { calls: [], text: plan.finding, models: [flash] } : { calls: [plan.tool], models: [flash], limits } });
      });
      // Questions never take the change workflow or the old answer route.
      const legacy: string[] = [];
      await page.route(/\/api\/ai\/(assistant|answer)/, async (route) => {
        legacy.push(route.request().url());
        await route.fulfill({ status: 503, json: { error: "nicht erwartet" } });
      });
      await page.goto("/");
      await page.getByRole("button", { name: /^Finanz-Assistent öffnen/ }).click();
      const chat = page.getByRole("region", { name: "Chat mit dem Finanz-Assistenten" });
      const lead = () => steps.filter((step) => step.agent === "orchestrator");

      // Even small talk goes to the orchestrator and DeepSeek writes the answer; no fixed reply.
      await ask(page, "Hallo");
      await expect(chat.getByText("Hallo! Schön, dass du da bist.")).toBeVisible();
      // The orchestrator sees an overview of the user's data: amounts, accounts and bookings, but no IBAN.
      expect(Object.keys(lead()[0].overview ?? {})).toEqual(expect.arrayContaining(["accounts", "thisMonth", "budgets", "subscriptions", "goals", "recentBookings"]));
      expect(JSON.stringify(lead()[0].overview)).not.toMatch(/\bAT\d{2}(?: ?\d{4}){4}/);

      await ask(page, "Was hältst du von Bitcoin?");
      await expect(chat.getByText("Spannend, aber ziemlich schwankend. Nur mit Geld, das du länger nicht brauchst.")).toBeVisible();
      await expect(chat.locator('[data-model="deepseek-v4-pro"]').last()).toHaveAttribute("title", "DeepSeek V4 Pro");
      await expect(chat.getByRole("group", { name: "Vorschläge von DeepSeek" }).getByRole("button")).toHaveText(["Wie viel Bitcoin wäre vertretbar?", "Was ist ein ETF?"]);

      // The orchestrator delegates to the payroll specialist, whose tool returns raw data; the orchestrator writes the words, the result is a tile.
      await ask(page, "Wie viel netto bekomme ich?");
      await expect(chat.getByText("Du bekommst 2.780 € netto im Monat.")).toBeVisible();
      const specialist = steps.filter((step) => step.agent === "payroll");
      // Two steps of the specialist with the orchestrator's task: its tool call, then its findings.
      expect(specialist.map((step) => step.message)).toEqual(["Nettogehalt laut letzter Lohnabrechnung", "Nettogehalt laut letzter Lohnabrechnung"]);
      // A specialist gets only its task and its tools' results: no conversation, no data overview.
      expect(specialist[0].history).toBeUndefined();
      expect(specialist[0].overview).toBeUndefined();
      expect(specialist[1].turns[0].results[0].content).toMatch(/^\[Gehaltsübersicht\] Wie viel netto bekomme ich\?/);
      const final = lead().at(-1)!;
      expect(final.turns[0].results).toEqual([{ id: "o1", content: "Netto laut letzter Abrechnung: 2.780 €." }]);
      expect(final.evidence).toMatch(/\[Gehaltsübersicht\] Wie viel netto bekomme ich\?/);
      const payroll = chat.getByRole("list", { name: "Ergebnisse" }).last().getByRole("article", { name: /^Gehalt · / });
      await expect(payroll).toBeVisible();
      await payroll.getByRole("button", { name: "Mehr" }).click();
      await expect(payroll.getByText(/^Nächste Sonderzahlung/)).toBeVisible();
      // Tool calls and the prompt stay out of the conversation, behind one small closed "Details" link.
      await expect(chat.getByText("Du bist der Orchestrator (Test-Prompt).")).toHaveCount(0);
      await expect(chat.locator("[data-call]")).toHaveCount(0);
      const details = chat.getByRole("button", { name: "Details", exact: true }).last();
      await expect(details).toHaveAttribute("aria-expanded", "false");
      await details.click();
      const panel = chat.getByRole("region", { name: "Details zur Antwort" });
      await expect(panel).toContainText("Modelle: DeepSeek V4 Pro (Orchestrator) · DeepSeek Flash (Spezialist)");
      await expect(panel.locator('[data-call="agent.payroll"]')).toBeVisible();
      const tool = panel.locator('[data-call="payroll"]');
      await expect(tool).toContainText("Gehaltsübersicht");
      await expect(tool).toContainText("· Wie viel netto bekomme ich?");
      await tool.getByRole("button").click();
      await expect(tool.locator("dd").first()).toHaveText("Wie viel netto bekomme ich?");
      await expect(tool.locator("dt")).toHaveText(["Eingabe", "Ergebnis"]);
      await expect(panel.getByText("Du bist der Orchestrator (Test-Prompt).")).toBeVisible();
      await details.click();
      await expect(panel).toHaveCount(0);

      // A forecast: key figures as badges, the trend as a sparkline, the key statement first.
      await ask(page, "Wird mein Konto knapp?");
      // While the orchestrator combines the results: only the orb and a word or two, no tools, no model; gone once the answer is there.
      const live = chat.locator("[data-live-answer]");
      await expect(live.locator("[data-status-line]")).toHaveText("Fasse zusammen…");
      await expect(live.locator("[data-orb]")).toBeVisible();
      await expect(live).not.toContainText(/Kontoprognose|DeepSeek|Werkzeug|Budget & Prognose/);
      await expect(chat.getByText("Ja, dein Girokonto wird knapp.")).toBeVisible();
      await expect(live).toHaveCount(0);
      await expect(chat.getByRole("list", { name: "Kennzahlen" }).last()).toBeVisible();
      await expect(chat.getByRole("img", { name: /^Verlauf / }).last()).toBeVisible();

      // A correction keeps the topic: no rule, the orchestrator gets the flag and the conversation so far.
      await ask(page, "Nein, ich meine das Sparkonto");
      await expect(chat.getByText("Am Sparkonto ist alles im grünen Bereich, da bleibt genug übrig.")).toBeVisible();
      expect(lead().at(-1)).toMatchObject({ message: "Nein, ich meine das Sparkonto", correction: true });
      expect(lead().at(-1)?.history?.map((item) => item.text)).toEqual(expect.arrayContaining(["Wird mein Konto knapp?", "Wie viel netto bekomme ich?"]));
      expect(lead().at(-1)?.history?.some((item) => item.role === "assistant" && item.text.startsWith("Ja, dein Girokonto wird knapp."))).toBe(true);
      expect(lead().at(-1)?.history?.length).toBeLessThanOrEqual(8);
      expect(legacy).toEqual([]);

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
    // The rule flows without DeepSeek: the server is unreachable, so the browser's own rules route (with DeepSeek the orchestrator decides).
    await page.route(/\/api\/ai\/(assistant|agent)/, (route) => route.fulfill({ status: 503, json: { error: "nicht erreichbar" } }));
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
