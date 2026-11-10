import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountDatabase } from "@/lib/server/database";
import { AccountError } from "@/lib/server/errors";
import { resetSecretKeyCache } from "@/lib/server/secrets";
import { listInbox, readInboxFile } from "./inbox";
import { driveStatus, readDriveLink, saveDriveConnection } from "./store";
import { chooseDriveFolder, driveOverview, driveSyncDue, recordInboxOutcome, retryDriveFiles, syncDrive } from "./sync";

const config = { clientId: "id", clientSecret: "secret", redirectUri: "http://localhost:3000/api/auth/callback/google" };
let directory: string;
let database: AccountDatabase;
beforeEach(async () => {
  resetSecretKeyCache();
  directory = await mkdtemp(join(tmpdir(), "finanzblick-drive-sync-"));
  database = { path: join(directory, "accounts.sqlite") } as unknown as AccountDatabase;
  await saveDriveConnection(database, "alice", { accessToken: "synthetic-access", accessExpiresAt: Date.now() + 3_600_000, refreshToken: "synthetic-refresh" }, {});
});
afterEach(async () => {
  resetSecretKeyCache();
  await rm(directory, { recursive: true, force: true });
});

type FakeFile = { id: string; name: string; md5Checksum?: string; size?: string; body?: string; status?: number };
type FakeFolder = { id: string; name: string; modifiedTime?: string; files: FakeFile[] };

/** A tiny in-memory Drive API that answers folder searches, folder listings and downloads. */
function fakeDrive(folders: FakeFolder[], options: { pageSize?: number; unauthorized?: number } = {}) {
  let unauthorized = options.unauthorized ?? 0;
  const downloads: string[] = [];
  const listings: string[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "fresh-access", expires_in: 3600 });
    if (unauthorized > 0) { unauthorized--; return new Response(null, { status: 401 }); }
    const media = /\/files\/([^/?]+)$/.exec(url.pathname);
    if (media && url.searchParams.get("alt") === "media") {
      const file = folders.flatMap((folder) => folder.files).find((entry) => entry.id === decodeURIComponent(media[1]));
      downloads.push(file?.id ?? "?");
      if (!file || file.status) return new Response(null, { status: file?.status ?? 404 });
      return new Response(file.body ?? `%PDF-1.4 ${file.name}`);
    }
    const query = url.searchParams.get("q") ?? "";
    const named = /name = '((?:[^'\\]|\\.)*)'/.exec(query);
    if (named) {
      const name = named[1].replace(/\\(.)/g, "$1");
      return Response.json({ files: folders.filter((folder) => folder.name === name).map(({ id, name: folderName, modifiedTime }) => ({ id, name: folderName, mimeType: "application/vnd.google-apps.folder", modifiedTime })) });
    }
    const parent = /^'([^']+)' in parents/.exec(query);
    const folder = folders.find((entry) => entry.id === parent?.[1]);
    listings.push(parent?.[1] ?? "?");
    const all = (folder?.files ?? []).map(({ id, name, md5Checksum, size }) => ({ id, name, mimeType: "application/pdf", md5Checksum, ...(size ? { size } : {}) }));
    const pageSize = options.pageSize ?? 200;
    const start = Number(url.searchParams.get("pageToken") ?? "0");
    const page = all.slice(start, start + pageSize);
    return Response.json({ files: page, ...(start + pageSize < all.length ? { nextPageToken: String(start + pageSize) } : {}) });
  });
  return { fetcher: fetcher as unknown as typeof fetch, downloads, listings, calls: fetcher };
}

const amexFolder = (files: FakeFile[]): FakeFolder => ({ id: "folder-amex", name: "AMEX Abrechnungen", files });
const payslipFolder = (files: FakeFile[], id = "folder-payslips", modifiedTime?: string): FakeFolder => ({ id, name: "Abrechnungen", files, ...(modifiedTime ? { modifiedTime } : {}) });

