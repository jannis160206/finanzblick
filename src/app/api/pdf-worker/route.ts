import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

export async function GET() {
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
      "Cache-Control": "public, max-age=0, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
