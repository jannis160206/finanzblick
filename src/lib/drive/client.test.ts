import { expect, it, vi } from "vitest";
import { downloadFile, findFolders } from "./client";

const stream = (chunks: number[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    for (const size of chunks) controller.enqueue(new Uint8Array(size));
    controller.close();
  },
});

it("searches folders by exact, escaped name outside the trash", async () => {
  const fetcher = vi.fn(async () => Response.json({ files: [{ id: "f1", name: "Chef's \\ Ordner" }] }));
  expect(await findFolders("token", "Chef's \\ Ordner", fetcher as unknown as typeof fetch)).toHaveLength(1);
  const url = new URL(String((fetcher.mock.calls[0] as unknown as [URL])[0]));
  expect(url.searchParams.get("q")).toBe("mimeType = 'application/vnd.google-apps.folder' and name = 'Chef\\'s \\\\ Ordner' and trashed = false");
  expect(url.searchParams.get("orderBy")).toBe("modifiedTime desc");
});

it("stops downloads that exceed the size limit, declared or streamed", async () => {
  const declared = vi.fn(async () => new Response(stream([10]), { headers: { "Content-Length": "999999" } }));
  await expect(downloadFile("token", "file-1", 100, declared as unknown as typeof fetch)).rejects.toMatchObject({ status: 413 });
  const streamed = vi.fn(async () => new Response(stream([60, 60])));
  await expect(downloadFile("token", "file-1", 100, streamed as unknown as typeof fetch)).rejects.toMatchObject({ status: 413 });
  const fine = vi.fn(async () => new Response(stream([40, 40])));
  expect((await downloadFile("token", "file-1", 100, fine as unknown as typeof fetch)).byteLength).toBe(80);
  const expired = vi.fn(async () => new Response(null, { status: 401 }));
  await expect(downloadFile("token", "file-1", 100, expired as unknown as typeof fetch)).rejects.toMatchObject({ kind: "expired" });
});
