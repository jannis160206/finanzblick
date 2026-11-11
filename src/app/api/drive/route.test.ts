import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSecretKeyCache } from "@/lib/server/secrets";
import { addInboxItem, listInbox, removeInboxItem } from "@/lib/drive/inbox";
import { markDriveLink, readDriveLink, recordInboxOutcome, saveDriveConnection } from "@/lib/drive/store";
import { syncDrive } from "@/lib/drive/sync";
import type { AccountDatabase } from "@/lib/server/database";

const mocks = vi.hoisted(() => ({ accountMode: vi.fn(), runtime: vi.fn(), currentUser: vi.fn(), rateLimit: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/server/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/server/config")>()),
  isAccountMode: mocks.accountMode,
}));
vi.mock("@/lib/server/runtime", () => ({ getAccountRuntime: mocks.runtime }));
import { DELETE, GET, POST } from "./route";
import { GET as listRoute } from "./inbox/route";
import { GET as fileRoute, POST as outcomeRoute } from "./inbox/[id]/route";

const origin = "http://localhost:3000";
let directory: string;
let host: { path: string };
const headers = (extra: Record<string, string> = {}) => ({ Cookie: "finanzblick_session=session-token", "X-Finanzblick-Account": "alice", ...extra });
const post = (body: unknown, extra: Record<string, string> = { Origin: origin }) =>
  POST(new Request(`${origin}/api/drive`, { method: "POST", headers: headers({ "Content-Type": "application/json", ...extra }), body: JSON.stringify(body) }));
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  vi.resetAllMocks();
  resetSecretKeyCache();
  directory = await mkdtemp(join(tmpdir(), "finanzblick-drive-route-"));
  host = { path: join(directory, "accounts.sqlite") };
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.accountMode.mockReturnValue(true);
  mocks.currentUser.mockImplementation((token: string | null) => token === "session-token" ? { id: "alice" } : null);
  mocks.runtime.mockResolvedValue({ config: { origin, secureCookies: false }, database: { ...host, currentUser: mocks.currentUser, consumeRateLimit: mocks.rateLimit } });
  mocks.fetch.mockImplementation(async (url: string | URL) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/files") && target.searchParams.get("q")?.includes("name = 'Abrechnungen'"))
      return Response.json({ files: [{ id: "folder-payslips", name: "Abrechnungen", mimeType: "application/vnd.google-apps.folder" }] });
    if (target.pathname.endsWith("/files") && target.searchParams.get("q")?.startsWith("'folder-payslips' in parents"))
      return Response.json({ files: [{ id: "slip-0001", name: "Lohnzettel.pdf", mimeType: "application/pdf", md5Checksum: "p1" }] });
    if (target.pathname.endsWith("/files/slip-0001")) return new Response("%PDF-1.4 synthetic");
    if (target.pathname.endsWith("/files")) return Response.json({ files: [] });
    return new Response(null, { status: 200 });
  });
  await saveDriveConnection(host, "alice", { accessToken: "synthetic-access", accessExpiresAt: Date.now() + 3_600_000, refreshToken: "synthetic-refresh" }, { email: "alice@example.test" });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetSecretKeyCache();
  await rm(directory, { recursive: true, force: true });
});

