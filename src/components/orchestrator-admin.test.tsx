// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrchestratorAdmin, OrchestratorShell } from "@/components/orchestrator-admin";
import { OrchestratorSettingsLinks } from "@/components/orchestrator-nav";
import type { RepoOverview } from "@/components/orchestrator/shared";
import { useFinance } from "@/components/finance-provider";
import {
  agentDefs, agentSources, agentToolSpecs, dataCatalog, dataSource, dataSources, defaultKnowledge, isLlmAgentKey, toolSpecs, type AgentKey,
} from "@/lib/agents/registry";
import { agentPrompts, defaultPrompts } from "@/lib/ai/agent-prompts";
import type { OrchestratorView } from "@/lib/assistant/orchestrator-pages";
import { createSeed } from "@/lib/seed";
import type { AppState } from "@/lib/types";

const navigation = vi.hoisted(() => ({ pathname: "/einstellungen/orchestrator/uebersicht" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.unstubAllGlobals());

const qwen = "OpenVINO/Qwen3-8B-int4-cw-ov";
function renderAdmin(view: OrchestratorView, chat: AppState["assistantChat"] = [], agent?: AgentKey) {
  navigation.pathname = agent ? `/einstellungen/orchestrator/agenten/${agent}` : `/einstellungen/orchestrator/${view}`;
  const state = { ...createSeed(), assistantChat: chat };
  vi.mocked(useFinance).mockReturnValue({ state, ready: true, update: vi.fn() } as unknown as ReturnType<typeof useFinance>);
  return render(<OrchestratorShell><OrchestratorAdmin view={view} agent={agent} /></OrchestratorShell>);
}
const cloudStatus = (extra: object = {}) => ({
  available: true, model: "deepseek-flash", label: "DeepSeek Flash", device: "Cloud", local: { available: true, model: qwen },
  cloud: { provider: "deepseek", available: true, models: { fast: "deepseek-flash", pro: "deepseek-v4-pro", reasoning: "deepseek-v4-pro" } },
  routing: [["chat", "DeepSeek Flash"], ["orchestrate", "DeepSeek V4 Pro"], ["delegate", "DeepSeek Flash"], ["action", "DeepSeek V4 Pro"],
    ["reasoning", "DeepSeek V4 Pro · Denkmodus"], ["document", "Lokal (Qwen)"]]
    .map(([task, label]) => ({ task, label, model: label.startsWith("Lokal") ? qwen : "deepseek", ...(label.startsWith("Lokal") ? { fallback: true } : {}) })),
  ...extra,
});

/** A fake server: each URL has its handler, everything else answers with the AI status. */
function serve(routes: Record<string, (init?: RequestInit) => Response> = {}) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => routes[url]?.(init) ?? Response.json(cloudStatus()));
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

/** The agent repo as the API returns it, built from the code defaults. */
function repoFixture(): RepoOverview {
  return {
    file: "config/agent-repo.json",
    agents: agentDefs.map((agent) => ({
      key: agent.key, name: agent.name, kind: agent.kind, summary: agent.summary, ...(agent.mode ? { mode: agent.mode } : {}),
      ...(agent.config ? { config: agent.config, defaults: agent.config } : {}),
      tools: agentToolSpecs(agent.key).map((tool) => tool.name), sources: agentSources(agent.key).map(dataSource),
      prompts: agentPrompts(agent.key).map((meta) => ({ ...meta, default: defaultPrompts[meta.id], text: defaultPrompts[meta.id], custom: false })),
      ...(isLlmAgentKey(agent.key) ? { assembled: `Du bist ${agent.name}. Werkzeuge: ${agentToolSpecs(agent.key).map((tool) => tool.name).join(", ")}.` } : {}),
      knowledge: defaultKnowledge[agent.key]?.length ?? 0, edits: 0, history: [],
    })),
    tools: toolSpecs.map((tool) => ({ name: tool.name, label: tool.label, kind: tool.kind, ...(tool.source ? { source: dataSource(tool.source) } : {}), agents: tool.agents,
      description: tool.description, default: tool.description, custom: false, param: tool.param })),
    knowledge: Object.fromEntries(agentDefs.map((agent) => [agent.key, (defaultKnowledge[agent.key] ?? []).map((doc) => ({ ...doc, chars: doc.text.length, code: true, custom: false }))])),
    sources: dataSources, catalog: dataCatalog,
    limits: { knowledgeChars: 12_000, knowledgeDoc: 6000, promptLength: 8000, toolDescription: 1200 },
  };
}

/** Applies PUTs like the server (a new version per change) and records every write. */
function repoServer(start = repoFixture()) {
  let repo = start;
  const requests: { method?: string; body: unknown }[] = [];
  const handler = (init?: RequestInit) => {
    if (init?.method === "PUT" || init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { changes?: { key: string; value: unknown }[] };
      requests.push({ method: init.method, body });
      repo = init.method === "POST" ? repoFixture() : JSON.parse(JSON.stringify(repo)) as RepoOverview;
      for (const { key, value } of body.changes ?? []) {
        const [kind, id, doc] = key.split(":");
        const owner = repo.agents.find((agent) => kind === "agent" ? agent.key === id : agent.prompts.some((prompt) => prompt.id === id));
        if (kind === "prompt" && owner) owner.prompts = owner.prompts.map((prompt) => prompt.id === id
          ? { ...prompt, text: typeof value === "string" ? value : prompt.default, custom: typeof value === "string" } : prompt);
        if (kind === "agent" && owner) owner.config = value ? { ...owner.defaults!, ...value as object } : owner.defaults;
        if (owner && (kind === "agent" || kind === "prompt")) Object.assign(owner, { edits: owner.edits + 1, version: (owner.version ?? 0) + 1 });
        if (kind === "tool") repo.tools = repo.tools.map((tool) => tool.name === id
          ? { ...tool, description: typeof value === "string" ? value : tool.default, custom: typeof value === "string", version: (tool.version ?? 0) + 1 } : tool);
        if (kind === "knowledge") {
          const docs = (repo.knowledge[id as AgentKey] ?? []).filter((item) => item.id !== doc);
          const added = value as { title: string; text: string } | { deleted: true } | null;
          repo.knowledge[id as AgentKey] = added && !("deleted" in added) ? [...docs, { id: doc, ...added, chars: added.text.length, code: false, custom: true, version: 1 }] : docs;
        }
      }
    }
    return Response.json(repo);
  };
  return { handler, requests };
}

it("lists the subpages in order, marks the open one and folds them out of the settings link", () => {
  serve();
  renderAdmin("laeufe");
  const nav = within(screen.getByRole("navigation", { name: "Orchestrator-Bereiche" }));
  expect(nav.getAllByRole("link").map((link) => link.textContent))
    .toEqual(["Übersicht", "Topologie", "Daten", "Wissen", "Läufe", "Evals", "Agenten", "Werkzeuge", "Feedback & Prüfung"]);
  expect(nav.getByRole("link", { name: "Läufe" }).getAttribute("aria-current")).toBe("page");
  cleanup();

  render(<OrchestratorSettingsLinks />);
  expect(screen.getByRole("link", { name: "Assistent-Orchestrator" }).getAttribute("href")).toBe("/einstellungen/orchestrator/uebersicht");
  const arrow = screen.getByRole("button", { name: "Orchestrator-Unterseiten anzeigen" });
  expect(arrow.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list", { name: "Orchestrator-Unterseiten" })).toBeNull();
  fireEvent.click(arrow);
  expect(arrow.getAttribute("aria-expanded")).toBe("true");
  expect(within(screen.getByRole("list", { name: "Orchestrator-Unterseiten" })).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["Übersicht", "/einstellungen/orchestrator/uebersicht"], ["Topologie", "/einstellungen/orchestrator/topologie"], ["Daten", "/einstellungen/orchestrator/daten"],
    ["Wissen", "/einstellungen/orchestrator/wissen"], ["Läufe", "/einstellungen/orchestrator/laeufe"], ["Evals", "/einstellungen/orchestrator/evals"],
    ["Agenten", "/einstellungen/orchestrator/agenten"], ["Werkzeuge", "/einstellungen/orchestrator/werkzeuge"], ["Feedback & Prüfung", "/einstellungen/orchestrator/feedback"],
  ]);
});

it("sums the platform up and shows the models and what DeepSeek costs", async () => {
  const at = "2026-11-14T09:04:00.000Z";
  const fetcher = serve({
    "/api/ai/status": () => Response.json(cloudStatus({ usage: {
      "deepseek-flash": { calls: 2, input: 3000, output: 200, cached: 1000 }, "deepseek-v4-pro": { calls: 1, input: 4000, output: 250, cached: 0 }, [qwen]: { calls: 3, input: 900, output: 90, cached: 0 },
    } })),
    "/api/assistant-evals": () => Response.json({ file: "data/assistant-evals.json", suites: [], running: null, ready: "bereit", runs: [
      { id: "eval-1", suite: "gold", trigger: "Admin", status: "done", startedAt: at, finishedAt: at, score: { passed: 85, total: 86, hard: 0 } },
    ] }),
    "/api/assistant-rules": () => Response.json({ file: "data/assistant-rules.json", loop: "bereit", count: {}, rules: [
      { id: "rule-0001", feedbackId: "fb-00000001", createdAt: at, updatedAt: at, status: "active", comment: "Kürzer bitte.", question: "?", answer: "!", rule: "Antworte kürzer." },
    ] }),
  });
  renderAdmin("uebersicht", [
    { id: "u1", role: "user", text: "Wie viel netto bekomme ich?", at: Date.UTC(2026, 10, 11, 9, 30) },
    { id: "a1", role: "assistant", text: "Deine letzte Abrechnung …", at: Date.UTC(2026, 10, 11, 9, 30, 1), agent: "payroll", via: "orchestrator", ms: 2100 },
  ]);
  const kpis = within(screen.getByRole("list", { name: "Kennzahlen" }));
  expect(kpis.getByRole("link", { name: /^Agenten/ }).textContent).toContain("6 LLM-Agenten · 1 Workflow");
  expect(kpis.getByRole("link", { name: /^Werkzeuge/ }).textContent).toContain(`davon ${toolSpecs.filter((tool) => tool.kind === "change").length} ändernd`);
  expect(kpis.getByRole("link", { name: /^Läufe/ }).textContent).toBe("Läufe1Median 2,1 s");
  await waitFor(() => expect(kpis.getByRole("link", { name: /^Gold-Eval/ }).textContent).toContain("85/86"));
  expect(kpis.getByRole("link", { name: /^Gold-Eval/ }).getAttribute("href")).toBe("/einstellungen/orchestrator/evals");
  expect(kpis.getByRole("link", { name: /^Prüfungs-Agent/ }).textContent).toBe("Prüfungs-Agent1aktive Änderung · Prüfung bereit");

  expect(await screen.findByText("KI bereit · DeepSeek Flash · Qwen als Rückfall")).toBeTruthy();
  const perTask = within(screen.getByRole("list", { name: "Modell je Aufgabe" })).getAllByRole("listitem").map((item) => item.textContent);
  expect(perTask).toContain("OrchestratorDeepSeek V4 Pro");
  expect(perTask).toContain("SpezialistDeepSeek Flash");
  expect(perTask).toContain("DokumentLokal (Qwen) · Rückfall");
  // Only DeepSeek costs money; the figure per question is the same in the strip and in the costs.
  const costs = within(screen.getByRole("list", { name: "Kosten je Modell" })).getAllByRole("listitem").map((item) => item.textContent);
  expect(costs).toEqual(["deepseek-flash · 2×0,0008 $", "deepseek-v4-pro · 1×0,0063 $"]);
  const perQuestion = screen.getByText("Pro Frage").nextElementSibling?.textContent ?? "";
  expect(kpis.getByRole("link", { name: /^Kosten pro Frage/ }).textContent).toContain(perQuestion);
  fireEvent.click(screen.getByRole("button", { name: "Aktualisieren" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/ai/status")).toHaveLength(2));
});

it("says when DeepSeek or the whole AI is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ available: true, model: qwen, label: "Lokal (Qwen)", device: "NPU", local: { available: true, model: qwen },
    cloud: { provider: "deepseek", available: false, error: "Key ungültig (HTTP 401)", models: { fast: "deepseek-flash", pro: "deepseek-v4-pro", reasoning: "deepseek-v4-pro" } },
    routing: [] })));
  renderAdmin("uebersicht");
  expect(await screen.findByText("Lokal (Qwen) aktiv · DeepSeek Key ungültig (HTTP 401)")).toBeTruthy();
  cleanup();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  renderAdmin("uebersicht");
  expect(await screen.findByText("KI nicht erreichbar · nur Regeln")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Kennzahlen" })).getByRole("link", { name: /^Gold-Eval/ }).textContent).toBe("Gold-Eval–nicht lesbar");
});

