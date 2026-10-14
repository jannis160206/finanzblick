import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const RESTART_MS = 5_000;
const state = globalThis as typeof globalThis & { finanzblickDevWorker?: ChildProcess | null };

// Development convenience: the statement worker is a separate process in production (see docs/statement-worker.md).
export function startDevWorker(): void {
  if (state.finanzblickDevWorker !== undefined) return;
  const launch = () => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "scripts/statement-worker.ts"],
      { cwd: process.cwd(), env: process.env, stdio: "inherit" },
    );
    state.finanzblickDevWorker = child;
    child.once("error", (error) => console.error("Statement worker could not start:", error.name));
    child.once("exit", (code, signal) => {
      state.finanzblickDevWorker = null;
      if (signal === "SIGTERM" || signal === "SIGINT") return;
      console.warn(`Statement worker stopped (code ${code ?? "none"}); restarting in ${RESTART_MS / 1000}s.`);
      setTimeout(launch, RESTART_MS).unref();
    });
  };
  process.once("exit", () => state.finanzblickDevWorker?.kill());
  launch();
}