describe("/api/drive", () => {
  it("checks the folders on request and returns the result with the new status", async () => {
    const response = await post({ action: "sync" });
    expect(response.status).toBe(200);
    const body = await response.json() as { result: { folders: { payslips: { added: number } }; notes: string[] }; status: { inbox: number; lastSync: number } };
    expect(body.result.folders.payslips.added).toBe(1);
    expect(body.result.notes).toEqual(["Ordner „AMEX Abrechnungen“ nicht gefunden."]);
    expect(body.status).toMatchObject({ connected: true, inbox: 1, notes: ["Ordner „AMEX Abrechnungen“ nicht gefunden."] });
    expect(mocks.rateLimit).toHaveBeenCalledWith("drive:alice", 10, 60_000);
    const status = await (await GET(new Request(`${origin}/api/drive`, { headers: headers() }))).json() as { email: string; inbox: number };
    expect(status).toMatchObject({ email: "alice@example.test", inbox: 1 });
    expect(JSON.stringify(status)).not.toContain("synthetic-");
  });

  it("rejects foreign origins, unknown actions and folders that are not offered", async () => {
    expect((await post({ action: "sync" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post({ action: "delete-everything" })).status).toBe(400);
    expect((await post({ action: "folder", kind: "payslips", id: "folder-unknown" })).status).toBe(400);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("asks to reconnect when the connection is gone and reports Drive outages", async () => {
    mocks.fetch.mockResolvedValue(new Response(null, { status: 503 }));
    const outage = await post({ action: "sync" });
    expect(outage.status).toBe(502);
    expect((await outage.json() as { error: string }).error).toContain("Google Drive");
    expect((await readDriveLink(host, "alice"))?.lastError).toBe("Google Drive hat einen Fehler gemeldet.");
    await DELETE(new Request(`${origin}/api/drive`, { method: "DELETE", headers: headers({ Origin: origin }) }));
    const gone = await post({ action: "sync" });
    expect(gone.status).toBe(409);
    expect((await post({ action: "recheck" })).status).toBe(409);
  });

  it("fetches imported payslips again on recheck", async () => {
    await post({ action: "sync" });
    await recordInboxOutcome(host, "alice", "slip-0001", "imported");
    await removeInboxItem(host, "alice", "slip-0001");
    expect(await (await post({ action: "sync" })).json()).toMatchObject({ result: { folders: { payslips: { added: 0 } } } });
    expect(await (await post({ action: "recheck" })).json()).toMatchObject({ result: { folders: { payslips: { added: 1 } } }, status: { inbox: 1 } });
  });

  it("forgets the connection and waiting payslips when disconnecting", async () => {
    await addInboxItem(host, "alice", { id: "slip-0001", name: "Lohnzettel.pdf", size: 10 }, Buffer.from("%PDF"));
    const response = await DELETE(new Request(`${origin}/api/drive`, { method: "DELETE", headers: headers({ Origin: origin }) }));
    expect(await response.json()).toMatchObject({ connected: false });
    expect(await listInbox(host, "alice")).toEqual([]);
    expect(mocks.fetch).toHaveBeenCalledWith("https://oauth2.googleapis.com/revoke", expect.anything());
  });

  it("requires the signed-in account", async () => {
    const response = await GET(new Request(`${origin}/api/drive`, { headers: headers({ "X-Finanzblick-Account": "bob" }) }));
    expect(response.status).toBe(401);
  });
});

describe("/api/drive/inbox", () => {
  it("hands waiting payslips to the browser and records what became of them", async () => {
    await syncDrive(host as unknown as AccountDatabase, "alice", { clientId: "c", clientSecret: "s", redirectUri: `${origin}/api/auth/callback/google` });
    const list = await (await listRoute(new Request(`${origin}/api/drive/inbox`, { headers: headers() }))).json() as { items: { id: string; name: string }[] };
    expect(list.items).toEqual([expect.objectContaining({ id: "slip-0001", name: "Lohnzettel.pdf" })]);

    const file = await fileRoute(new Request(`${origin}/api/drive/inbox/slip-0001`, { headers: headers() }), params("slip-0001"));
    expect(file.headers.get("Content-Type")).toBe("application/pdf");
    expect(file.headers.get("Cache-Control")).toBe("no-store");
    expect(await file.text()).toBe("%PDF-1.4 synthetic");

    const outcome = await outcomeRoute(new Request(`${origin}/api/drive/inbox/slip-0001`, {
      method: "POST", headers: headers({ Origin: origin, "Content-Type": "application/json" }), body: JSON.stringify({ outcome: "skipped", note: "Passwort fehlt." }),
    }), params("slip-0001"));
    expect(outcome.status).toBe(200);
    expect(await listInbox(host, "alice")).toEqual([]);
    expect((await readDriveLink(host, "alice"))?.processed?.[0]).toMatchObject({ id: "slip-0001", outcome: "skipped", note: "Passwort fehlt." });
    expect((await fileRoute(new Request(`${origin}/api/drive/inbox/slip-0001`, { headers: headers() }), params("slip-0001"))).status).toBe(404);
  });

  it("reports an ended Google approval with the list and limits file requests", async () => {
    await syncDrive(host as unknown as AccountDatabase, "alice", { clientId: "c", clientSecret: "s", redirectUri: `${origin}/api/auth/callback/google` });
    await markDriveLink(host, "alice", (link) => ({ ...link, expired: true }));
    const list = await (await listRoute(new Request(`${origin}/api/drive/inbox`, { headers: headers() }))).json() as { items: unknown[]; expired?: boolean };
    expect(list).toMatchObject({ expired: true, items: [expect.objectContaining({ id: "slip-0001" })] });
    await fileRoute(new Request(`${origin}/api/drive/inbox/slip-0001`, { headers: headers() }), params("slip-0001"));
    expect(mocks.rateLimit).toHaveBeenCalledWith("drive-inbox:alice", 600, 60_000);
  });

  it("rejects path tricks, foreign origins and other accounts", async () => {
    expect((await fileRoute(new Request(`${origin}/api/drive/inbox/x`, { headers: headers() }), params("../../secret"))).status).toBe(400);
    const foreign = await outcomeRoute(new Request(`${origin}/api/drive/inbox/slip-0001`, {
      method: "POST", headers: headers({ Origin: "https://evil.example", "Content-Type": "application/json" }), body: JSON.stringify({ outcome: "imported" }),
    }), params("slip-0001"));
    expect(foreign.status).toBe(403);
    expect((await listRoute(new Request(`${origin}/api/drive/inbox`, { headers: headers({ "X-Finanzblick-Account": "bob" }) }))).status).toBe(401);
  });
});
