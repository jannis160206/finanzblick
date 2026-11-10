// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountWorkspaceContext, type AccountWorkspace } from "@/components/account-context";
import { PayslipPasswordSettings } from "@/components/payslip-password-settings";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const workspace: AccountWorkspace = { user: { id: "own-account", username: "synthetic", role: "admin" }, loadServer: async () => {} };
let stored: { updatedAt: number } | null;
const calls: { method: string; url: string; body?: unknown; account: string | null }[] = [];

beforeEach(() => {
  stored = null;
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body, account: new Headers(init.headers).get("X-Finanzblick-Account") });
    if (method === "PUT") stored = { updatedAt: Date.UTC(2026, 10, 10) };
    if (method === "DELETE") stored = null;
    return Response.json(stored ? { stored: true, updatedAt: stored.updatedAt } : { stored: false });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const mount = () => render(<AccountWorkspaceContext value={workspace}><PayslipPasswordSettings /></AccountWorkspaceContext>);

it("stores a new password through the account API, shows only its status and removes it after confirmation", async () => {
  mount();
  const section = within(screen.getByRole("region", { name: "PDF-Passwort" }));
  expect(await section.findByText("Kein Passwort hinterlegt")).toBeTruthy();
  const field = section.getByLabelText("PDF-Passwort");
  expect(field.getAttribute("type")).toBe("password");
  fireEvent.change(field, { target: { value: "synthetisch-123" } });
  fireEvent.click(section.getByRole("button", { name: "Speichern" }));
  expect(await section.findByText("Passwort hinterlegt")).toBeTruthy();
  expect(section.getByText(/verschlüsselt auf deinem Server/)).toBeTruthy();
  expect(calls.find((call) => call.method === "PUT")).toMatchObject({ body: { password: "synthetisch-123" }, account: "own-account" });
  expect(section.queryByDisplayValue("synthetisch-123")).toBeNull();
  expect(calls.some((call) => call.url.includes("reveal"))).toBe(false);

  fireEvent.click(section.getByRole("button", { name: "PDF-Passwort entfernen" }));
  const dialog = within(screen.getByRole("dialog", { name: "PDF-Passwort entfernen?" }));
  fireEvent.click(dialog.getByRole("button", { name: "Entfernen" }));
  expect(await section.findByText("Kein Passwort hinterlegt")).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("replaces a stored password only after entering a new one", async () => {
  stored = { updatedAt: Date.UTC(2026, 9, 1) };
  mount();
  const section = within(screen.getByRole("region", { name: "PDF-Passwort" }));
  expect(await section.findByText("Passwort hinterlegt")).toBeTruthy();
  expect(section.queryByLabelText("Neues PDF-Passwort")).toBeNull();
  fireEvent.click(section.getByRole("button", { name: "Ändern" }));
  expect(section.getByRole<HTMLButtonElement>("button", { name: "Speichern" }).disabled).toBe(true);
  fireEvent.change(section.getByLabelText("Neues PDF-Passwort"), { target: { value: "neu-456" } });
  fireEvent.click(section.getByRole("button", { name: "Speichern" }));
  await waitFor(() => expect(section.queryByLabelText("Neues PDF-Passwort")).toBeNull());
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
});

it("explains that browsers without secure storage cannot keep a password", () => {
  render(<PayslipPasswordSettings />);
  expect(screen.getByText(/keinen sicheren Speicher/)).toBeTruthy();
});