it("draws the topology from the chat over the orchestrator and its agents to the tools and data sources", async () => {
  serve();
  renderAdmin("topologie");
  const graph = within(screen.getByRole("group", { name: "Topologie als Graph" }));
  expect(graph.getByRole("button", { name: /^Chat: Chat-Panel, Agent-Lauf/ })).toBeTruthy();
  expect(graph.getByRole("link", { name: "Orchestrator (orchestrator) – LLM-Agent, DeepSeek V4 Pro, 6 Werkzeuge" }).getAttribute("href"))
    .toBe("/einstellungen/orchestrator/agenten/orchestrator");
  for (const name of ["Umsätze (transactions)", "Verträge (contracts)", "Budget & Prognose (budget)", "Gehalt & Steuern (payroll)", "Recherche & Wissen (research)"])
    expect(graph.getByRole("link", { name: (label) => label.startsWith(`${name} – LLM-Agent, DeepSeek Flash`) })).toBeTruthy();
  expect(graph.getByRole("link", { name: (label) => label.startsWith("Änderungen (changes) – Workflow, Code · feste Reihenfolge · fragt zuerst") })).toBeTruthy();
  expect(graph.getByRole("link", { name: (label) => label.startsWith("Lokaler Rückfall (fallback) – Rückfall") })).toBeTruthy();
  expect(graph.getByRole("link", { name: "Prüfungs-Agent (review) – Hintergrund, DeepSeek V4 Pro" })).toBeTruthy();
  expect(graph.getAllByRole("link", { name: /^Werkzeug / })).toHaveLength(toolSpecs.filter((tool) => tool.kind === "read" || tool.kind === "change").length);
  expect(graph.getByRole("link", { name: "Werkzeug pulse: Monats-Puls" }).getAttribute("href")).toBe("/einstellungen/orchestrator/werkzeuge#werkzeug-pulse");
  expect(graph.getByRole("link", { name: "Werkzeug booking: Buchung bearbeiten (ändert Daten)" })).toBeTruthy();
  expect(graph.getByRole("link", { name: "Datenquelle Buchungen (SQLite · lokal)" }).getAttribute("href")).toBe("/einstellungen/orchestrator/daten#buchungen");
  expect(graph.getAllByRole("link", { name: /^Datenquelle / })).toHaveLength(dataSources.length);
  expect(await screen.findByText("KI bereit · DeepSeek Flash · Qwen als Rückfall")).toBeTruthy();
  // Focus shows a node's lineage: the monthly pulse reads the plan, not the payslips.
  fireEvent.focus(graph.getByRole("link", { name: "Werkzeug pulse: Monats-Puls" }));
  expect(graph.getByRole("link", { name: "Datenquelle Monatsplan & Budgets (SQLite · lokal)" }).getAttribute("data-state")).toBe("idle");
  expect(graph.getByRole("link", { name: "Datenquelle Lohnabrechnungen (PDF-Import · lokal)" }).getAttribute("data-state")).toBe("dim");
  expect(graph.getByRole("link", { name: (label) => label.startsWith("Budget & Prognose") }).getAttribute("data-state")).toBe("idle");
});

