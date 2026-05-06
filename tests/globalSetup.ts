import { execSync } from "child_process";
import path from "path";

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

    for (const pid of spawnedProcesses) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Process is already dead or doesn't exist
        }
      }
    }
  };
}
