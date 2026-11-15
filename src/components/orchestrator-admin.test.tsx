// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrchestratorAdmin, OrchestratorShell } from "@/components/orchestrator-admin";
import { OrchestratorSettingsLinks } from "@/components/orchestrator-nav";
import { useFinance } from "@/components/finance-provider";
import type { OrchestratorView } from "@/lib/assistant/orchestrator-pages";
import { createSeed } from "@/lib/seed";
import type { AppState } from "@/lib/types";

const navigation = vi.hoisted(() => ({ pathname: "/einstellungen/orchestrator/aufbau" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));
vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.unstubAllGlobals());

const qwen = "OpenVINO/Qwen3-8B-int4-cw-ov";
function renderAdmin(view: OrchestratorView, chat: AppState["assistantChat"] = []) {
  navigation.pathname = `/einstellungen/orchestrator/${view}`;
  const state = { ...createSeed(), assistantChat: chat };
  vi.mocked(useFinance).mockReturnValue({ state, ready: true, update: vi.fn() } as unknown as ReturnType<typeof useFinance>);
  return render(<OrchestratorShell><OrchestratorAdmin view={view} /></OrchestratorShell>);
}
const cloudStatus = (extra: object = {}) => ({
  available: true, model: "deepseek-flash", label: "DeepSeek Flash", device: "Cloud", local: { available: true, model: qwen },
  cloud: { provider: "deepseek", available: true, models: { fast: "deepseek-flash", pro: "deepseek-v4-pro", reasoning: "deepseek-v4-pro" } },
  routing: [["chat", "DeepSeek Flash"], ["supervise", "DeepSeek Flash"], ["synthesize", "DeepSeek V4 Pro"], ["action", "DeepSeek V4 Pro"],
    ["reasoning", "DeepSeek V4 Pro · Denkmodus"], ["document", "Lokal (Qwen)"]]
    .map(([task, label]) => ({ task, label, model: label.startsWith("Lokal") ? qwen : "deepseek", ...(label.startsWith("Lokal") ? { fallback: true } : {}) })),
  ...extra,
});

it("shows the structure as a tree from the orchestrator to the tools, the models and what DeepSeek costs", async () => {
  const fetcher = vi.fn(async (_url: string) => Response.json(cloudStatus({ usage: {
    "deepseek-flash": { calls: 2, input: 3000, output: 200, cached: 1000 }, "deepseek-v4-pro": { calls: 1, input: 4000, output: 250, cached: 0 }, [qwen]: { calls: 3, input: 900, output: 90, cached: 0 },
  } })));
  vi.stubGlobal("fetch", fetcher);
  renderAdmin("aufbau");
  expect(screen.getByRole("link", { name: "Aufbau & Topologie" }).getAttribute("aria-current")).toBe("page");
  const tree = within(screen.getByRole("group", { name: "Orchestrator-Baum" }));
  expect(await tree.findByText("KI bereit · DeepSeek Flash · Qwen als Rückfall")).toBeTruthy();
  expect(tree.getByRole("list", { name: "Wege des Orchestrators" }).querySelectorAll(":scope > li")).toHaveLength(3);
  expect(tree.getByRole("list", { name: "Spezialisten" }).querySelectorAll(":scope > li")).toHaveLength(6);
  expect(within(tree.getByRole("list", { name: "Werkzeuge im Baum: Gehalt & Steuern" })).getAllByRole("listitem").map((item) => item.textContent))
    .toEqual(["Arbeitnehmerveranlagung", "Home-Office-Rechner", "Gehaltsübersicht", "Abrechnungen bearbeiten(ändert Daten)"]);
  expect(tree.getByText("Plant:").parentElement?.textContent).toBe("Plant:DeepSeek Flash");
  expect(tree.getByText("Schreibt:").parentElement?.textContent).toBe("Schreibt:DeepSeek V4 Pro");

  const perTask = within(screen.getByRole("list", { name: "Modell je Aufgabe" })).getAllByRole("listitem").map((item) => item.textContent);
  expect(perTask).toContain("SupervisorDeepSeek Flash");
  expect(perTask).toContain("Supervisor-AntwortDeepSeek V4 Pro");
  expect(perTask).toContain("DokumentLokal (Qwen) · Rückfall");
  // Measured: one V4 Pro answer plus two Flash calls per question; the local model costs nothing.
  const costs = within(screen.getByRole("list", { name: "Kosten je Modell" })).getAllByRole("listitem").map((item) => item.textContent);
  expect(costs).toEqual(["deepseek-flash · 2×0,0008 $", "deepseek-v4-pro · 1×0,0063 $"]);
  expect(screen.getByText("≈ 0,71 Cent")).toBeTruthy();
  expect(screen.getByText("≈ 702")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Aktualisieren" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/ai/status")).toHaveLength(2));
});