it("shows the data catalog with relations, fields, readers and the number of entries", () => {
  serve();
  renderAdmin("daten");
  expect(screen.getByText("Aus dem Code")).toBeTruthy();
  expect(screen.getByRole("table", { name: "Felder von Buchungen" })).toBeTruthy();
  fireEvent.click(within(screen.getByRole("group", { name: "Beziehungen von Buchungen" })).getByRole("button", { name: "Verträge & Abos öffnen" }));
  expect(screen.getByRole("group", { name: "Beziehungen von Verträge & Abos" })).toBeTruthy();
  expect(screen.getByText("eigene/entschiedene")).toBeTruthy();
  const readers = within(screen.getByRole("list", { name: "Werkzeuge für Verträge & Abos" })).getAllByRole("link").map((link) => link.textContent);
  expect(readers).toContain("contracts");
  expect(readers).toContain("contract_new(schreibt)");
  fireEvent.change(screen.getByRole("searchbox", { name: "Daten filtern" }), { target: { value: "Gmail" } });
  expect(within(screen.getByRole("list", { name: "Datensätze" })).getAllByRole("button").map((button) => button.textContent)).toEqual(["Bestellungenbestellungen"]);
});

it("lists the agents like a repo with kind, model, limits, tools, sources and their version", async () => {
  const start = repoFixture();
  Object.assign(start.agents.find((agent) => agent.key === "budget") ?? {}, { edits: 1, version: 2 });
  serve({ "/api/agent-repo": repoServer(start).handler });
  renderAdmin("agenten");
  const table = await screen.findByRole("table", { name: "Agenten" });
  const rows = within(table).getAllByRole("row").slice(1);
  expect(rows.map((row) => within(row).getByRole("link").getAttribute("href"))).toEqual(agentDefs.map((agent) => `/einstellungen/orchestrator/agenten/${agent.key}`));
  const cells = (key: AgentKey) => [...(rows[agentDefs.findIndex((agent) => agent.key === key)]?.children ?? [])].map((cell) => cell.textContent);
  expect(cells("orchestrator")).toEqual(["Orchestratororchestrator", "LLM-Agent", "DeepSeek V4 Pro", "5", "120", "6", "–", "Code"]);
  expect(cells("budget").slice(1, 6)).toEqual(["LLM-Agent", "DeepSeek Flash", "4", "45", String(agentToolSpecs("budget").length)]);
  expect(cells("budget")[7]).toBe("Bearbeitet v2");
  expect(cells("changes").slice(1, 5)).toEqual(["Workflow", "Code · feste Reihenfolge · fragt zuerst", "–", "–"]);
  expect(cells("review")[1]).toBe("Hintergrund");
});

