import { expect, test, type Page } from "@playwright/test";
import {
  agentDefs, agentSources, agentToolSpecs, dataCatalog, dataSource, dataSources, defaultKnowledge, isLlmAgentKey, toolSpecs, type AgentKey,
} from "../src/lib/agents/registry";
import { agentPrompts, defaultPrompts } from "../src/lib/ai/agent-prompts";
import { SECURITY_ACTIVATION_KEY } from "../src/lib/security-mode";
import { payrollFixture } from "./fixtures/payroll-state";

// Nur synthetische Daten: drei Läufe im Chatverlauf; KI-Status, Agent-Repo, Evals, Feedback und Prüfungs-Agent sind gemockt.
const storageKey = "finanzdashboard.v1";
const local = "OpenVINO/Qwen3-8B-int4-cw-ov";
const at = Date.UTC(2026, 9, 15, 10);

function adminState() {
  return {
    ...payrollFixture(),
    assistantChat: [
      { id: "u1", role: "user", text: "Wie viel netto bekomme ich?", at },
      { id: "a1", role: "assistant", text: "Deine letzte Abrechnung bringt 2.780,00 € netto.", at: at + 400, source: "Regel", agent: "payroll", via: "rule", ms: 380, tool: "payroll" },
      { id: "u2", role: "user", text: "Was hältst du von Bitcoin?", at: at + 60_000 },
      { id: "a2", role: "assistant", text: "Spannend, aber ziemlich schwankend.", at: at + 64_000, source: "KI", agent: "general", via: "rule", ms: 4100, tool: "free",
        models: [{ provider: "local", model: local, task: "chat", fallback: true, reason: "Rate-Limit (HTTP 429)" }] },
      { id: "u3", role: "user", text: "Reicht mein Geld bis zum Monatsende?", at: at + 120_000 },
      { id: "a3", role: "assistant", text: "Ja, es bleiben rund 240 € übrig.", at: at + 126_000, source: "KI", agent: "budget", via: "orchestrator", ms: 5600, tool: "free",
        calls: [{ tool: "agent.budget", ok: true, summary: "Frage Budget & Prognose", by: "orchestrator" }, { tool: "pulse", ok: true, summary: "Monats-Puls", by: "budget" },
          { tool: "forecast", ok: true, summary: "Kontoprognose", by: "budget" }],
        models: [{ provider: "deepseek", model: "deepseek-v4-pro", task: "orchestrate" }, { provider: "deepseek", model: "deepseek-flash", task: "delegate" }] },
    ],
  };
}

/** The agent repo as the API returns it, from the code defaults; the orchestrator has one saved version. */
function repoFixture() {
  const assembled = (key: AgentKey) => {
    const lead = agentPrompts(key)[0];
    return `${lead ? defaultPrompts[lead.id] : ""}\n\nWerkzeuge: ${agentToolSpecs(key).map((tool) => tool.name).join(", ")}.`;
  };
  return {
    file: "config/agent-repo.json",
    agents: agentDefs.map((agent) => ({
      key: agent.key, name: agent.name, kind: agent.kind, summary: agent.summary, ...(agent.mode ? { mode: agent.mode } : {}),
      ...(agent.config ? { config: agent.config, defaults: agent.config } : {}),
      tools: agentToolSpecs(agent.key).map((tool) => tool.name), sources: agentSources(agent.key).map(dataSource),
      prompts: agentPrompts(agent.key).map((meta) => ({ ...meta, default: defaultPrompts[meta.id], text: defaultPrompts[meta.id], custom: false })),
      ...(isLlmAgentKey(agent.key) ? { assembled: assembled(agent.key) } : {}),
      knowledge: defaultKnowledge[agent.key]?.length ?? 0,
      ...(agent.key === "orchestrator"
        ? { edits: 1, version: 2, history: [{ key: "agent:orchestrator", label: "Modell & Limits", v: 2, at: "2026-10-14T09:00:00.000Z", by: "Admin", note: "Mehr Schritte", reset: false },
          { key: "agent:orchestrator", label: "Modell & Limits", v: 1, at: "2026-10-13T09:00:00.000Z", by: "Admin", reset: false }] }
        : { edits: 0, history: [] }),
    })),
    tools: toolSpecs.map((tool) => ({ name: tool.name, label: tool.label, kind: tool.kind, ...(tool.source ? { source: dataSource(tool.source) } : {}), agents: tool.agents,
      description: tool.description, default: tool.description, custom: false, param: tool.param })),
    knowledge: Object.fromEntries(agentDefs.map((agent) => [agent.key, (defaultKnowledge[agent.key] ?? []).map((doc) => ({ ...doc, chars: doc.text.length, code: true, custom: false }))])),
    sources: dataSources, catalog: dataCatalog,
    limits: { knowledgeChars: 12_000, knowledgeDoc: 6000, promptLength: 8000, toolDescription: 1200 },
  };
}

