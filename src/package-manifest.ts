import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageManifest {
  name: string;
  version: string;
}

// Resolve package.json relative to the dist file location so the same lookup
// works whether index.ts is built into dist/ or invoked through ts-node from
// src/. The two candidates cover "dist/<file>.js" → "dist/../package.json"
// and the deeper layout used during development.
function loadPackageManifest(): PackageManifest {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')];

  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf-8')) as PackageManifest;
    } catch {
      // try next candidate
    }
  }

  return { name: '@vitalyostanin/mcp-chrome-debugger-protocol', version: '0.0.0' };
}

export const packageManifest: PackageManifest = loadPackageManifest();
