import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PayslipImport } from "@/lib/payslip-schema";
import { MAX_PAYSLIP_RESULT_BYTES, payslipChildReplySchema, payslipChildRequestSchema, type PayslipChildReply } from "./payslip-ipc";

export const PAYSLIP_READ_BUDGET_MS = 60_000;
const requireLocal = createRequire(import.meta.url);
const childEntrypoint = fileURLToPath(new URL("./payslip-child.ts", import.meta.url));

export class PayslipReadError extends Error {}

export type PayslipRead = { status: "ok"; result: PayslipImport } | { status: "locked" };
export type PayslipReader = (path: string, bytes: number, passwords: string[], options?: { signal?: AbortSignal }) => Promise<PayslipRead>;

/** Parses a payslip PDF in an isolated child process (no env secrets, 384 MB heap, hard deadline). */
export async function readPayslipInChild(
  path: string,
  bytes: number,
  passwords: string[],
  options: { signal?: AbortSignal; budgetMs?: number; entrypoint?: string } = {},
): Promise<PayslipRead> {
  if (options.signal?.aborted) throw new PayslipReadError("Abgebrochen.");
  const deadline = Date.now() + (options.budgetMs ?? PAYSLIP_READ_BUDGET_MS);
  const request = payslipChildRequestSchema.parse({ type: "payslip", id: randomUUID(), path, bytes, passwords, deadline });
  return new Promise<PayslipRead>((resolve, reject) => {
    let reply: PayslipChildReply | undefined;
    let failure: string | undefined;
    const child = fork(options.entrypoint ?? childEntrypoint, [], {
      execPath: process.execPath,
      execArgv: ["--max-old-space-size=384", "--import", pathToFileURL(requireLocal.resolve("tsx")).href],
      env: { NODE_ENV: "production", PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TSX_DISABLE_CACHE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    const stop = (message: string) => {
      failure ??= message;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const abort = () => stop("Abgebrochen.");
    const timer = setTimeout(() => stop("Das Lesen der PDF hat zu lange gedauert."), Math.max(1, deadline - Date.now()));
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () => stop("Die PDF konnte nicht gelesen werden."));
    child.on("message", (message: unknown) => {
      if (failure) return;
      const parsed = !reply && Buffer.byteLength(JSON.stringify(message)) <= MAX_PAYSLIP_RESULT_BYTES + 1024
        ? payslipChildReplySchema.safeParse(message) : undefined;
      if (!parsed?.success || parsed.data.id !== request.id) stop("Die PDF konnte nicht gelesen werden.");
      else reply = parsed.data;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure) reject(new PayslipReadError(failure));
      else if (!reply || code !== 0) reject(new PayslipReadError("Die PDF konnte nicht gelesen werden."));
      else if (reply.type === "error") reject(new PayslipReadError(reply.message));
      else if (reply.status === "locked") resolve({ status: "locked" });
      else resolve({ status: "ok", result: reply.result as PayslipImport });
    });
    try {
      child.send(request, (error) => { if (error) stop("Die PDF konnte nicht gelesen werden."); });
    } catch {
      stop("Die PDF konnte nicht gelesen werden.");
    }
  });
}
