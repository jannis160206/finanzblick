import { readFile } from "node:fs/promises";
import path from "node:path";
import { authorizeApi } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await authorizeApi(request);
  if (denied) return denied;
  const worker = await readFile(
    path.join(
      process.cwd(),
      "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
    ),
    "utf8",
  );
  return new Response(worker, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
