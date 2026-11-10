// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountWorkspaceContext, type AccountWorkspace } from "@/components/account-context";
import { DriveConnection } from "@/components/drive-connection";
import type { DriveStatus } from "@/lib/drive/store";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const assign = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browser-navigation", () => ({ navigate: assign }));

const workspace: AccountWorkspace = { user: { id: "own-account", username: "synthetic", role: "admin" }, loadServer: async () => {} };
let status: DriveStatus;
const requests: { method: string; url: string }[] = [];

beforeEach(() => {
  requests.length = 0;
  assign.mockReset();
  window.history.replaceState(null, "", "/einstellungen?bereich=verbindungen");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    requests.push({ method, url });
    if (url === "/api/drive/connect") return Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth?state=x" });
    if (method === "DELETE") status = { configured: true, connected: false, redirectUri: status.redirectUri };
    return Response.json(status);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const mount = () => render(<AccountWorkspaceContext value={workspace}><DriveConnection /></AccountWorkspaceContext>);

it("explains a missing server configuration with the redirect URI to register", async () => {
  status = { configured: false, connected: false };
  mount();
  const section = within(screen.getByRole("region", { name: "Google Drive" }));
  expect(await section.findByText("Nicht eingerichtet")).toBeTruthy();
  expect(section.queryByRole("button", { name: "Mit Google verbinden" })).toBeNull();
  expect(section.getByText(/GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET fehlen/)).toBeTruthy();
});

it("starts the Google consent from the server-provided URL", async () => {
  status = { configured: true, connected: false, redirectUri: "http://localhost:3000/api/auth/callback/google" };
  mount();
  const section = within(screen.getByRole("region", { name: "Google Drive" }));
  fireEvent.click(await section.findByRole("button", { name: "Mit Google verbinden" }));
  await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=x"));
  expect(requests.at(-1)).toEqual({ method: "POST", url: "/api/drive/connect" });
  expect(section.getByText("http://localhost:3000/api/auth/callback/google")).toBeTruthy();
});

it("shows the connected account, offers reconnecting after expiry and disconnects after confirmation", async () => {
  status = { configured: true, connected: true, email: "alice@example.test", connectedAt: Date.UTC(2026, 10, 3), expired: true };
  const view = mount();
  const section = within(screen.getByRole("region", { name: "Google Drive" }));
  expect(await section.findByText("alice@example.test")).toBeTruthy();
  expect(section.getByText("Freigabe abgelaufen")).toBeTruthy();
  expect(section.getByRole("button", { name: "Erneut verbinden" })).toBeTruthy();
  view.unmount();
  status = { ...status, expired: false };
  mount();
  const fresh = within(screen.getByRole("region", { name: "Google Drive" }));
  expect(await fresh.findByText("Aktiv")).toBeTruthy();
  fireEvent.click(fresh.getByRole("button", { name: "Trennen" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Google Drive trennen?" })).getByRole("button", { name: "Trennen" }));
  expect(await fresh.findByText("Nicht verbunden")).toBeTruthy();
  expect(requests.some((request) => request.method === "DELETE")).toBe(true);
  expect(toast.success).toHaveBeenCalledWith("Google Drive getrennt");
});

it("reports the result of the Google redirect once and removes it from the address", async () => {
  status = { configured: true, connected: false };
  window.history.replaceState(null, "", "/einstellungen?bereich=verbindungen&drive=anmeldung#google-drive");
  mount();
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("denselben Host"));
  expect(window.location.search).toBe("?bereich=verbindungen");
  expect(toast.error).toHaveBeenCalledOnce();
});
