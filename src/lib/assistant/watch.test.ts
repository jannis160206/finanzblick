import { describe, expect, it } from "vitest";
import { calculateDashboard } from "@/lib/calc";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import { emptySeen, escapeXml, findAlerts, parseSeen, rememberAlerts, toastLines, toastXml, type WatchAlert } from "./watch";

let counter = 0;
const row = (date: string, description: string, amount: number, category: Transaction["category"]): Transaction => ({
  id: `w${++counter}`, date, bank: "Raiffeisen", pocket: "Testkonto", description, amount, category, includeInPlan: true,
});

const stateWith = (transactions: Transaction[], extra: Partial<AppState> = {}): AppState => appStateSchema.parse({
  ...createSeed(), transactions, merchantRules: [], fixedReceipts: [], fixedAmountDecisions: [],
  ignoredStatementKeys: [], pocketSnapshots: [], accountSnapshots: [], reviewQueue: [], holidayRanges: [], ...extra,
});

const today = "2026-09-10";
const alertsFor = (state: AppState, seen = emptySeen()) => findAlerts(state, calculateDashboard(state), today, seen);
const kinds = (alerts: WatchAlert[]) => alerts.map((alert) => alert.kind);

describe("background watch", () => {
  it("reports due reminders, double charges and price increases", () => {
    const state = stateWith([
      row("2026-09-01", "Elektro Shop 1", -89.9, "Shopping"), row("2026-09-02", "Elektro Shop 1", -89.9, "Shopping"),
      ...[9.99, 9.99, 9.99, 12.99].map((amount, index) => row(`2026-0${5 + index}-15`, "Streamflix Abo", -amount, "Abonnements")),
    ], { assistantMemory: [
      { id: "r1", key: "reminder", text: "Versicherung kündigen (11. Sep.)", due: "2026-09-11", at: 1 },
      { id: "r2", key: "reminder", text: "Später erledigen (30. Okt.)", due: "2026-10-30", at: 2 },
    ] });
    const alerts = alertsFor(state);
    expect(kinds(alerts)).toEqual(expect.arrayContaining(["reminder", "duplicate", "price"]));
    expect(alerts.filter((alert) => alert.kind === "reminder")).toHaveLength(1);
    expect(alerts.find((alert) => alert.kind === "reminder")).toMatchObject({ title: "Erinnerung: Versicherung kündigen", detail: "fällig am 11.9.2026" });
    expect(alerts.find((alert) => alert.kind === "price")?.title).toContain("Streamflix");
    expect(alerts[0].kind).toBe("reminder");
  });

  it("uses the first run as baseline and reports large new bookings afterwards", () => {
    const history = [1, 2, 3, 4, 5, 6].map((month) => row(`2026-0${month}-05`, "Supermarkt Nord", -60, "Lebensmittel"));
    const first = stateWith(history);
    expect(kinds(alertsFor(first))).not.toContain("booking");
    const seen = rememberAlerts(emptySeen(), [], first, today);
    const big = row("2026-09-08", "Möbelhaus Süd", -850, "Möbel & Einrichtung");
    const usual = row("2026-09-08", "Supermarkt Nord", -62, "Lebensmittel");
    const alerts = alertsFor(stateWith([...history, big, usual]), seen).filter((alert) => alert.kind === "booking");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("Möbelhaus Süd");
  });

  it("does not repeat alerts that were already reported", () => {
    const state = stateWith([row("2026-09-01", "Elektro Shop 1", -89.9, "Shopping"), row("2026-09-02", "Elektro Shop 1", -89.9, "Shopping")]);
    const alerts = alertsFor(state);
    expect(alerts.length).toBeGreaterThan(0);
    const seen = parseSeen(JSON.stringify(rememberAlerts(emptySeen(), alerts, state, today)));
    expect(alertsFor(state, seen)).toEqual([]);
    expect(parseSeen("kaputt")).toEqual(emptySeen());
  });

  it("caps the toast at three lines", () => {
    const alert = (index: number): WatchAlert => ({ key: `k${index}`, kind: "reminder", title: `Hinweis ${index}`, detail: "Detail", tone: "warn" });
    expect(toastLines([alert(1), alert(2)])).toEqual(["Hinweis 1 – Detail", "Hinweis 2 – Detail"]);
    const lines = toastLines([1, 2, 3, 4, 5].map(alert));
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("+ 3 weitere Hinweise im Finanz-Assistenten");
  });

  it("escapes toast XML and opens the assistant on click", () => {
    expect(escapeXml(`A & B <c> "d" 'e'\u0007`)).toBe("A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;");
    const xml = toastXml("Finanzblick", ["Bäcker & Söhne <script>", "zweite", "dritte", "vierte"], "http://127.0.0.1:3000/assistent?a=1&b=2");
    expect(xml).toContain("Bäcker &amp; Söhne &lt;script&gt;");
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("vierte");
    expect(xml).toContain('activationType="protocol" launch="http://127.0.0.1:3000/assistent?a=1&amp;b=2"');
    expect(xml).toContain('placement="attribution"');
    expect(new DOMParserLike(xml).ok).toBe(true);
  });
});

// Minimal well-formedness check without a DOM: every opened tag is closed in order.
class DOMParserLike {
  ok: boolean;
  constructor(xml: string) {
    const stack: string[] = [];
    let ok = true;
    for (const match of xml.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
      if (match[3]) continue;
      if (match[1]) ok &&= stack.pop() === match[2];
      else stack.push(match[2]);
    }
    this.ok = ok && stack.length === 0;
  }
}
