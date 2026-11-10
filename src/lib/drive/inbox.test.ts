import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { addInboxItem, clearInbox, listInbox, readInboxFile, removeInboxItem } from "./inbox";

let directory: string;
let host: { path: string };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "finanzblick-drive-inbox-"));
  host = { path: join(directory, "accounts.sqlite") };
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("keeps inbox files per user and removes them once handled", async () => {
  await addInboxItem(host, "alice", { id: "slip-0001", name: "Oktober.pdf", size: 4 }, Buffer.from("%PDF"), 1);
  await addInboxItem(host, "alice", { id: "slip-0001", name: "Oktober neu.pdf", size: 5 }, Buffer.from("%PDF2"), 2);
  await addInboxItem(host, "bob", { id: "slip-0002", name: "Bob.pdf", size: 4 }, Buffer.from("%PDF"), 3);
  expect(await listInbox(host, "alice")).toEqual([{ id: "slip-0001", name: "Oktober neu.pdf", size: 5, addedAt: 2 }]);
  expect((await readInboxFile(host, "alice", "slip-0001"))?.bytes.toString()).toBe("%PDF2");
  expect(await readInboxFile(host, "alice", "slip-0002")).toBeNull();
  expect(await removeInboxItem(host, "alice", "slip-0001")).toBe(true);
  expect(await removeInboxItem(host, "alice", "slip-0001")).toBe(false);
  expect(await readdir(join(directory, "drive-inbox", "alice"))).toEqual(["index.json"]);
  await clearInbox(host, "bob");
  expect(await listInbox(host, "bob")).toEqual([]);
});

it("refuses ids and user names that could leave the inbox folder", async () => {
  await expect(addInboxItem(host, "alice", { id: "../evil", name: "x", size: 1 }, Buffer.from("x"))).rejects.toThrow();
  await expect(readInboxFile(host, "alice", "..\\..\\secret")).rejects.toThrow();
  await expect(listInbox(host, "../alice")).rejects.toThrow();
});
