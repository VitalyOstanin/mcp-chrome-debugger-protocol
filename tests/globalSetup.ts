import { execSync } from "child_process";
import path from "path";
import { setTimeout as sleep } from "node:timers/promises";

export default async function globalSetup(): Promise<() => Promise<void>> {
  // Runs once before any test workers start, so build steps don't race across workers.
  const rootDir = path.resolve(__dirname, "..");

  execSync("npm run build", { cwd: rootDir, stdio: "pipe" });

  // The TypeScript test fixture is gitignored; produce its dist before tests run.
  const testAppPath = path.resolve(__dirname, "fixtures/test-app");

  execSync("npm ci", { cwd: testAppPath, stdio: "pipe" });
  execSync("npm run build", { cwd: testAppPath, stdio: "pipe" });

  return async function teardown(): Promise<void> {
    // Kill any tracked debuggee processes left over from incomplete suites.
    let spawnedProcesses = new Set<number>();

    try {
      const globals = await import("./globals.js");

      spawnedProcesses = globals.spawnedProcesses;
    } catch (error) {
      console.warn("Error importing globals module during teardown:", error);
    }

    // Send SIGTERM, give the process a short window to exit cleanly, then
    // escalate to SIGKILL only if it is still alive. The previous logic
    // inverted the SIGTERM/SIGKILL pair: SIGKILL was sent only when SIGTERM
    // threw (which already means the process is gone), so a stuck debuggee
    // never received SIGKILL.
    const TERMINATION_GRACE_MS = 300;

    for (const pid of spawnedProcesses) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already dead -- nothing to do.
        continue;
      }

      await sleep(TERMINATION_GRACE_MS);

      try {
        // Signal 0 is a liveness probe -- it does not deliver a signal, just
        // checks whether the kernel still tracks the pid for our uid.
        process.kill(pid, 0);
        process.kill(pid, "SIGKILL");
      } catch {
        // Process exited within the grace window.
      }
    }
  };
}
