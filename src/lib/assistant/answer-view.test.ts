import { describe, expect, it } from "vitest";
import type { AssistantCard } from "@/lib/types";
import { answerKpis, tileLines, trendOf } from "./answer-view";
import { rawData } from "./conversation";
import { arithmetic, fixedCommand, fixedReply } from "./fixed-replies";

const plan: AssistantCard = { kind: "answer", title: "Monatsplan · November 2026", total: 1989, lines: [
  { label: "Einnahmen", value: 3000, detail: "laut Plan" },
  { label: "Girokonto", value: -1989, tone: "bad", detail: "knapp am 14.11." },
  { label: "Lebensmittel", value: 120, tone: "warn" },
  { label: "Sparziel Japan", value: 450, tone: "good" },
] };
const chart = (name: string, values: number[], kind: AssistantCard["kind"] = "answer"): AssistantCard =>
  ({ kind, title: name, lines: [], chart: { type: "line", series: [{ name, points: values.map((value, index) => ({ label: `M${index + 1}`, value })) }] } });

describe("answer layout data", () => {
  it("picks up to four key figures: totals first, then the lines the tools marked, with semantic tones", () => {
    expect(answerKpis([plan, { kind: "rule", title: "Regel-Vorschau", total: 3, lines: [] }])).toEqual([
      { label: "Monatsplan", hint: "November 2026", value: 1989, tone: "neutral" },
      { label: "Girokonto", value: -1989, tone: "negative" },
      { label: "Lebensmittel", value: 120, tone: "warning" },
      { label: "Sparziel Japan", value: 450, tone: "positive" },
    ]);
    expect(answerKpis([{ ...plan, lines: [{ label: "Überschuss laut Plan", value: 1989, tone: "good" }] }]).map((kpi) => kpi.label)).toEqual(["Monatsplan"]);
    expect(tileLines(plan, 2).map((line) => line.tone)).toEqual(["neutral", "negative"]);
  });

  it("colours a trend by what rising means: good for a balance, bad for spending, neutral when unknown or unchanged", () => {
    expect(trendOf(chart("Kontostand", [1200, 900]))).toMatchObject({ change: -300, percent: -25, tone: "negative" });
    expect(trendOf(chart("Ausgaben", [400, 520]))).toMatchObject({ change: 120, percent: 30, tone: "negative" });
    expect(trendOf(chart("Saldo", [100, 100], "forecast"))?.tone).toBe("neutral");
    expect(trendOf(chart("Restaurants", [80, 95]))?.tone).toBe("neutral");
    expect(trendOf(plan)).toBeUndefined();
  });

  it("hands the agents raw data: figures written out with their tone, the trend and the tool's finding", () => {
    const data = rawData("Monatsplan", "Was bleibt mir?", { text: "Dir bleiben 1.989 € im November.", card: { ...plan, chart: chart("Saldo", [10, 20]).chart } })
      .replace(/\u00a0/g, " ");
    expect(data).toContain("[Monatsplan] Was bleibt mir?");
    expect(data).toContain("Monatsplan · November 2026 · Summe 1.989,00 €");
    expect(data).toContain("- Girokonto: -1.989,00 € (knapp am 14.11.) [negativ]");
    expect(data).toContain("Verlauf Saldo: M1 10,00 € → M2 20,00 €");
    expect(data).toContain("Befund: Dir bleiben 1.989 € im November.");
  });

  it("keeps only system commands as fixed replies; answers to questions are left to the orchestrator", () => {
    // Arithmetic is computed by the code but worded by the orchestrator's answer; only without DeepSeek it is the reply itself.
    expect(fixedCommand("15 % von 2400")).toBeUndefined();
    expect(fixedReply("15 % von 2400")?.text).toBe("15 % von 2.400 sind 360.");
    expect(arithmetic("Rechne 1200 / 12")).toBe("1200 / 12 = 100");
    expect(fixedCommand("Wechsel in den Dark Mode")?.theme).toBe("dark");
    expect(fixedCommand("Öffne die Verträge")?.card?.page?.href).toBeTruthy();
    expect(fixedReply("Ich bin pleite")).toBeDefined();
    expect(fixedCommand("Ich bin pleite")).toBeUndefined();
    expect(fixedCommand("Wie wird das Wetter morgen?")).toBeUndefined();
  });
});
