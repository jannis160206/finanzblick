import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parsePayslipPdf, PayslipPasswordError } from "@/lib/import/payslip";
import { startParserWatchdog } from "@/lib/automation/parser-watchdog";
import { MAX_PAYSLIP_RESULT_BYTES, payslipChildRequestSchema, type PayslipChildRequest } from "./payslip-ipc";

// Reads one payslip PDF from the Drive inbox in a short-lived process, so a broken file cannot take the worker down.
const requireLocal = createRequire(import.meta.url);

async function read(request: PayslipChildRequest) {
  const metadata = await stat(request.path);
  if (!metadata.isFile() || metadata.size !== request.bytes) throw new Error("Datei wurde verändert oder ist beschädigt.");
  const bytes = await readFile(request.path);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(requireLocal.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  for (const password of [undefined, ...request.passwords]) {
    try {
      const result = await parsePayslipPdf(buffer, password);
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_PAYSLIP_RESULT_BYTES) throw new Error("Die Abrechnung ist zu umfangreich.");
      return { status: "ok" as const, result };
    } catch (error) {
      if (!(error instanceof PayslipPasswordError)) throw error;
    }
  }
  return { status: "locked" as const };
}

function reply(message: unknown) {
  if (!process.send) process.exit(1);
  process.send(message, (error) => process.exit(error ? 1 : 0));
}

process.once("disconnect", () => process.exit(1));
process.once("message", async (message: unknown) => {
  const request = payslipChildRequestSchema.safeParse(message);
  if (!request.success) process.exit(1);
  startParserWatchdog(process.ppid, request.data.deadline);
  try {
    reply({ type: "result", id: request.data.id, ...(await read(request.data)) });
  } catch (error) {
    const text = error instanceof Error && error.message ? error.message : "Die PDF konnte nicht gelesen werden.";
    reply({ type: "error", id: request.data.id, message: text.slice(0, 300) });
  }
});
