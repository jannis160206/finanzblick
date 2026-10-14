export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.NODE_ENV !== "development" ||
    process.env.FINANZBLICK_AUTO_WORKER === "0"
  )
    return;
  const { isAccountMode } = await import("@/lib/server/config");
  if (!isAccountMode()) return;
  const { startDevWorker } = await import("@/lib/automation/dev-worker");
  startDevWorker();
}
