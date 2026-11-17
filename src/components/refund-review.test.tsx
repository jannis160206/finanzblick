// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RefundReview } from "./refund-review";
import type { RefundCandidate, RefundQuestion } from "@/lib/refund-link";
import type { ReviewItem, Transaction } from "@/lib/types";

afterEach(cleanup);

const plain = (node: HTMLElement) => node.textContent!.replace(/\u00a0/g, " ");
const candidate = (id: string, date: string, paid: number, description: string, difference: number): RefundCandidate => ({
  booking: { id, date, amount: -paid, description, bank: "Amex", pocket: "Amex", category: "Restaurants", includeInPlan: true } as Transaction,
  paid, refunded: 0, exact: difference === 0, difference, sameMerchant: false,
});
const credit = { id: "gourmet", date: "2026-11-02", amount: 48, description: "Gourmet Gutschrift", bank: "Amex", pocket: "Amex",
  category: "Prüfen" as const, includeInPlan: true };
const item: Extract<ReviewItem, { kind: "booking" }> = { kind: "booking", id: "gourmet", draft: credit, message: "Gutschrift" };
const question: RefundQuestion = {
  kind: "benefit", label: "Amex Gourmet-Gutschrift", suggested: "trattoria",
  candidates: [candidate("trattoria", "2026-10-30", 48, "Trattoria Sole", 0), candidate("pizzeria", "2026-10-28", 52.5, "Pizzeria Luna", 4.5)],
};

it("lists the purchases with the amount of the credit below, preselects the clearest and shows the own cost after it", () => {
  const save = vi.fn();
  const decline = vi.fn();
  render(<RefundReview item={item} draft={credit} question={question} disabled={false} save={save} decline={decline} />);
  const card = screen.getByRole("region", { name: "Gutschrift prüfen: Gourmet Gutschrift" });
  const radios = within(card).getAllByRole<HTMLInputElement>("radio");
  expect(radios.map((radio) => radio.checked)).toEqual([true, false]);
  const label = (radio: HTMLInputElement) => radio.getAttribute("aria-label")!.replace(/\u00a0/g, " ");
  expect(label(radios[0])).toContain("gleicher Betrag");
  expect(label(radios[1])).toContain("4,50 € mehr");
  expect(plain(within(card).getByText(/^Eigenanteil/))).toBe("Eigenanteil 0,00 €");
  expect(plain(card)).toContain("War das eine Rückerstattung für Trattoria Sole vom");
  expect(plain(card)).toContain("Gesucht auf deiner Amex-Karte: gleicher Betrag oder etwas weniger bis etwas mehr.");

  fireEvent.click(radios[1]);
  expect(plain(within(card).getByText(/^Eigenanteil/))).toBe("Eigenanteil 4,50 €");
  fireEvent.click(within(card).getByRole("button", { name: "Rückerstattung übernehmen" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "gourmet", amount: 48, category: "Rückerstattungen", reviewed: true,
    sharedRefundFor: "pizzeria" }), "gourmet");
  fireEvent.click(within(card).getByRole("button", { name: "Keine Rückerstattung" }));
  expect(decline).toHaveBeenCalled();
});

it("shows a single purchase as the recognized booking, and asks to pick first when nothing is clear", () => {
  const { unmount } = render(<RefundReview item={item} draft={credit} question={{ ...question, candidates: question.candidates.slice(0, 1) }}
    disabled={false} save={vi.fn()} decline={vi.fn()} />);
  let card = screen.getByRole("region", { name: "Gutschrift prüfen: Gourmet Gutschrift" });
  expect(within(card).getByLabelText("Erkannte Buchung: Trattoria Sole")).toBeTruthy();
  expect(within(card).queryByRole("radio")).toBeNull();
  unmount();
  render(<RefundReview item={item} draft={credit} question={{ ...question, suggested: undefined }} disabled={false} save={vi.fn()} decline={vi.fn()} />);
  card = screen.getByRole("region", { name: "Gutschrift prüfen: Gourmet Gutschrift" });
  expect(within(card).getAllByRole<HTMLInputElement>("radio").some((radio) => radio.checked)).toBe(false);
  expect(within(card).queryByText(/^Eigenanteil/)).toBeNull();
  expect(plain(card)).toContain("Für welche Buchung war die Gutschrift?");
  expect(within(card).getByRole("button", { name: "Rückerstattung übernehmen" })).toHaveProperty("disabled", true);
});
