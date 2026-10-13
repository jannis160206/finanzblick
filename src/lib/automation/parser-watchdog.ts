import { Worker } from "node:worker_threads";

export function startParserWatchdog(parentPid: number, deadline: number): Worker {
  // This thread can kill the entire parser even when its event loop is blocked.
  return new Worker(`
    const { workerData } = require("node:worker_threads");
    const kill = () => process.kill(process.pid, "SIGKILL");
    setTimeout(kill, Math.max(1, workerData.deadline - Date.now()));
    setInterval(() => {
      try { process.kill(workerData.parentPid, 0); }
      catch (error) { if (error.code === "ESRCH") kill(); }
    }, 250);
  `, {
    eval: true,
    workerData: { parentPid, deadline },
    resourceLimits: { maxOldGenerationSizeMb: 8, maxYoungGenerationSizeMb: 2, stackSizeMb: 1 },
  });
}
