import { execSync } from "child_process";
import path from "path";

export default async function globalSetup(): Promise<void> {
  // Runs once before any test workers start, so build steps don't race across workers.
  const rootDir = path.resolve(__dirname, "..");

  execSync("npm run build", { cwd: rootDir, stdio: "pipe" });

  // The TypeScript test fixture is gitignored; produce its dist before tests run.
  const testAppPath = path.resolve(__dirname, "fixtures/test-app");

  execSync("npm ci", { cwd: testAppPath, stdio: "pipe" });
  execSync("npm run build", { cwd: testAppPath, stdio: "pipe" });
}