it("shows an agent's prompt as a run sends it and saves its prompts, model and limits, or puts everything back", async () => {
  const start = repoFixture();
  const lead = start.agents.find((agent) => agent.key === "orchestrator");
  Object.assign(lead ?? {}, { edits: 1, version: 2, history: [
    { key: "prompt:agent.orchestrator", label: "Prompt agent.orchestrator", v: 2, at: "2026-11-14T10:00:00.000Z", by: "Admin", note: "Kürzer delegieren", reset: false },
  ] });
  const repo = repoServer(start);
  serve({ "/api/agent-repo": repo.handler });
  renderAdmin("agenten", [], "orchestrator");
  expect(screen.getByRole("link", { name: "Agenten" }).getAttribute("aria-current")).toBe("page");
  expect((await screen.findByRole("region", { name: "System-Prompt, wie ein Lauf ihn sendet" })).textContent).toBe(lead?.assembled);
  expect(screen.getByText("Bearbeitet v2")).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "Verlauf von Orchestrator" })).getByRole("listitem").textContent).toContain("Kürzer delegieren");

  fireEvent.click(screen.getByRole("button", { name: "Bearbeiten" }));
  const field = screen.getByRole("textbox", { name: "Prompt: System-Prompt" });
  const editor = within(field.parentElement as HTMLElement);
  expect(editor.getByRole("button", { name: "Speichern" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(field, { target: { value: "Delegiere knapp und schreib kurz." } });
  fireEvent.click(editor.getByRole("button", { name: "Speichern" }));
  expect(await editor.findByText("Gespeichert – gilt ab dem nächsten Lauf.")).toBeTruthy();
  expect(editor.getByText("Angepasst")).toBeTruthy();

  const limits = within(screen.getByRole("region", { name: "Modell & Limits" }));
  fireEvent.change(limits.getByLabelText("Modell"), { target: { value: "reasoning" } });
  fireEvent.change(limits.getByLabelText("Max. Schritte"), { target: { value: "6" } });
  fireEvent.click(limits.getByRole("button", { name: "Speichern" }));
  expect(await limits.findByText("Modell & Limits gespeichert – gilt ab dem nächsten Lauf.")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Alles auf Code zurücksetzen" }));
  fireEvent.click(screen.getByRole("button", { name: "Zurücksetzen" }));
  expect(await screen.findByText("Alles auf Code zurückgesetzt – gilt ab dem nächsten Lauf.")).toBeTruthy();
  expect(repo.requests).toEqual([
    { method: "PUT", body: { changes: [{ key: "prompt:agent.orchestrator", value: "Delegiere knapp und schreib kurz." }] } },
    { method: "PUT", body: { changes: [{ key: "agent:orchestrator", value: { tier: "reasoning", maxSteps: 6, maxToolCalls: 8, timeoutMs: 120_000, maxTokens: 900 } }] } },
    { method: "POST", body: { reset: "orchestrator" } },
  ]);
  expect(screen.queryByText("Bearbeitet v2")).toBeNull();
});

it("edits a tool's description in the tool repo, grouped by delegation, data source and change workflow", async () => {
  const repo = repoServer();
  serve({ "/api/agent-repo": repo.handler });
  renderAdmin("werkzeuge");
  const headings = (await screen.findAllByRole("heading", { level: 3 })).map((heading) => heading.textContent);
  expect(headings[0]).toBe("Delegation · Orchestrator· 6");
  expect(headings[1]).toContain("Buchungen · SQLite · lokal");
  expect(headings.at(-1)).toContain("Änderungen · Workflow");
  expect(headings.at(-1)).toContain("ändert Daten – nur nach Bestätigung");
  const row = within(document.getElementById("werkzeug-query") as HTMLElement);
  fireEvent.click(row.getByRole("button", { name: "Beschreibung von query bearbeiten" }));
  fireEvent.change(row.getByRole("textbox", { name: "Beschreibung: query" }), { target: { value: "Summen und Listen vergangener Buchungen." } });
  fireEvent.click(row.getByRole("button", { name: "Speichern" }));
  expect(await row.findByText("Gespeichert – gilt ab dem nächsten Lauf.")).toBeTruthy();
  expect(row.getByText("Summen und Listen vergangener Buchungen.")).toBeTruthy();
  expect(row.getByText("Bearbeitet v1")).toBeTruthy();
  expect(repo.requests).toEqual([{ method: "PUT", body: { changes: [{ key: "tool:query", value: "Summen und Listen vergangener Buchungen." }] } }]);
});

it("adds and deletes the knowledge documents of an agent", async () => {
  const repo = repoServer();
  serve({ "/api/agent-repo": repo.handler });
  renderAdmin("wissen");
  const tab = await screen.findByRole("tab", { name: /^Recherche & Wissen/ });
  expect(screen.getByRole("tab", { name: /^Orchestrator/ }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(tab);
  expect(tab.getAttribute("aria-selected")).toBe("true");
  const panel = within(screen.getByRole("tabpanel"));
  const chars = defaultKnowledge.research?.[0]?.text.length ?? 0;
  expect(panel.getByText(`${chars.toLocaleString("de-DE")} von 12.000 Zeichen`)).toBeTruthy();

  fireEvent.click(panel.getByRole("button", { name: "Dokument hinzufügen" }));
  const form = within(panel.getByRole("form", { name: "Neues Dokument" }));
  fireEvent.change(form.getByLabelText("Titel"), { target: { value: "Zinsen & Sparbücher in Österreich" } });
  fireEvent.change(form.getByLabelText("Text"), { target: { value: "Vergleiche immer den effektiven Jahreszins." } });
  fireEvent.click(form.getByRole("button", { name: "Speichern" }));
  expect(await panel.findByText("„Zinsen & Sparbücher in Österreich“ hinzugefügt – gilt ab dem nächsten Lauf.")).toBeTruthy();

  fireEvent.click(panel.getByRole("button", { name: "„Gute Quellen in Österreich“ löschen" }));
  fireEvent.click(panel.getByRole("button", { name: "Löschen bestätigen" }));
  expect(await panel.findByText("„Gute Quellen in Österreich“ gelöscht – gilt ab dem nächsten Lauf.")).toBeTruthy();
  expect(within(panel.getByRole("list", { name: "Dokumente: Recherche & Wissen" })).getAllByRole("heading").map((heading) => heading.textContent))
    .toEqual(["Zinsen & Sparbücher in Österreich"]);
  expect(repo.requests).toEqual([
    { method: "PUT", body: { changes: [{ key: "knowledge:research:zinsen-sparbuecher-in-oesterreich",
      value: { title: "Zinsen & Sparbücher in Österreich", text: "Vergleiche immer den effektiven Jahreszins." } }] } },
    { method: "PUT", body: { changes: [{ key: "knowledge:research:quellen-oesterreich", value: { deleted: true } }] } },
  ]);
});

it("starts the gold eval, shows its progress and the failed cases of earlier runs", async () => {
  let running: object | null = null;
  const posts: unknown[] = [];
  const at = "2026-11-14T09:00:00.000Z";
  serve({ "/api/assistant-evals": (init) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      running = { id: "eval-2", trigger: "Admin", done: 12, total: 86, startedAt: "2026-11-15T10:00:00.000Z" };
      return Response.json({ started: true }, { status: 202 });
    }
    return Response.json({ file: "data/assistant-evals.json", suites: [{ id: "gold", label: "Gold-Eval", cases: 86, description: "80 feste Fragen und 6 Antworten." }],
      running, ready: "bereit", runs: [{ id: "eval-1", suite: "gold", trigger: "Prüfungs-Agent", status: "done", startedAt: at, finishedAt: "2026-11-14T09:04:00.000Z",
        model: "deepseek-flash", score: { passed: 85, total: 86, hard: 1 }, ms: 240_000,
        failed: [{ group: "Sicherheit", label: "Versteckte Anweisung im Kontoauszug", ok: false, hard: true, got: "budget", ms: 900 }] }] });
  } });
  renderAdmin("evals");
  const row = (await screen.findByRole("table", { name: "Eval-Läufe" })).querySelector("tbody tr") as HTMLElement;
  expect([...row.children].map((cell) => cell.textContent).slice(1, 6)).toEqual(["Prüfungs-Agent", "85/8699 %1 Sicherheitsfehler", "4 min", "deepseek-flash", "Fertig"]);
  fireEvent.click(within(row).getByRole("button", { name: "1 Fehler" }));
  expect(within(screen.getByRole("list", { name: "Fehlgeschlagene Fälle" })).getByRole("listitem").textContent).toContain("Versteckte Anweisung im Kontoauszug");

  fireEvent.click(screen.getByRole("button", { name: "Eval starten" }));
  const progress = await screen.findByRole("progressbar", { name: "Fortschritt der Eval" });
  expect(progress.getAttribute("aria-valuenow")).toBe("12");
  expect(screen.getByText("12 von 86 Fällen")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Eval starten" }).hasAttribute("disabled")).toBe(true);
  expect(posts).toEqual([{ suite: "gold" }]);
  cleanup();

  serve({ "/api/assistant-evals": (init) => init?.method === "POST" ? Response.json({ error: "Ohne erreichbares DeepSeek läuft keine Eval." }, { status: 409 })
    : Response.json({ file: "data/assistant-evals.json", suites: [{ id: "gold", label: "Gold-Eval", cases: 86, description: "…" }], running: null, ready: "bereit", runs: [] }) });
  renderAdmin("evals");
  fireEvent.click(await screen.findByRole("button", { name: "Eval starten" }));
  expect(await screen.findByText("Ohne erreichbares DeepSeek läuft keine Eval.")).toBeTruthy();
});

it("lists each run with agent, route, models and duration, and traces the orchestrator's delegations with the specialists' tools", () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(cloudStatus())));
  renderAdmin("laeufe", [
    { id: "u1", role: "user", text: "Wie viel netto bekomme ich?", at: Date.UTC(2026, 10, 11, 9, 30) },
    { id: "a1", role: "assistant", text: "Deine letzte Abrechnung …", at: Date.UTC(2026, 10, 11, 9, 30, 1), agent: "payroll", via: "rule", ms: 820, tool: "payroll" },
    { id: "u2", role: "user", text: "Wie hoch ist die Geringfügigkeitsgrenze?", at: Date.UTC(2026, 10, 11, 9, 31) },
    { id: "a2", role: "assistant", text: "Das finde ich gerade nicht.", at: Date.UTC(2026, 10, 11, 9, 31, 4), agent: "general", tool: "free", source: "KI",
      calls: [{ tool: "knowledge_search", ok: true, summary: "Wissen nachschlagen" }, { tool: "web", ok: false, summary: "Websuche" }, { tool: "free", ok: true, summary: "Antwort formulieren" }],
      models: [{ provider: "deepseek", model: "deepseek-flash", task: "supervise" },
        { provider: "local", model: qwen, task: "synthesize", fallback: true, reason: "Rate-Limit (HTTP 429)" }] },
    { id: "u3", role: "user", text: "Reicht mein Geld bis zum Monatsende?", at: Date.UTC(2026, 10, 11, 9, 32) },
    { id: "a3", role: "assistant", text: "Ja, knapp.", at: Date.UTC(2026, 10, 11, 9, 32, 6), agent: "budget", via: "orchestrator", ms: 5200, tool: "free", source: "KI",
      calls: [{ tool: "knowledge_search", ok: true, summary: "Wissen nachschlagen" },
        { tool: "agent.budget", ok: true, summary: "Frage Budget & Prognose", by: "orchestrator" },
        { tool: "pulse", ok: true, summary: "Monats-Puls", by: "budget" }, { tool: "forecast", ok: false, summary: "Kontoprognose", by: "budget" },
        { tool: "agent.research", ok: true, summary: "Frage Recherche & Wissen", by: "orchestrator" }, { tool: "web", ok: true, summary: "Websuche", by: "research" }] },
  ]);
  const [traced, newest, older] = [...screen.getByRole("list", { name: "Letzte Läufe" }).querySelectorAll<HTMLElement>(":scope > li")];
  const steps = [...within(traced).getByRole("list", { name: "Ablauf des Orchestrators" }).querySelectorAll<HTMLElement>(":scope > li")];
  expect(steps).toHaveLength(2);
  expect(steps[0].querySelector("p")?.textContent).toBe("Erfolgreich: Frage Budget & Prognose, Werkzeug agent.budget");
  expect(within(within(steps[0]).getByRole("list", { name: "Werkzeuge von Budget & Prognose" })).getAllByRole("listitem").map((chip) => chip.textContent))
    .toEqual(["Erfolgreich: Monats-Puls, Werkzeug pulse", "Fehlgeschlagen: Kontoprognose, Werkzeug forecast"]);
  expect(within(steps[1]).getByRole("list", { name: "Werkzeuge von Recherche & Wissen" }).textContent).toBe("Erfolgreich: Websuche, Werkzeug web");
  // Calls outside the agents stay flat.
  expect(within(traced).getByRole("list", { name: "Werkzeugaufrufe" }).textContent).toBe("Erfolgreich: Wissen nachschlagen, Werkzeug knowledge_search");
  expect(traced.textContent).toContain("Budget & Prognose·Orchestrator");

  expect(within(within(newest).getByRole("list", { name: "Werkzeugaufrufe" })).getAllByRole("listitem").map((chip) => chip.textContent)).toEqual([
    "Erfolgreich: Wissen nachschlagen, Werkzeug knowledge_search", "Fehlgeschlagen: Websuche, Werkzeug web", "Erfolgreich: Antwort formulieren, Werkzeug free",
  ]);
  expect(within(newest).queryByRole("list", { name: "Ablauf des Orchestrators" })).toBeNull();
  expect(within(newest).getByLabelText("Modelle").textContent).toBe("DeepSeek Flash·Lokal (Qwen) (Rückfall, weil DeepSeek: Rate-Limit (HTTP 429))");
  expect(older.textContent).toContain("Gehalt & Steuern·Regel");
  expect(within(older).getByText("Beantwortet")).toBeTruthy();
  expect(within(older).getByText("0,8 s")).toBeTruthy();
  expect(within(older).getByRole("listitem").textContent).toBe("Erfolgreich: Gehaltsübersicht, Werkzeug payroll");
});