async function prepare(page: Page, width: number, theme: "light" | "dark") {
  await page.clock.setFixedTime(new Date("2026-10-15T12:00:00Z"));
  await page.setViewportSize({ width, height: width < 768 ? 812 : 1000 });
  const routing = [["chat", "deepseek-flash", "DeepSeek Flash"], ["orchestrate", "deepseek-v4-pro", "DeepSeek V4 Pro"], ["delegate", "deepseek-flash", "DeepSeek Flash"],
    ["action", "deepseek-v4-pro", "DeepSeek V4 Pro"], ["reasoning", "deepseek-v4-pro", "DeepSeek V4 Pro · Denkmodus"], ["document", local, "Lokal (Qwen)"]]
    .map(([task, model, label]) => ({ task, model, label, fallback: model === local }));
  // The agent repo is mocked: saves change this copy only, never a file.
  let repo = repoFixture();
  await page.route("**/api/agent-repo", async (route) => {
    const method = route.request().method();
    if (method === "POST") repo = repoFixture();
    if (method === "PUT") {
      const { changes } = route.request().postDataJSON() as { changes: { key: string; value: unknown }[] };
      for (const { key, value } of changes) {
        const id = key.replace(/^prompt:/, "");
        repo = { ...repo, agents: repo.agents.map((agent) => ({ ...agent, prompts: agent.prompts.map((prompt) => prompt.id === id
          ? { ...prompt, text: typeof value === "string" ? value : prompt.default, custom: typeof value === "string" } : prompt) })) };
      }
    }
    await route.fulfill({ json: repo });
  });
  let running: object | null = null;
  await page.route("**/api/assistant-evals", async (route) => {
    if (route.request().method() === "POST") {
      running = { id: "eval-2", trigger: "Admin", done: 12, total: 86, startedAt: "2026-10-15T11:58:00.000Z" };
      return route.fulfill({ status: 202, json: { started: true } });
    }
    await route.fulfill({ json: { file: "data/assistant-evals.json", running, ready: "bereit",
      suites: [{ id: "gold", label: "Gold-Eval", cases: 86, description: "80 feste Fragen (Spezialisten und Werkzeuge), grenzwertige Fragen, versteckte Anweisungen und 6 Antworten – über die Agent-Laufzeit, auf DeepSeek Flash." }],
      runs: [{ id: "eval-1", suite: "gold", trigger: "Prüfungs-Agent", status: "done", startedAt: "2026-10-15T09:00:00.000Z", finishedAt: "2026-10-15T09:04:10.000Z",
        model: "deepseek-flash", score: { passed: 85, total: 86, hard: 0 }, ms: 250_000,
        failed: [{ group: "Budget", label: "Wie viel kann ich heute noch ausgeben?", ok: false, hard: false, got: "forecast", ms: 1800 }] }] } });
  });
  await page.route("**/api/assistant-feedback", (route) => route.fulfill({ json: { file: "data/assistant-feedback.json",
    count: { total: 2, like: 1, dislike: 1, withComment: 1 },
    latest: [{ id: "fb-1", rating: "dislike", summary: "👎 Verträge / contracts: „Lohnt sich ein anderes Konto?“ – Kommentar: „Such Alternativen“", recordedAt: "2026-10-15T11:00:00.000Z" }] } }));
  const changed = "2026-10-15T11:00:00.000Z";
  await page.route("**/api/assistant-rules", (route) => route.fulfill({ json: { file: "data/assistant-rules.json", loop: "bereit", count: {}, rules: [
    { id: "rule-0002", feedbackId: "fb-00000002", createdAt: changed, updatedAt: changed, appliedAt: changed, status: "active", kind: "prompt",
      comment: "Du sollst meine Verträge durchsuchen und nach einer günstigeren Alternative suchen.", question: "Lohnt sich ein anderes Konto?", answer: "Schau unter Verträge.",
      rule: "Bei Fragen nach Alternativen hol die passenden Verträge und recherchiere günstigere Angebote im Web.", scope: "all", target: "routing",
      prompt: { id: "agent.contracts", mode: "replace", before: "Behaupte nie, dass er ein gefragtes Angebot schon hat.",
        after: "Bei Fragen nach Alternativen hol die passenden Verträge und recherchiere günstigere Angebote im Web." },
      review: { fixed: true, note: "Holt jetzt die Verträge und sucht im Web nach Alternativen." }, votes: { up: 3, down: 1 },
      check: { at: changed, model: "deepseek-flash", passed: true, baseline: { passed: 85, total: 86, hard: 0 }, candidate: { passed: 86, total: 86, hard: 0 } } },
    { id: "rule-0001", feedbackId: "fb-00000001", createdAt: changed, updatedAt: changed, status: "active", comment: "Die Antwort beginnt mit einer Floskel und wiederholt sich.",
      question: "Was ist ein ETF?", answer: "Gute Frage! …", rule: "Beginne Antworten ohne Floskel und vermeide Wiederholungen.", scope: "all", target: "answer",
      check: { at: changed, model: "deepseek-flash", passed: true, baseline: { passed: 85, total: 86, hard: 0 }, candidate: { passed: 85, total: 86, hard: 0 } } },
  ] } }));
  await page.route("**/api/ai/status", (route) => route.fulfill({ json: {
    available: true, model: "deepseek-flash", label: "DeepSeek Flash", device: "Cloud", local: { available: true, model: local },
    cloud: { provider: "deepseek", available: true, models: { fast: "deepseek-flash", pro: "deepseek-v4-pro", reasoning: "deepseek-v4-pro" } }, routing,
    usage: { "deepseek-flash": { calls: 4, input: 12000, output: 500, cached: 6000 }, "deepseek-v4-pro": { calls: 2, input: 8000, output: 500, cached: 2000 } },
  } }));
  await page.addInitScript(({ key, json, theme, activation }) => {
    localStorage.setItem("theme", theme);
    localStorage.setItem(activation, "off");
    if (!localStorage.getItem(key)) localStorage.setItem(key, json);
  }, { key: storageKey, json: JSON.stringify(adminState()), theme, activation: SECURITY_ACTIVATION_KEY });
}

const sideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("assistant orchestrator admin", () => {
  test.skip(process.env.FINANZBLICK_AUTH === "true", "Seeds the browser-mode store.");

  for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
    test(`is reachable only from the settings and walks overview, topology, data, knowledge, runs, evals, agents, tools and feedback at ${width}px (${theme})`, async ({ page }, testInfo) => {
      const shot = (name: string) => page.screenshot({ path: testInfo.outputPath(`orchestrator-${name}-${width}-${theme}.png`), fullPage: true });
      await prepare(page, width, theme);
      await page.goto("/einstellungen");
      await expect(page.getByRole("link", { name: "Assistent-Orchestrator" })).toBeVisible();
      await expect(page.getByRole("navigation").getByRole("link", { name: /Orchestrator/ })).toHaveCount(0);
      // The arrow next to the link folds out the subpages.
      await page.getByRole("button", { name: "Orchestrator-Unterseiten anzeigen" }).click();
      await expect(page.getByRole("list", { name: "Orchestrator-Unterseiten" }).getByRole("link"))
        .toHaveText(["Übersicht", "Topologie", "Daten", "Wissen", "Läufe", "Evals", "Agenten", "Werkzeuge", "Feedback & Prüfung"]);
      await expect(page.getByRole("button", { name: "Orchestrator-Unterseiten ausblenden" })).toHaveAttribute("aria-expanded", "true");
      await page.getByRole("link", { name: "Assistent-Orchestrator" }).click();
      await expect(page).toHaveURL(/\/einstellungen\/orchestrator\/uebersicht$/);

      await expect(page.getByRole("heading", { level: 1, name: "Orchestrator" })).toBeVisible();
      const sub = page.getByRole("navigation", { name: "Orchestrator-Bereiche" });
      await expect(sub.getByRole("link", { name: "Übersicht" })).toHaveAttribute("aria-current", "page");
      const kpis = page.getByRole("list", { name: "Kennzahlen" });
      await expect(kpis.getByRole("link", { name: /^Gold-Eval/ })).toContainText("85/86");
      await expect(kpis.getByRole("link", { name: /^Läufe/ })).toContainText("3");
      await expect(kpis.getByRole("link", { name: /^Prüfungs-Agent/ })).toContainText("2");
      for (const name of ["Modelle", "Kosten"]) await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
      await expect(page.getByText("KI bereit · DeepSeek Flash · Qwen als Rückfall")).toBeVisible();
      await expect(page.getByRole("list", { name: "Modell je Aufgabe" })).toContainText("DeepSeek V4 Pro · Denkmodus");
      await expect(page.getByRole("list", { name: "Kosten je Modell" })).toContainText("deepseek-v4-pro");
      expect(await sideScroll(page)).toBeLessThanOrEqual(0);
      await shot("uebersicht");

      await sub.getByRole("link", { name: "Topologie" }).click();
      await expect(page).toHaveURL(/\/orchestrator\/topologie$/);
      if (width >= 768) {
        const graph = page.getByRole("group", { name: "Topologie als Graph" });
        await expect(graph.getByRole("link", { name: /^Orchestrator \(orchestrator\)/ })).toBeVisible();
        await expect(graph.getByRole("link", { name: /^Prüfungs-Agent \(review\)/ })).toBeVisible();
        await graph.getByRole("link", { name: "Werkzeug pulse: Monats-Puls" }).hover();
        await expect(graph.getByRole("link", { name: /^Datenquelle Lohnabrechnungen/ })).toHaveAttribute("data-state", "dim");
        await expect(graph.getByRole("link", { name: /^Datenquelle Monatsplan/ })).toHaveAttribute("data-state", "idle");
      } else {
        const list = page.getByRole("group", { name: "Topologie als Liste" });
        await expect(list.getByRole("link", { name: /^Orchestrator \(orchestrator\)/ })).toBeVisible();
        await expect(list.getByRole("list", { name: "Werkzeuge: Änderungen" })).toContainText("booking");
        await expect(page.getByRole("group", { name: "Topologie als Graph" })).toHaveCount(0);
      }
      expect(await sideScroll(page)).toBeLessThanOrEqual(0);
      await shot("topologie");

      await sub.getByRole("link", { name: "Daten" }).click();
      await expect(page.getByRole("heading", { level: 2, name: "Datenkatalog" })).toBeVisible();
      await expect(page.getByRole("table", { name: "Felder von Buchungen" })).toBeVisible();
      await page.getByRole("group", { name: "Beziehungen von Buchungen" }).getByRole("button", { name: "Verträge & Abos öffnen" }).click();
      await expect(page.getByRole("table", { name: "Felder von Verträge & Abos" })).toBeVisible();
      expect(await sideScroll(page)).toBeLessThanOrEqual(0);
      await shot("daten");

      await sub.getByRole("link", { name: "Wissen" }).click();
      await page.getByRole("tab", { name: /^Recherche & Wissen/ }).click();
      await expect(page.getByRole("tabpanel").getByRole("heading", { name: "Gute Quellen in Österreich" })).toBeVisible();
      expect(await sideScroll(page)).toBeLessThanOrEqual(0);
      await shot("wissen");

      await sub.getByRole("link", { name: "Läufe" }).click();
      const runs = page.getByRole("list", { name: "Letzte Läufe" });
      await expect(runs.locator(":scope > li")).toHaveCount(3);
      await expect(runs.getByRole("list", { name: "Werkzeuge von Budget & Prognose" })).toContainText("Monats-Puls");
      await expect(runs.getByRole("group", { name: "Modelle" }).nth(1)).toHaveText("Lokal (Qwen) (Rückfall, weil DeepSeek: Rate-Limit (HTTP 429))");
      expect(await sideScroll(page)).toBeLessThanOrEqual(0);
      await shot("laeufe");

      await sub.getByRole("link", { name: "Evals" }).click();
      await page.getByRole("button", { name: "1 Fehler" }).click();
      await expect(page.getByRole("list", { name: "Fehlgeschlagene Fälle" })).toContainText("Wie viel kann ich heute noch ausgeben?");
      await page.getByRole("button", { name: "Eval starten" }).click();
      await expect(page.getByRole("progressbar", { name: "Fortschritt der Eval" })).toHaveAttribute("aria-valuenow", "12");
      await expect(page.getByRole("button", { name: "Eval starten" })).toBeDisabled();
      expect(await sideScroll(page)).toBeLessThanOrEqual(0);
      await shot("evals");

      await sub.getByRole("link", { name: "Agenten" }).click();
      await expect(page.getByText("Bearbeitet v2").first()).toBeVisible();
      expect(await sideScroll(page)).toBeLessThanOrEqual(0);
      await shot("agenten");
      await page.getByRole("link", { name: "Orchestrator (orchestrator)" }).click();
      await expect(page).toHaveURL(/\/orchestrator\/agenten\/orchestrator$/);
      await expect(sub.getByRole("link", { name: "Agenten" })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("region", { name: "System-Prompt, wie ein Lauf ihn sendet" })).toContainText("Werkzeuge: umsaetze");
      await page.getByRole("button", { name: "Bearbeiten", exact: true }).click();
      const field = page.getByRole("textbox", { name: "Prompt: System-Prompt" });
      await field.fill("Delegiere knapp und schreib kurz.");
      const editor = field.locator("..");
      await editor.getByRole("button", { name: "Speichern" }).click();
      await expect(editor.getByText("Gespeichert – gilt ab dem nächsten Lauf.")).toBeVisible();
      await expect(editor.getByText("Angepasst")).toBeVisible();
      expect(await sideScroll(page)).toBeLessThanOrEqual(0);
      await shot("agent");
      await editor.getByRole("button", { name: "Auf Standard zurücksetzen" }).click();
      await expect(editor.getByText("Auf Standard zurückgesetzt – gilt ab dem nächsten Lauf.")).toBeVisible();
      await expect(field).not.toHaveValue("Delegiere knapp und schreib kurz.");

      await sub.getByRole("link", { name: "Werkzeuge" }).click();
      await expect(page.getByRole("heading", { level: 3, name: /Delegation · Orchestrator/ })).toBeVisible();
      await expect(page.locator("#werkzeug-query")).toContainText("Ausgaben & Einnahmen");
      expect(await sideScroll(page)).toBeLessThanOrEqual(0);
      await shot("werkzeuge");

      await sub.getByRole("link", { name: "Feedback & Prüfung" }).click();
      const rules = page.getByRole("list", { name: "Änderungen des Prüfungs-Agents" });
      await expect(rules).toContainText("Beginne Antworten ohne Floskel und vermeide Wiederholungen.");
      await expect(rules).toContainText("Gold-Eval ohne → mit Regel: 85/86 → 85/86");
      await expect(rules.getByRole("button", { name: /^Regel deaktivieren/ })).toBeVisible();
      const change = rules.locator(":scope > li").first();
      await expect(change).toContainText("Prompt geändert · Verträge · System-Prompt");
      await expect(change).toContainText("Statt: „Behaupte nie, dass er ein gefragtes Angebot schon hat.“");
      await expect(change).toContainText("Nachtest: behoben");
      await expect(change.getByRole("button", { name: /^Änderung zurücknehmen/ })).toBeVisible();
      await expect(page.getByRole("region", { name: "Feedback" })).toContainText("data/assistant-feedback.json");
      await expect(page.getByRole("button", { name: "Aktualisieren" })).toBeEnabled();
      expect(await sideScroll(page)).toBeLessThanOrEqual(0);
      await shot("feedback");

      // The bare address and the old "Aufbau" page still work.
      await page.goto("/einstellungen/orchestrator");
      await expect(page).toHaveURL(/\/einstellungen\/orchestrator\/uebersicht$/);
      await page.goto("/einstellungen/orchestrator/aufbau");
      await expect(page).toHaveURL(/\/einstellungen\/orchestrator\/topologie$/);
      expect(await sideScroll(page)).toBeLessThanOrEqual(0);
    });
  }
});
