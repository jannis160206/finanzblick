// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { Transactions } from "@/components/transactions";
import { useFinance } from "@/components/finance-provider";
import { lookupMerchant } from "@/lib/merchant-lookup-client";
import { merchantRuleKey } from "@/lib/import/merchant-rules";
import { queueLedgerReview } from "@/lib/import/review";
import { createSeed } from "@/lib/seed";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";

vi.mock("@/components/finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("@/components/statement-import", () => ({ StatementImport: () => null }));
vi.mock("@/lib/merchant-lookup-client", () => ({ lookupMerchant: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const booking: Transaction = {
  id: "unknown", date: "2026-09-10", bank: "Raiffeisen", pocket: "Raiffeisen Giro",
  description: "XQZ 9500 Villach", rawDescription: "POS XQZ 9500 Villach 3,50 AT D1 09.09. 11:53",
  rawDetails: ["Händler Ort: Villach", "PLZ: 9500"], amount: -3.5, category: "Prüfen", includeInPlan: true,
};
const hits = [
  { id: "1", name: "Blumenatelier", displayName: "Blumenatelier, Hauptplatz, Villach, 9500, Österreich" },
  { id: "2", name: "Spielwarenladen", displayName: "Spielwarenladen, Bahnhofstraße, Villach, 9500, Österreich" },
];
const originalLookup = () => screen.getAllByRole("button", { name: `Name nachschlagen: ${booking.description}` })[0];
let latest: AppState;
beforeEach(() => { vi.clearAllMocks(); vi.mocked(lookupMerchant).mockResolvedValue(hits); });
afterEach(cleanup);

function Fixture({ bookings }: { bookings?: Transaction[] }) {
  const [state, setState] = useState<AppState>(() => {
    const seed = createSeed();
    return queueLedgerReview({ ...seed, settings: { ...seed.settings, asOf: "2026-09-17" }, fixedReceipts: [],
      transactions: bookings ?? [
        booking, { ...booking, id: "twin", date: "2026-09-11" },
        ...["BILLA", "SPAR", "Shell", "Martin Auer", "BIPA"].map((description) => ({ ...booking, id: description, description })),
      ],
    });
  });
  useEffect(() => { latest = state; }, [state]);
  vi.mocked(useFinance).mockReturnValue({
    state, get dashboard(): never { throw new Error("Lookup must not calculate the dashboard"); },
    update: (updater) => setState((current) => appStateSchema.parse(queueLedgerReview(updater(current)))),
    replace: vi.fn(), openReviewCount: state.reviewQueue?.length ?? 0, ready: true, saved: true,
    storageError: null, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  return <Transactions />;
}

it("shows a muted lookup icon only for uncertain debits, never known merchants or automatically on render", () => {
  render(<Fixture />);
  expect(screen.getAllByRole("button", { name: /^Name nachschlagen:/ })).toHaveLength(2);
  for (const name of ["BILLA", "SPAR", "Shell", "Martin Auer", "BIPA"])
    expect(screen.queryByRole("button", { name: `Name nachschlagen: ${name}` })).toBeNull();
  const button = screen.getAllByRole("button", { name: /^Name nachschlagen:/ })[0];
  expect(button.className).toContain("size-9");
  expect(button.className).toContain("text-muted-foreground");
  expect(button.textContent).toBe("");
  expect(lookupMerchant).not.toHaveBeenCalled();
});

it("requires an explicit result and confirmation, then displays aliases without changing bank source fields", async () => {
  render(<Fixture />);
  const before = latest.transactions.slice(0, 2);
  const selectedId = originalLookup().dataset.bookingId;
  fireEvent.click(originalLookup());
  const dialog = screen.getByRole("dialog", { name: "Name nachschlagen" });
  await within(dialog).findByRole("radio", { name: /Blumenatelier/ });
  expect(lookupMerchant).toHaveBeenCalledExactlyOnceWith("XQZ 9500 Villach, AT");
  const confirm = within(dialog).getByRole<HTMLButtonElement>("button", { name: "Diesen Namen verwenden" });
  expect(confirm.disabled).toBe(true);
  expect(within(dialog).getByText("OpenStreetMap").parentElement?.textContent).toBe("© OpenStreetMap");
  fireEvent.click(within(dialog).getByRole("radio", { name: /Spielwarenladen/ }));
  expect(latest.transactions.slice(0, 2)).toEqual(before);
  fireEvent.click(confirm);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(latest.transactions.slice(0, 2)).toEqual(before.map((row) => ({
    ...row, merchantAlias: "Spielwarenladen",
    ...(row.id === selectedId ? { merchantNameConfirmed: true } :
      { merchantId: undefined, merchantLogo: false, merchantMatch: "rule", requires_manual_review: true }),
  })));
  expect(latest.transactions.filter(row => row.merchantNameConfirmed)).toHaveLength(1);
  expect(merchantRuleKey(latest.transactions[0])).toBe("raiffeisen|spielwarenladen");
  expect(within(screen.getByRole("table", { name: "Buchungen" })).getAllByText("Spielwarenladen")).toHaveLength(2);
  expect(screen.queryAllByRole("button", { name: /^Name nachschlagen:/ })).toHaveLength(0);
});

it("hides lookup on reviewed bookings, confirmed aliases, credits and zero amounts", () => {
  render(<Fixture bookings={[
    booking,
    { ...booking, id: "reviewed", reviewed: true, category: "Shopping", categoryOverride: true, manualCategory: true },
    { ...booking, id: "aliased", merchantAlias: "Blumenatelier" },
    { ...booking, id: "credit", amount: 3.5 },
    { ...booking, id: "zero", amount: 0 },
  ]} />);
  const buttons = screen.getAllByRole("button", { name: /^Name nachschlagen:/ });
  expect(buttons).toHaveLength(1);
  expect(buttons[0].dataset.bookingId).toBe(booking.id);
  expect(lookupMerchant).not.toHaveBeenCalled();
});

it("does not apply a result if the selected booking was reviewed while the dialog was open", async () => {
  render(<Fixture bookings={[booking]} />);
  fireEvent.click(originalLookup());
  fireEvent.click(await screen.findByRole("radio", { name: /Blumenatelier/ }));
  act(() => useFinance().update((state) => ({
    ...state,
    transactions: state.transactions.map((row) => row.id === booking.id
      ? { ...row, reviewed: true, category: "Shopping", categoryOverride: true, manualCategory: true }
      : row),
  })));
  const reviewedState = latest;
  fireEvent.click(screen.getByRole("button", { name: "Diesen Namen verwenden" }));
  expect(latest).toBe(reviewedState);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(toast.error).toHaveBeenCalledWith("Die Buchung wurde inzwischen geändert. Bitte erneut öffnen.");
});

it("cancels without learning from a result and leaves the row unchanged on network failure", async () => {
  render(<Fixture />);
  const before = latest;
  fireEvent.click(originalLookup());
  const option = await screen.findByRole("radio", { name: /Blumenatelier/ });
  fireEvent.click(option);
  fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
  expect(latest).toBe(before);
  vi.mocked(lookupMerchant).mockRejectedValueOnce(new Error("Zu viele Anfragen. Bitte später erneut versuchen."));
  fireEvent.click(originalLookup());
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Zu viele Anfragen. Bitte später erneut versuchen."));
  expect(latest).toBe(before);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not reopen a cancelled dialog when the in-flight search completes", async () => {
  let resolve!: (value: typeof hits) => void;
  vi.mocked(lookupMerchant).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
  render(<Fixture />);
  const before = latest;
  fireEvent.click(originalLookup());
  expect(screen.getByRole("status").textContent).toContain("Name wird gesucht");
  fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
  await act(async () => { resolve(hits); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(latest).toBe(before);
});