it("explains an empty run list", () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  renderAdmin("laeufe");
  expect(screen.getByText("Noch keine Läufe")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Assistent öffnen" })).toBeTruthy();
});

it("tells other users that only the admin sees the agent repo", async () => {
  serve({ "/api/agent-repo": () => Response.json({ error: "nein" }, { status: 403 }) });
  renderAdmin("werkzeuge");
  expect(await screen.findByText("Das Werkzeug-Repo kann nur der Administrator ansehen und bearbeiten.")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("shows the feedback file for the admin only, and what the review agent changed with its checks, votes and a way back", async () => {
  const at = "2026-11-14T12:00:00.000Z";
  const base = { feedbackId: "fb-00000001", createdAt: at, updatedAt: at, question: "Welche Abos habe ich?", answer: "Netflix und Spotify." };
  let rules = [
    { ...base, id: "rule-0001", status: "active", comment: "Such mir eine günstigere Alternative.", kind: "prompt", scope: "all", target: "routing", appliedAt: at,
      rule: "Bei Fragen nach Alternativen hol die Verträge und recherchiere im Web.",
      prompt: { id: "supervisor", mode: "append", after: "Bei Fragen nach Alternativen hol die Verträge und recherchiere im Web." },
      review: { fixed: true, note: "Holt jetzt die Verträge und sucht im Web." }, votes: { up: 2, down: 0 },
      check: { at, model: "deepseek-flash", passed: true, baseline: { passed: 84, total: 86, hard: 0 }, candidate: { passed: 85, total: 86, hard: 0 } } },
    { ...base, id: "rule-0002", status: "rejected", comment: "Immer duzen bitte.", rule: "Sprich den Nutzer immer per Du an.", scope: "all", target: "answer",
      reason: "Gold-Eval mit Regel schlechter: 83/86 statt 84/86.",
      check: { at, model: "deepseek-flash", passed: false, baseline: { passed: 84, total: 86, hard: 0 }, candidate: { passed: 83, total: 86, hard: 0 } } },
    { ...base, id: "rule-0003", status: "vague", comment: "war schlecht", reason: "Zu vage – sag konkret, was falsch war oder gefehlt hat." },
    { ...base, id: "rule-0004", status: "checking", comment: "Bitte mit Quellen." },
  ];
  const patches: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/assistant-feedback") return Response.json({ file: "data/assistant-feedback.json", count: { total: 3, like: 1, dislike: 2, withComment: 1 },
      latest: [{ id: "fb-1", rating: "dislike", summary: "👎 Umsätze / query: „Wie viel für Essen?“ – Kommentar: „Zu hoch“", recordedAt: "2026-11-12T13:00:00.000Z" }] });
    if (url !== "/api/assistant-rules") return Response.json(cloudStatus());
    if (init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      rules = rules.map((rule) => rule.id === "rule-0001" ? { ...rule, status: "disabled" } : rule);
      return Response.json({ rule: rules[0] });
    }
    return Response.json({ file: "data/assistant-rules.json", loop: "bereit", count: {}, rules });
  }));
  renderAdmin("feedback");
  const feedback = within(screen.getByRole("region", { name: "Feedback" }));
  expect(await feedback.findByText("data/assistant-feedback.json")).toBeTruthy();
  expect(feedback.getByText("1 mit Kommentar")).toBeTruthy();
  expect(feedback.getByRole("link", { name: "Herunterladen" }).getAttribute("href")).toBe("/api/assistant-feedback?download=1");
  expect(feedback.getByRole("list", { name: "Neuestes Feedback" }).textContent).toContain("Umsätze / query: „Wie viel für Essen?“ – Kommentar: „Zu hoch“");

  const list = within(await within(screen.getByRole("region", { name: "Prüfungs-Agent" })).findByRole("list", { name: "Änderungen des Prüfungs-Agents" }));
  const [active, rejected, vague, checking] = list.getAllByRole("listitem");
  // A change from before the agent platform names its old prompt id; it shows the prompt that took over.
  expect(active.textContent).toContain("AktivPrompt ergänzt · Orchestrator · System-Prompt");
  expect(active.textContent).toContain("Nachtest: behoben – Holt jetzt die Verträge und sucht im Web.");
  expect(active.textContent).toContain("Gold-Eval ohne → mit Änderung: 84/86 → 85/86");
  expect(active.textContent).toContain("Seit der Änderung:Hilfreich: 2Nicht hilfreich: 0");
  expect(rejected.textContent).toContain("Regel · Antworten · alle Bereiche");
  expect(rejected.textContent).toContain("Gold-Eval mit Regel schlechter: 83/86 statt 84/86.");
  expect(within(rejected).getByRole("button", { name: "Erneut prüfen" })).toBeTruthy();
  expect(within(vague).queryByRole("button")).toBeNull();
  expect(checking.textContent).toContain("Der Prüfungs-Agent sieht sich den Kommentar an …");
  expect(checking.textContent).not.toContain("Keine Änderung");
  expect(screen.getByText("1 aktiv · Prüfung bereit")).toBeTruthy();
  fireEvent.click(within(active).getByRole("button", { name: "Änderung zurücknehmen: Bei Fragen nach Alternativen hol die Verträge und recherchiere im Web." }));
  await waitFor(() => expect(within(screen.getByRole("list", { name: "Änderungen des Prüfungs-Agents" })).getAllByRole("listitem")[0].textContent).toContain("Zurückgenommen"));
  expect(patches).toEqual([{ id: "rule-0001", action: "disable" }]);
  cleanup();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/assistant-feedback" ? Response.json({ error: "nein" }, { status: 403 }) : Response.json(cloudStatus())));
  renderAdmin("feedback");
  expect(await screen.findByText("Die Feedback-Datei kann nur der Administrator ansehen und herunterladen.")).toBeTruthy();
});
