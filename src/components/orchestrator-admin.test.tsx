// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrchestratorAdmin } from "@/components/orchestrator-admin";
import { useFinance } from "@/components/finance-provider";
import { createSeed } from "@/lib/seed";
import type { AppState } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.unstubAllGlobals());

function renderAdmin(chat: AppState["assistantChat"] = []) {
  const state = { ...createSeed(), assistantChat: chat };
  vi.mocked(useFinance).mockReturnValue({ state, ready: true, update: vi.fn() } as unknown as ReturnType<typeof useFinance>);
  return render(<OrchestratorAdmin />);
}

it("shows the tree, the agents with their models, the runs and the tools read-only", async () => {
  const fetcher = vi.fn(async (_url: string) => Response.json({ available: true, model: "OpenVINO/Qwen3-8B-int4-cw-ov", device: "NPU" }));
  vi.stubGlobal("fetch", fetcher);
  renderAdmin([
    { id: "u1", role: "user", text: "Wie viel netto bekomme ich?", at: Date.UTC(2026, 10, 11, 9, 30) },
    { id: "a1", role: "assistant", text: "Deine letzte Abrechnung …", at: Date.UTC(2026, 10, 11, 9, 30, 1), agent: "payroll", via: "rule", ms: 820 },
  ]);
  const tree = within(screen.getByRole("group", { name: "Orchestrator-Baum" }));
  expect(await tree.findByText("KI bereit · Qwen3-8B-int4-cw-ov")).toBeTruthy();
  expect(within(tree.getByRole("list", { name: "Entscheidungsschritte" })).getAllByRole("listitem")).toHaveLength(3);
  expect(within(tree.getByRole("list", { name: "Agenten" })).getAllByRole("listitem").map((item) => item.textContent))
    .toEqual(["Umsätze12 Werkzeuge", "Verträge4 Werkzeuge", "Budget & Prognose21 Werkzeuge", "Gehalt & Steuern3 Werkzeuge", "Allgemeiner ChatRückfall11 Werkzeuge"]);

  const agents = within(screen.getByRole("region", { name: "Agenten" }));
  expect(agents.getByRole("heading", { name: /Gehalt & Steuern/ })).toBeTruthy();
  const models = (text: string) => agents.getAllByText((_, element) => element?.tagName === "P" && element.textContent === text);
  expect(models("Werkzeugwahl: Qwen3-8B-int4-cw-ov · Antwort: Qwen3-8B-int4-cw-ov")).toHaveLength(4);
  expect(models("Antwort: Qwen3-8B-int4-cw-ov · Smalltalk ohne Modell")).toHaveLength(1);
  expect(agents.getByText("3 Werkzeuge · 1 Lauf")).toBeTruthy();

  const runs = within(screen.getByRole("list", { name: "Letzte Läufe" }));
  const [run] = runs.getAllByRole("listitem");
  expect(run.textContent).toContain("Wie viel netto bekomme ich?");
  expect(run.textContent).toContain("Gehalt & Steuern·Regel");
  expect(within(run).getByText("Beantwortet")).toBeTruthy();
  expect(within(run).getByText("0,8 s")).toBeTruthy();

  const tools = within(screen.getByRole("table", { name: "Werkzeuge je Agent" }));
  expect(tools.getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["Umsätze", "Verträge", "Budget & Prognose", "Gehalt & Steuern", "Allgemeiner Chat"]);
  expect(within(tools.getByRole("list", { name: "Werkzeuge Gehalt & Steuern" })).getAllByRole("listitem").map((item) => item.textContent))
    .toEqual(["Arbeitnehmerveranlagung", "Home-Office-Rechner", "Gehaltsübersicht"]);
  // Read-only: nothing to edit, only a refresh.
  expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Aktualisieren" }));
  await waitFor(() => expect(fetcher.mock.calls.filter(([url]) => url === "/api/ai/status")).toHaveLength(2));
});

it("explains an empty run list and an unreachable model", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
  renderAdmin();
  expect(await screen.findByText("KI nicht erreichbar · nur Regeln")).toBeTruthy();
  expect(screen.getByText("Noch keine Läufe")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Assistent öffnen" })).toBeTruthy();
});

it("shows where the feedback file lies, its counts and the latest entries, with a download for Copilot", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/assistant-feedback"
    ? Response.json({ file: "data/assistant-feedback.json", count: { total: 3, like: 1, dislike: 2, withComment: 1 },
      latest: [{ id: "fb-1", rating: "dislike", summary: "👎 Umsätze / query: „Wie viel für Essen?“ – Kommentar: „Zu hoch“", recordedAt: "2026-11-12T13:00:00.000Z" }] })
    : Response.json({ available: true, model: "OpenVINO/Qwen3-8B-int4-cw-ov" })));
  renderAdmin();
  const section = screen.getByRole("region", { name: "Feedback" });
  expect(await within(section).findByText("data/assistant-feedback.json")).toBeTruthy();
  expect(within(section).getByText("1 mit Kommentar")).toBeTruthy();
  expect(within(section).getByRole("link", { name: "Herunterladen" }).getAttribute("href")).toBe("/api/assistant-feedback?download=1");
  expect(within(section).getByRole("list", { name: "Neuestes Feedback" }).textContent).toContain("Umsätze / query: „Wie viel für Essen?“ – Kommentar: „Zu hoch“");
});

it("tells other users that only the admin sees the feedback file", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/assistant-feedback" ? Response.json({ error: "nein" }, { status: 403 })
    : Response.json({ available: false, model: "" })));
  renderAdmin();
  expect(await screen.findByText("Die Feedback-Datei kann nur der Administrator ansehen und herunterladen.")).toBeTruthy();
});
