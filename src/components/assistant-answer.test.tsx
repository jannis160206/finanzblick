// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AnswerLayout, AnswerProse } from "@/components/assistant-answer";
import { createEmptyAccountState } from "@/lib/account-state";
import type { AssistantCard } from "@/lib/types";

afterEach(cleanup);

const cards: AssistantCard[] = [
  { kind: "answer", title: "Monatsplan · November 2026", total: 1989, lines: [{ label: "Girokonto", value: -1989, tone: "bad" }, { label: "Einnahmen", value: 3000 }] },
  { kind: "forecast", title: "Kontoprognose", lines: [{ label: "Tiefster Stand", value: -3000.55, tone: "bad" }],
    chart: { type: "line", series: [{ name: "Kontostand", points: [{ label: "Nov", value: 1200 }, { label: "Dez", value: 900 }] }] } },
];

it("lays out key figures, one tile per result with its trend, and the full card on request", () => {
  render(<AnswerLayout cards={cards} state={createEmptyAccountState()} />);
  const kpis = within(screen.getByRole("list", { name: "Kennzahlen" })).getAllByRole("listitem").map((item) => item.textContent?.replace(/\u00a0/g, " "));
  expect(kpis).toEqual(["Monatsplan1.989,00 €November 2026", "Girokonto-1.989,00 € (negativ)", "Tiefster Stand-3.000,55 € (negativ)"]);
  expect(within(screen.getByRole("list", { name: "Ergebnisse" })).getAllByRole("article").map((tile) => tile.getAttribute("aria-label")))
    .toEqual(["Monatsplan · November 2026", "Kontoprognose"]);
  expect(screen.getByRole("img", { name: /^Verlauf Kontostand: Nov 1\.200,00\s€, Dez 900,00\s€$/ })).toBeTruthy();
  expect(screen.getByText("−25 %")).toBeTruthy();
  const details = screen.getAllByRole("button", { name: "Mehr" })[0];
  fireEvent.click(details);
  expect(details.getAttribute("aria-expanded")).toBe("true");
});

it("writes the key statement first and lets amounts stand out, a minus one in the negative colour", () => {
  const { container } = render(<AnswerProse text={"Nein, das passt gerade nicht.\n\nDein Girokonto steht bei −1.989 €, frei sind 412,50 €."} />);
  const paragraphs = container.querySelectorAll("p");
  expect(paragraphs).toHaveLength(2);
  expect(paragraphs[0].className).toContain("font-medium");
  expect([...container.querySelectorAll("span.font-semibold")].map((item) => [item.textContent, item.className.includes("text-destructive")]))
    .toEqual([["−1.989 €", true], ["412,50 €", false]]);
});
