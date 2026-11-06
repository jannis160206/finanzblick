import { describe, expect, it } from "vitest";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import { assistantCardSchema, type AppState, type Transaction } from "@/lib/types";
import { executeTool } from "./agent";
import { cancelAnswer, cancelQuestion, cancellationLetter } from "./cancel";
import { detectTool } from "./tools";
import { whyAnswer, whyQuestion } from "./why";

const today = "2026-10-07";
const booking = (id: string, date: string, description: string, amount: number, category: Transaction["category"], extra: Partial<Transaction> = {}): Transaction =>
  ({ id, date, bank: "Raiffeisen", pocket: "Raiffeisen Giro", description, amount, category, includeInPlan: true, ...extra });

function fixture(): AppState {
  const state = createEmptyAccountState();
  state.settings.asOf = today;
  state.transactions = [
    ...["2026-07-03", "2026-08-03", "2026-09-03"].map((date, index) => booking(`nf-${index}`, date, "NETFLIX.COM", index === 2 ? -15.99 : -13.99, "Abonnements")),
    ...["2026-07-10", "2026-08-10", "2026-09-10"].map((date, index) => booking(`a1-${index}`, date, "A1 TELEKOM HANDY", -39.9, "Handyvertrag")),
    booking("billa-1", "2026-09-20", "BILLA DANKT", -30, "Lebensmittel"),
    booking("billa-2", "2026-10-01", "BILLA DANKT", -12, "Lebensmittel", { manualCategory: true }),
  ];
  return state;
}

describe("Kündigungshilfe", () => {
  it("routes cancel phrases without stealing reminders or what-ifs", () => {
    expect(detectTool("Kündige Netflix")).toBe("cancel");
    expect(detectTool("Hilf mir den Handyvertrag zu kündigen")).toBe("cancel");
    expect(detectTool("Welche Verträge kann ich kündigen?")).toBe("cancel");
    expect(detectTool("Erinner mich am 1. Dezember die Kfz-Versicherung zu kündigen")).toBe("reminder");
    expect(cancelQuestion("was wäre wenn ich netflix kündige")).toBe(false);
    expect(cancelQuestion("mein job wurde gekündigt, was jetzt")).toBe(false);
  });

  it("explains one contract with costs, notice, link and letter", () => {
    const result = cancelAnswer(fixture(), "Kündige Netflix", today);
    expect(result.card?.kind).toBe("cancel");
    expect(assistantCardSchema.safeParse(result.card).success).toBe(true);
    expect(result.card?.links?.some((link) => link.url.startsWith("https://www.netflix.com"))).toBe(true);
    expect(result.card?.letter).toMatch(/Bitte bestätigen Sie mir die Kündigung schriftlich/);
    expect(result.card?.lines.some((line) => /Preis/.test(line.label))).toBe(true);
    expect(result.suggestions?.some((text) => /^Erinner mich am .*kündigen$/.test(text))).toBe(true);
    expect(detectTool(result.suggestions!.find((text) => text.startsWith("Erinner"))!)).toBe("reminder");
  });

  it("lists contracts sorted by yearly cost", () => {
    const result = cancelAnswer(fixture(), "Welche Verträge kann ich kündigen?", today);
    expect(result.card?.lines.map((line) => line.label)).toEqual(["A1 TELEKOM HANDY", "NETFLIX.COM"]);
    expect(result.card?.lines[0].value).toBeGreaterThan(result.card!.lines[1].value!);
  });

  it("writes a formal letter with placeholders", () => {
    const letter = cancellationLetter("Magenta", "mobile", today);
    expect(letter).toMatch(/\[Kundennummer\]|Kundennummer/);
    expect(letter).toMatch(/Mit freundlichen Grüßen/);
  });
});

describe("Warum diese Kategorie?", () => {
  it("detects why questions but leaves rules and spending questions alone", () => {
    expect(detectTool("Warum ist Billa Lebensmittel?")).toBe("why");
    expect(whyQuestion("warum habe ich so viel ausgegeben")).toBe(false);
    expect(detectTool("Lieferando ist immer Lieferdienste")).toBe("rule");
  });

  it("explains the latest booking of a merchant", () => {
    const result = whyAnswer(fixture(), "Warum ist Billa Lebensmittel?");
    expect(result.card?.kind).toBe("why");
    expect(assistantCardSchema.safeParse(result.card).success).toBe(true);
    expect(result.card?.lines.find((line) => line.label === "Quelle")?.detail ?? JSON.stringify(result.card)).toMatch(/Manuell|selbst/);
    const state = fixture();
    const tool = executeTool("why", "Warum ist Billa Lebensmittel?", { state, dashboard: calculateDashboard(state), asOf: today });
    expect(tool.card?.kind).toBe("why");
  });
});
