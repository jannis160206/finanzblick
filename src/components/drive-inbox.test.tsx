// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { AccountWorkspaceContext, type AccountWorkspace } from "@/components/account-context";
import { DriveInbox, requestDriveInbox } from "@/components/drive-inbox";
import { PayslipUploadProvider } from "@/components/payslip-upload";
import { createSeed } from "@/lib/seed";
import type { Payslip } from "@/lib/payslip-schema";
import type { AppState } from "@/lib/types";

const fixture = vi.hoisted(() => {
  class PasswordError extends Error {}
  return { parse: vi.fn(), PasswordError, state: undefined as unknown as AppState, ready: true };
});
vi.mock("@/lib/import/payslip", () => ({ parsePayslipPdf: fixture.parse, PayslipPasswordError: fixture.PasswordError }));
vi.mock("@/components/finance-provider", () => ({
  useFinance: () => ({ state: fixture.state, ready: fixture.ready, update: (updater: (state: AppState) => AppState) => { fixture.state = updater(fixture.state); }, storageError: null }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/browser-navigation", () => ({ navigate }));

const october: Payslip = { year: 2026, month: 10, employer: "Musterbetrieb GmbH", regularGross: 3000, specialGross: 0, monthlyPayroll: true };
const workspace: AccountWorkspace = { user: { id: "own-account", username: "synthetic", role: "admin" }, loadServer: async () => {} };
let inbox: { id: string; name: string; size: number; addedAt: number }[];
let expired: boolean;
let missing: Set<string>;
const reports: { id: string; body: unknown }[] = [];
const names: string[] = [];

beforeAll(() => {
  if (!("arrayBuffer" in Blob.prototype)) Object.defineProperty(Blob.prototype, "arrayBuffer", {
    configurable: true,
    value(this: Blob) {
      return new Promise<ArrayBuffer>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(this);
      });
    },
  });
});

beforeEach(() => {
  fixture.state = createSeed();
  fixture.ready = true;
  fixture.parse.mockReset();
  inbox = [];
  expired = false;
  sessionStorage.clear();
  missing = new Set();
  reports.length = 0;
  names.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    expect(new Headers(init.headers).get("X-Finanzblick-Account")).toBe("own-account");
    if (url === "/api/drive/inbox") return Response.json({ items: inbox, ...(expired ? { expired: true } : {}) });
    const id = decodeURIComponent(url.split("/").at(-1) ?? "");
    if (init.method === "POST") {
      reports.push({ id, body: JSON.parse(String(init.body)) });
      inbox = inbox.filter((item) => item.id !== id);
      return Response.json({ ok: true });
    }
    if (url.startsWith("/api/drive/inbox/")) return missing.has(id) ? Response.json({ error: "Datei nicht mehr vorhanden." }, { status: 404 }) : new Response("%PDF-synthetic");
    return Response.json({ stored: false });
  }));
  fixture.parse.mockImplementation(async () => ({ drafts: [], issues: [] }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function renderInbox(account: AccountWorkspace | null = workspace) {
  return render(
    <AccountWorkspaceContext value={account}>
      <PayslipUploadProvider><DriveInbox /></PayslipUploadProvider>
    </AccountWorkspaceContext>,
  );
}

const item = (id: string, name: string) => ({ id, name, size: 14, addedAt: 1 });

it("reads waiting Drive payslips with the regular import and reports each result", async () => {
  inbox = [item("slip-0001", "Lohnzettel Oktober.pdf"), item("note-0001", "Steuerbescheid")];
  fixture.parse.mockImplementation(async () => {
    names.push("parse");
    return names.length === 1 ? { drafts: [october], issues: [] } : { drafts: [], issues: ["Kein Lohnzettel"] };
  });
  renderInbox();
  await waitFor(() => expect(reports).toHaveLength(2));
  expect(reports).toEqual([
    { id: "slip-0001", body: { outcome: "imported" } },
    { id: "note-0001", body: { outcome: "skipped", note: "Keine Lohnabrechnung erkannt." } },
  ]);
  expect(fixture.state.payslips).toEqual([october]);
});

it("drops vanished files and reads again on request", async () => {
  inbox = [item("gone-0001", "Weg.pdf")];
  missing.add("gone-0001");
  renderInbox();
  await waitFor(() => expect(reports).toEqual([{ id: "gone-0001", body: { outcome: "failed", note: "Datei nicht mehr vorhanden." } }]));
  expect(fixture.parse).not.toHaveBeenCalled();

  inbox = [item("slip-0002", "November.pdf")];
  fixture.parse.mockResolvedValue({ drafts: [{ ...october, month: 11 }], issues: [] });
  act(() => requestDriveInbox());
  await waitFor(() => expect(reports.at(-1)).toEqual({ id: "slip-0002", body: { outcome: "imported" } }));
});

it("stays idle without an account or before the finances have loaded", async () => {
  inbox = [item("slip-0001", "Oktober.pdf")];
  const local = renderInbox(null);
  fixture.ready = false;
  local.unmount();
  renderInbox();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetch).not.toHaveBeenCalledWith("/api/drive/inbox", expect.anything());
});

it("tells once per session that the Google approval has ended and links to reconnecting", async () => {
  expired = true;
  const first = renderInbox();
  await waitFor(() => expect(toast.warning).toHaveBeenCalledOnce());
  const [title, options] = toast.warning.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }];
  expect(title).toBe("Google-Drive-Freigabe abgelaufen");
  options.action.onClick();
  expect(navigate).toHaveBeenCalledWith("/einstellungen?bereich=verbindungen#google-drive");
  first.unmount();
  renderInbox();
  await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/drive/inbox")).toHaveLength(2));
  expect(toast.warning).toHaveBeenCalledOnce();
});
