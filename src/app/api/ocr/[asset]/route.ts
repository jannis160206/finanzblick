import { readFile } from "node:fs/promises";
import path from "node:path";
import { authorizeApi } from "@/lib/server/auth";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ asset: string }> }) {
  const denied = await authorizeApi(_request);
  if (denied) return denied;
  const { asset } = await params;
  let resource: string[];
  let contentType: string;
  if (asset === "worker.min.js") {
    resource = ["tesseract.js", "dist", asset];
    contentType = "text/javascript; charset=utf-8";
  } else if (/^tesseract-core(?:-(?:simd|relaxedsimd))?-lstm\.wasm(?:\.js)?$/.test(asset)) {
    resource = ["tesseract.js-core", asset];
    contentType = asset.endsWith(".js") ? "text/javascript; charset=utf-8" : "application/wasm";
  } else if (/^(?:deu|eng)\.traineddata\.gz$/.test(asset)) {
    resource = ["@tesseract.js-data", asset.slice(0, 3), "4.0.0_best_int", asset];
    contentType = "application/gzip";
  } else return new Response("Not found", { status: 404 });
  const data = await readFile(path.join(process.cwd(), "node_modules", ...resource));
  return new Response(new Uint8Array(data), { headers: {
    "Content-Type": contentType,
    "Cache-Control": "private, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  } });
}