it("queues AMEX statements, keeps payslips for the browser and does not fetch handled files again", async () => {
  const drive = fakeDrive([
    amexFolder([{ id: "amex-pdf-1", name: "Oktober.pdf", md5Checksum: "a1" }, { id: "amex-csv-1", name: "amex-november.csv", md5Checksum: "a2" }, { id: "amex-doc-1", name: "Notiz.docx" }]),
    payslipFolder([{ id: "slip-0001", name: "Lohnzettel 10-2026.pdf", md5Checksum: "p1" }]),
  ]);
  const enqueue = vi.fn(async () => "job");
  const result = await syncDrive(database, "alice", config, { fetcher: drive.fetcher, enqueue, now: 1_000 });
  expect(result.folders.amex).toMatchObject({ found: true, total: 2, added: 2, failed: 0 });
  expect(result.folders.payslips).toMatchObject({ found: true, total: 1, added: 1 });
  expect(enqueue.mock.calls.map((call) => (call as unknown[])[2])).toEqual(["AMEX Oktober.pdf", "amex-november.csv"]);
  expect(await listInbox(database, "alice")).toEqual([expect.objectContaining({ id: "slip-0001", name: "Lohnzettel 10-2026.pdf", addedAt: 1_000 })]);
  expect((await readInboxFile(database, "alice", "slip-0001"))?.bytes.toString()).toContain("%PDF-1.4");

  await syncDrive(database, "alice", config, { fetcher: drive.fetcher, enqueue, now: 2_000 });
  expect(enqueue).toHaveBeenCalledTimes(2);
  expect(drive.downloads).toEqual(["amex-pdf-1", "amex-csv-1", "slip-0001"]);
  const status = await driveOverview(database, "alice", config);
  expect(status).toMatchObject({ lastSync: 2_000, inbox: 1, retryable: 0, folders: { amex: { name: "AMEX Abrechnungen", lastCount: 2 } } });
  expect(status.recent?.map((entry) => entry.outcome)).toEqual(["inbox", "queued", "queued"]);
});

it("reads a changed file again and lets the regular duplicate checks decide", async () => {
  const files = [{ id: "amex-pdf-1", name: "Oktober.pdf", md5Checksum: "a1" }];
  const enqueue = vi.fn(async () => "job");
  await syncDrive(database, "alice", config, { fetcher: fakeDrive([amexFolder(files)]).fetcher, enqueue });
  files[0].md5Checksum = "a1-changed";
  await syncDrive(database, "alice", config, { fetcher: fakeDrive([amexFolder(files)]).fetcher, enqueue });
  expect(enqueue).toHaveBeenCalledTimes(2);
});

it("follows pagination and records browser outcomes, which a retry clears", async () => {
  const many = Array.from({ length: 5 }, (_, index) => ({ id: `slip-000${index}`, name: `Lohnzettel ${index}.pdf`, md5Checksum: `p${index}` }));
  const drive = fakeDrive([payslipFolder(many)], { pageSize: 2 });
  const result = await syncDrive(database, "alice", config, { fetcher: drive.fetcher });
  expect(result.folders.payslips.added).toBe(5);
  expect(drive.listings.filter((id) => id === "folder-payslips")).toHaveLength(3);
  await recordInboxOutcome(database, "alice", "slip-0001", "skipped", "Passwort fehlt.");
  await recordInboxOutcome(database, "alice", "slip-0002", "imported");
  expect((await driveStatus(database, "alice", config)).retryable).toBe(1);
  await syncDrive(database, "alice", config, { fetcher: drive.fetcher });
  expect(drive.downloads).toHaveLength(5);
  await retryDriveFiles(database, "alice");
  await syncDrive(database, "alice", config, { fetcher: drive.fetcher });
  expect(drive.downloads.slice(5)).toEqual(["slip-0001"]);
});

it("keeps a backlog instead of failing when the statement queue is full", async () => {
  const drive = fakeDrive([amexFolder([{ id: "amex-pdf-1", name: "Oktober.pdf", md5Checksum: "a1" }, { id: "amex-pdf-2", name: "November.pdf", md5Checksum: "a2" }])]);
  const full = vi.fn(async () => { throw new AccountError(429, "Zu viele laufende Importe."); });
  const result = await syncDrive(database, "alice", config, { fetcher: drive.fetcher, enqueue: full, now: 5_000 });
  expect(result).toMatchObject({ backlog: true, folders: { amex: { added: 0, failed: 0 } } });
  expect(full).toHaveBeenCalledOnce();
  const link = await readDriveLink(database, "alice");
  expect(link?.backlog).toBe(true);
  expect(driveSyncDue(link, 6_000)).toBe(true);
  const enqueue = vi.fn(async () => "job");
  await syncDrive(database, "alice", config, { fetcher: drive.fetcher, enqueue, now: 7_000 });
  expect(enqueue).toHaveBeenCalledTimes(2);
  const done = await readDriveLink(database, "alice");
  expect(done?.backlog).toBe(false);
  expect(driveSyncDue(done, 8_000)).toBe(false);
  expect(driveSyncDue(done, 7_000 + 60 * 60 * 1000)).toBe(true);
});

