// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BankConnections } from "./bank-connections";
import { AccountWorkspaceContext } from "./account-context";
import { useFinance } from "./finance-provider";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";
import type { BankChoice, BankStatus } from "@/lib/banking/sync";

vi.mock("./finance-provider", () => ({ useFinance: vi.fn() }));
vi.mock("./security-mode-provider", () => ({ useSecurityMode: () => ({ locked: false }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const workspace = { user: { id: "alice", username: "alice", role: "user" as const } } as ComponentProps<typeof AccountWorkspaceContext.Provider>["value"];

function status(patch: Partial<BankStatus> = {}): BankStatus {
  return {
    available: true, configured: true, provider: "enablebanking", lastSync: Date.now() - 2 * 3_600_000, lastSyncRows: 12, lastError: null,
    connections: [
      { id: "c1", bankName: "Raiffeisenbank Kärnten", bic: "RZKTAT2K", syncActive: true, message: null, consentValidUntil: "2027-03-01T00:00:00Z", lastSynced: null, testmode: false, country: "AT" },
      { id: "c2", bankName: "Revolut", bic: null, syncActive: true, message: null, consentValidUntil: "2026-10-12T00:00:00Z", lastSynced: null, testmode: false, country: "AT" },
    ],
    accounts: [
      { id: "a1", connectionId: "c1", bank: "Raiffeisen", pocket: "Raiffeisen Giro", label: "Persönliches Konto", iban: "AT61 1904 3002 3457 3201", balance: 1834.2, available: null, balanceDate: null, syncedAt: null, fetchedRows: null, balanceOk: null, syncError: null },
    ],
    ...patch,
  };
}

const banks: BankChoice[] = [
  { name: "Erste Bank und Sparkassen", country: "AT", logo: null },
  { name: "Raiffeisenbank Kärnten", country: "AT", logo: null },
  { name: "Revolut", country: "AT", logo: null },
];

function mount(current: BankStatus) {
  const state = createEmptyAccountState();
  state.settings.asOf = "2026-10-07";
  state.accountSnapshots = [{ bank: "Revolut", name: "Persönliches Konto", date: "2026-10-06", balance: 10 }];
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), update: vi.fn(), replace: vi.fn(), ready: true, saved: true,
    storageError: null, openReviewCount: 0, retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.includes("?banks=")) return Response.json({ banks });
    if (init?.method === "POST") return Response.json({ redirectUrl: "https://bank.example/login" });
    return Response.json(current);
  }));
  render(<AccountWorkspaceContext.Provider value={workspace}><BankConnections /></AccountWorkspaceContext.Provider>);
  return calls;
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("bank connections", () => {
  it("shows each bank with its mark, status and masked accounts", async () => {
    mount(status());
    const section = await screen.findByRole("region", { name: "Bankverbindung" });
    await within(section).findByText("Raiffeisenbank Kärnten");
    const row = within(section).getByText("Raiffeisenbank Kärnten").closest("li")!;
    expect(row.querySelector("img")?.getAttribute("src")).toContain("/api/banks/logo?name=");
    expect(within(row).getByText("Aktiv")).toBeTruthy();
    expect(within(row).getByText(/AT61 •••• 3201/)).toBeTruthy();
    const revolut = within(section).getByText("Revolut").closest("li")!;
    expect(within(revolut).getByText("Freigabe endet in 5 Tagen")).toBeTruthy();
    expect(within(revolut).getByRole("button", { name: "Revolut: Freigabe erneuern" })).toBeTruthy();
    expect(within(section).getByText(/Zuletzt abgerufen vor 2 Std\. · 12 Umsätze/)).toBeTruthy();
  });

  it("adds a bank from a searchable list with logos and the keyboard", async () => {
    const calls = mount(status());
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    fireEvent.click(await screen.findByRole("button", { name: "Bank hinzufügen" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Bank hinzufügen" }));
    const list = await dialog.findByRole("listbox", { name: "Banken" });
    expect(within(list).getByRole("group", { name: "Deine Banken" }).textContent).toContain("Revolut");
    expect(within(list).getAllByRole("option").every((option) => option.querySelector("img"))).toBe(true);
    const search = dialog.getByRole("combobox", { name: "Bank auswählen" });
    fireEvent.change(search, { target: { value: "erste" } });
    expect(dialog.getAllByRole("option")).toHaveLength(1);
    expect(dialog.getByRole("option", { name: "Erste Bank und Sparkassen" })).toBeTruthy();
    expect((dialog.getByRole("button", { name: "Bank verbinden" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(dialog.getByRole("option", { name: /Erste Bank/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(dialog.getByRole("button", { name: "Bank verbinden" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ action: "connect", country: "AT", aspsp: "Erste Bank und Sparkassen" });
  });

  it("asks before disconnecting a bank", async () => {
    const calls = mount(status());
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Raiffeisenbank Kärnten: Aktionen" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Trennen" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Raiffeisenbank Kärnten trennen?" }));
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    fireEvent.click(dialog.getByRole("button", { name: "Trennen" }));
    await waitFor(() => expect(calls.some((call) => call.method === "DELETE" && call.url.includes("connection=c1"))).toBe(true));
  });
});
