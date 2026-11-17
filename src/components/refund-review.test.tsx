// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RefundReview } from "./refund-review";
import type { RefundQuestion } from "@/lib/refund-link";
import type { ReviewItem, Transaction } from "@/lib/types";

afterEach(cleanup);

const plain = (node: HTMLElement) => node.textContent!.replace(/\u00a0/g, " ");
const purchase = (id: string, date: string, amount: number, description: string): Transaction => ({
  id, date, amount, description, bank: "Amex", pocket: "Amex", category: "Restaurants", includeInPlan: true,
});
const credit = { id: "gourmet", date: "2026-11-02", amount: 48, description: "Gourmet Gutschrift", bank: "Amex", pocket: "Amex",
  category: "Prüfen" as const, includeInPlan: true };
const item: Extract<ReviewItem, { kind: "booking" }> = { kind: "booking", id: "gourmet", draft: credit, message: "Gutschrift" };
const question: RefundQuestion = {
  kind: "benefit", label: "Amex Gourmet-Gutschrift", suggested: "trattoria",
  candidates: [
    { booking: purchase("trattoria", "2026-10-30", -48, "Trattoria Sole"), paid: 48, refunded: 0, exact: true },
    { booking: purchase("sushi", "2026-10-25", -68.9, "Sushi Bar Mond"), paid: 68.9, refunded: 0, exact: false },
  ],
};

it("asks whether the credit refunds the suggested purchase and shows the own cost after it, like a changed fixed cost", () => {
  const save = vi.fn();
  const decline = vi.fn();
  render(<RefundReview item={item} draft={credit} question={question} disabled={false} save={save} decline={decline} />);
  const card = screen.getByRole("region", { name: "Gutschrift prüfen: Gourmet Gutschrift" });
  expect(plain(within(card).getByText(/^Eigenanteil/))).toBe("Eigenanteil 0,00 €");
  expect(within(card).getByLabelText("Erkannte Buchung: Trattoria Sole")).toBeTruthy();
  expect(within(card).queryByRole("radio")).toBeNull();
  expect(plain(card)).toContain("War das eine Rückerstattung für Trattoria Sole vom");
  expect(plain(card)).toContain("Amex nennt bei dieser Gutschrift nicht, für welchen Einkauf sie war.");

  // Another restaurant: picked from the list, the own cost follows.
  fireEvent.click(within(card).getByRole("button", { name: "Andere Buchung wählen" }));
  const radios = within(card).getAllByRole("radio");
  expect(radios).toHaveLength(2);
  fireEvent.click(radios[1]);
  expect(plain(within(card).getByText(/^Eigenanteil/))).toBe("Eigenanteil 20,90 €");
  fireEvent.click(within(card).getByRole("button", { name: "Rückerstattung übernehmen" }));
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ id: "gourmet", amount: 48, category: "Rückerstattungen", reviewed: true,
    sharedRefundFor: "sushi" }), "gourmet");

  fireEvent.click(within(card).getByRole("button", { name: "Keine Rückerstattung" }));
  expect(decline).toHaveBeenCalled();
});

it("lets the user pick the purchase first when nothing is clear", () => {
  render(<RefundReview item={item} draft={credit} question={{ ...question, suggested: undefined }} disabled={false} save={vi.fn()} decline={vi.fn()} />);
  const card = screen.getByRole("region", { name: "Gutschrift prüfen: Gourmet Gutschrift" });
  expect(within(card).getAllByRole("radio")).toHaveLength(2);
  expect(within(card).queryByText(/^Eigenanteil/)).toBeNull();
  expect(plain(card)).toContain("Für welche Buchung war die Gutschrift?");
  expect(within(card).getByRole("button", { name: "Rückerstattung übernehmen" })).toHaveProperty("disabled", true);
});