it("edits an agent's system prompt, saves it and puts it back to the default", async () => {
  const entry = (id: string, group: string, label: string, text: string, custom = false) =>
    ({ id, group, label, hint: "Hinweis", default: "Standardtext", text, custom });
  let prompts = [entry("supervisor", "supervisor", "Planung (DeepSeek Flash)", "Standardtext"), entry("voice.budget", "budget", "Stimme", "Standardtext")];
  const puts: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== "/api/agent-prompts") return Response.json(cloudStatus());
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as { id: string; text?: string };
      puts.push(body);
      prompts = prompts.map((item) => item.id === body.id ? { ...item, text: body.text ?? item.default, custom: !!body.text } : item);
    }
    return Response.json({ file: "config/agent-prompts.json", prompts });
  }));
  renderAdmin("agenten");
  expect(await screen.findByText("0 von 2 angepasst")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stimme" }));
  const field = screen.getByRole("textbox", { name: "System-Prompt: Budget & Prognose · Stimme" });
  const save = screen.getByRole("button", { name: "Speichern" });
  expect(save.hasAttribute("disabled")).toBe(true);
  fireEvent.change(field, { target: { value: "Du bist ein strenger Budget-Coach." } });
  fireEvent.click(save);
  expect(await screen.findByText("Gespeichert – gilt ab der nächsten Frage.")).toBeTruthy();
  expect(screen.getByText("Angepasst")).toBeTruthy();
  expect(screen.getByText("1 von 2 angepasst")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Auf Standard zurücksetzen" }));
  expect(await screen.findByText("Auf Standard zurückgesetzt – gilt ab der nächsten Frage.")).toBeTruthy();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Standardtext");
  expect(puts).toEqual([{ id: "voice.budget", text: "Du bist ein strenger Budget-Coach." }, { id: "voice.budget", reset: true }]);
  // The agents with the model of each step are on the same page.
  const agents = within(screen.getByRole("region", { name: "Agenten" }));
  expect(agents.getAllByText((_, element) => element?.tagName === "P"
    && element.textContent === "Werkzeugwahl: DeepSeek Flash · Aktion: DeepSeek V4 Pro · Antwort: DeepSeek V4 Pro · Steuer-Analyse: DeepSeek V4 Pro · Denkmodus")).toHaveLength(4);
});

it("tells other users that only the admin edits the prompts", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/agent-prompts" ? Response.json({ error: "nein" }, { status: 403 }) : Response.json(cloudStatus())));
  renderAdmin("agenten");
  expect(await screen.findByText("Die Prompts kann nur der Administrator ansehen und bearbeiten.")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("lists each run with agent, route, models, duration and its tool calls in words", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(cloudStatus())));
  renderAdmin("laeufe", [
    { id: "u1", role: "user", text: "Wie viel netto bekomme ich?", at: Date.UTC(2026, 10, 11, 9, 30) },
    { id: "a1", role: "assistant", text: "Deine letzte Abrechnung …", at: Date.UTC(2026, 10, 11, 9, 30, 1), agent: "payroll", via: "rule", ms: 820, tool: "payroll" },
    { id: "u2", role: "user", text: "Wie hoch ist die Geringfügigkeitsgrenze?", at: Date.UTC(2026, 10, 11, 9, 31) },
    { id: "a2", role: "assistant", text: "Das finde ich gerade nicht.", at: Date.UTC(2026, 10, 11, 9, 31, 4), agent: "general", tool: "free", source: "KI",
      calls: [{ tool: "knowledge_search", ok: true, summary: "Wissen nachschlagen" }, { tool: "web", ok: false, summary: "Websuche" }, { tool: "free", ok: true, summary: "Antwort formulieren" }],
      models: [{ provider: "deepseek", model: "deepseek-flash", task: "supervise" },
        { provider: "local", model: qwen, task: "synthesize", fallback: true, reason: "Rate-Limit (HTTP 429)" }] },
  ]);
  const [newest, older] = [...screen.getByRole("list", { name: "Letzte Läufe" }).querySelectorAll<HTMLElement>(":scope > li")];
  expect(within(within(newest).getByRole("list", { name: "Werkzeugaufrufe" })).getAllByRole("listitem").map((chip) => chip.textContent)).toEqual([
    "Erfolgreich: Wissen nachschlagen, Werkzeug knowledge_search", "Fehlgeschlagen: Websuche, Werkzeug web", "Erfolgreich: Antwort formulieren, Werkzeug free",
  ]);
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

it("lists the tools of each agent and marks those that change data", () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(cloudStatus())));
  renderAdmin("werkzeuge");
  const tools = within(screen.getByRole("table", { name: "Werkzeuge je Agent" }));
  expect(tools.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["Umsätze", "Verträge", "Budget & Prognose", "Gehalt & Steuern", "Allgemeiner Chat"]);
  expect(within(tools.getByRole("list", { name: "Werkzeuge Gehalt & Steuern" })).getAllByRole("listitem").map((item) => item.textContent))
    .toEqual(["Arbeitnehmerveranlagung", "Home-Office-Rechner", "Gehaltsübersicht", "Abrechnungen bearbeiten(ändert Daten)"]);
});