it("tries failed downloads three times and skips oversized files at once", async () => {
  const drive = fakeDrive([payslipFolder([
    { id: "slip-broken", name: "Defekt.pdf", md5Checksum: "b1", status: 500 },
    { id: "slip-huge01", name: "Riesig.pdf", md5Checksum: "h1", size: String(25 * 1024 * 1024) },
  ])]);
  for (let run = 0; run < 4; run++) await syncDrive(database, "alice", config, { fetcher: drive.fetcher });
  expect(drive.downloads).toEqual(["slip-broken", "slip-broken", "slip-broken"]);
  const status = await driveStatus(database, "alice", config);
  expect(status.retryable).toBe(2);
  expect(status.recent?.find((entry) => entry.name === "Riesig.pdf")).toMatchObject({ outcome: "failed", note: "Größer als 20 MB." });
});

it("reports missing folders and lets the user pick one of several same-named folders", async () => {
  const drive = fakeDrive([
    payslipFolder([{ id: "slip-new01", name: "Neu.pdf" }], "folder-newer", "2026-11-01T10:00:00Z"),
    payslipFolder([{ id: "slip-old01", name: "Alt.pdf" }], "folder-older", "2026-01-01T10:00:00Z"),
  ]);
  const first = await syncDrive(database, "alice", config, { fetcher: drive.fetcher });
  expect(first.folders.amex.found).toBe(false);
  expect(first.notes).toEqual(["Ordner „AMEX Abrechnungen“ nicht gefunden.", expect.stringContaining("Mehrere Ordner „Abrechnungen“")]);
  const status = await driveStatus(database, "alice", config);
  expect(status.notes).toHaveLength(2);
  expect(status.folders?.payslips).toMatchObject({ id: "folder-newer", choices: [{ id: "folder-newer" }, { id: "folder-older" }] });
  await expect(chooseDriveFolder(database, "alice", "payslips", "folder-unknown")).rejects.toMatchObject({ status: 400 });
  await chooseDriveFolder(database, "alice", "payslips", "folder-older");
  const second = await syncDrive(database, "alice", config, { fetcher: drive.fetcher });
  expect(second.notes).toEqual(["Ordner „AMEX Abrechnungen“ nicht gefunden."]);
  expect(drive.listings.at(-1)).toBe("folder-older");
  expect(drive.downloads).toEqual(["slip-new01", "slip-old01"]);
});

it("refreshes a rejected access token once and marks the connection expired when Google keeps refusing", async () => {
  const recovering = fakeDrive([payslipFolder([])], { unauthorized: 1 });
  await syncDrive(database, "alice", config, { fetcher: recovering.fetcher });
  expect(recovering.calls.mock.calls.some((call) => String(call[0]).includes("oauth2.googleapis.com"))).toBe(true);
  expect((await readDriveLink(database, "alice"))?.expired).toBeUndefined();

  const refusing = fakeDrive([payslipFolder([])], { unauthorized: 10 });
  await saveDriveConnection(database, "alice", { accessToken: "synthetic-access", accessExpiresAt: Date.now() + 3_600_000, refreshToken: "synthetic-refresh" }, {});
  await expect(syncDrive(database, "alice", config, { fetcher: refusing.fetcher })).rejects.toMatchObject({ kind: "expired" });
  expect(await readDriveLink(database, "alice")).toMatchObject({ expired: true });
  expect(driveSyncDue(await readDriveLink(database, "alice"))).toBe(false);
});

it("refuses to run without a connection", async () => {
  await expect(syncDrive(database, "bob", config, { fetcher: fakeDrive([]).fetcher })).rejects.toMatchObject({ kind: "expired" });
});