it("says when DeepSeek or the whole AI is unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ available: true, model: qwen, label: "Lokal (Qwen)", device: "NPU", local: { available: true, model: qwen },
    cloud: { provider: "deepseek", available: false, error: "Key ungültig (HTTP 401)", models: { fast: "deepseek-flash", pro: "deepseek-v4-pro", reasoning: "deepseek-v4-pro" } },
    routing: [] })));
  renderAdmin("aufbau");
  expect(await screen.findByText("Lokal (Qwen) aktiv · DeepSeek Key ungültig (HTTP 401)")).toBeTruthy();
  cleanup();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  renderAdmin("aufbau");
  expect(await screen.findByText("KI nicht erreichbar · nur Regeln")).toBeTruthy();
});

it("shows the feedback file for the admin only, and the rules learned from it with a switch", async () => {
  const at = "2026-11-14T12:00:00.000Z";
  const base = { feedbackId: "fb-00000001", createdAt: at, updatedAt: at, question: "Welche Abos habe ich?", answer: "Netflix und Spotify." };
  let rules = [
    { ...base, id: "rule-0001", status: "active", comment: "Mir fehlt der Jahresbetrag.", rule: "Nenne bei Abos auch den Jahresbetrag.", scope: "contracts", target: "answer",
      check: { at, model: "deepseek-flash", passed: true, baseline: { passed: 84, total: 86, hard: 0 }, candidate: { passed: 85, total: 86, hard: 0 } } },
    { ...base, id: "rule-0002", status: "rejected", comment: "Immer duzen bitte.", rule: "Sprich den Nutzer immer per Du an.", scope: "all", target: "answer",
      reason: "Gold-Eval mit Regel schlechter: 83/86 statt 84/86.",
      check: { at, model: "deepseek-flash", passed: false, baseline: { passed: 84, total: 86, hard: 0 }, candidate: { passed: 83, total: 86, hard: 0 } } },
    { ...base, id: "rule-0003", status: "vague", comment: "war schlecht", reason: "Zu vage – sag konkret, was falsch war oder gefehlt hat." },
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

  const list = within(await screen.findByRole("list", { name: "Regeln aus Feedback" }));
  const [active, rejected, vague] = list.getAllByRole("listitem");
  expect(active.textContent).toContain("AktivAntworten · Verträge");
  expect(active.textContent).toContain("Gold-Eval ohne → mit Regel: 84/86 → 85/86");
  expect(rejected.textContent).toContain("Gold-Eval mit Regel schlechter: 83/86 statt 84/86.");
  expect(within(rejected).getByRole("button", { name: "Erneut prüfen" })).toBeTruthy();
  expect(within(vague).queryByRole("button")).toBeNull();
  expect(screen.getByText("1 aktiv · Prüfung bereit")).toBeTruthy();
  fireEvent.click(within(active).getByRole("button", { name: "Regel deaktivieren: Nenne bei Abos auch den Jahresbetrag." }));
  await waitFor(() => expect(within(screen.getByRole("list", { name: "Regeln aus Feedback" })).getAllByRole("listitem")[0].textContent).toContain("Deaktiviert"));
  expect(patches).toEqual([{ id: "rule-0001", action: "disable" }]);
  cleanup();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/assistant-feedback" ? Response.json({ error: "nein" }, { status: 403 }) : Response.json(cloudStatus())));
  renderAdmin("feedback");
  expect(await screen.findByText("Die Feedback-Datei kann nur der Administrator ansehen und herunterladen.")).toBeTruthy();
});

it("folds the orchestrator's subpages out of the settings link with its arrow", () => {
  render(<OrchestratorSettingsLinks />);
  expect(screen.getByRole("link", { name: "Assistent-Orchestrator" }).getAttribute("href")).toBe("/einstellungen/orchestrator/aufbau");
  const arrow = screen.getByRole("button", { name: "Orchestrator-Unterseiten anzeigen" });
  expect(arrow.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("list", { name: "Orchestrator-Unterseiten" })).toBeNull();
  fireEvent.click(arrow);
  expect(arrow.getAttribute("aria-expanded")).toBe("true");
  expect(within(screen.getByRole("list", { name: "Orchestrator-Unterseiten" })).getAllByRole("link").map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
    ["Aufbau & Topologie", "/einstellungen/orchestrator/aufbau"], ["Agenten & Prompts", "/einstellungen/orchestrator/agenten"],
    ["Letzte Läufe", "/einstellungen/orchestrator/laeufe"], ["Werkzeuge", "/einstellungen/orchestrator/werkzeuge"], ["Feedback & Regeln", "/einstellungen/orchestrator/feedback"],
  ]);
});
