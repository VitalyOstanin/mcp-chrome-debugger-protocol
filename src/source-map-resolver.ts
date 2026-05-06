import { TraceMap, originalPositionFor, generatedPositionFor, LEAST_UPPER_BOUND } from "@jridgewell/trace-mapping";
import { existsSync } from "node:fs";
import { readFile, stat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { findProjectRoot } from "./utils.js";
import { BUILD_DIRS, SOURCE_DIR_MARKER } from "./constants.js";

export interface SourceMapResolution {
  targetFilePath: string;
  targetLineNumber: number;
  targetColumnNumber: number;
  sourceMapInfo: {
    success: boolean;
    sourceMapUsed?: string | undefined;
    matchedSource?: string | undefined;
  };
}

interface CachedTraceMap {
  mtimeMs: number;
  size: number;
  traceMap: TraceMap;
  // basename -> source entries. Used to short-circuit linear scans of map.sources.
  sourcesByBasename: Map<string, string[]>;
}

const TRACE_MAP_CACHE_LIMIT = 32;
// findSourceMapsInDirs walks dist/build/out/lib recursively for *.js.map. The
// previous implementation re-walked on every breakpoint, which is O(files) per
// breakpoint on large bundles. Cache the listing per-roots-key for a short TTL
// so an interactive session reuses it; new builds are picked up on the next
// expiry.
const SOURCE_MAP_LISTING_TTL_MS = 30_000;

interface SourceMapListing {
  files: string[];
  expiresAt: number;
}

// Wrap a JSON payload in the MCP response envelope used by every public method
// of SourceMapResolver. Centralising this kills the "{ content: [{ type, text:
// JSON.stringify(...) }] }" boilerplate that previously appeared seven times.
function srMapTextResponse(payload: unknown): { content: Array<{ type: string; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

// Validate MCP/DAP coordinates (1-based lines AND columns). Returns null when
// inputs are valid; returns the error envelope to bubble straight back to the
// caller otherwise. Both resolveGeneratedPosition and resolveOriginalPosition
// need exactly this check, hence the shared helper.
function validateMcpCoordinates(
  line: number,
  column: number,
): { content: Array<{ type: string; text: string }> } | null {
  if (line < 1) {
    return srMapTextResponse({
      success: false,
      error: "Invalid line number: lines must be 1-based (start at 1)",
      receivedLine: line,
      coordinateSystem: "MCP/DAP: 1-based lines, 1-based columns",
    });
  }

  if (column < 1) {
    return srMapTextResponse({
      success: false,
      error: "Invalid column number: columns must be 1-based (start at 1)",
      receivedColumn: column,
      coordinateSystem: "MCP/DAP: 1-based lines, 1-based columns",
    });
  }

  return null;
}

export class SourceMapResolver {
  // mapFile -> { mtime, parsed TraceMap }. Trim oldest entries past the limit so a long
  // session debugging across many bundles doesn't grow unbounded. mtime+size tracking
  // means rebuilds are only paid for files that actually changed on disk.
  private readonly traceMapCache = new Map<string, CachedTraceMap>();
  private readonly sourceMapListingCache = new Map<string, SourceMapListing>();

  private async getTraceMap(mapFile: string): Promise<CachedTraceMap | null> {
    try {
      const stats = await stat(mapFile);
      const cached = this.traceMapCache.get(mapFile);

      if (cached?.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
        // LRU bump.
        this.traceMapCache.delete(mapFile);
        this.traceMapCache.set(mapFile, cached);

        return cached;
      }

      const content = await readFile(mapFile, 'utf-8');
      const traceMap = new TraceMap(content);
      const sourcesByBasename = new Map<string, string[]>();

      for (const source of traceMap.sources) {
        if (!source) continue;

        const basename = source.split('/').pop() ?? '';

        if (!basename) continue;

        const bucket = sourcesByBasename.get(basename) ?? [];

        bucket.push(source);
        sourcesByBasename.set(basename, bucket);
      }

      const entry: CachedTraceMap = {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        traceMap,
        sourcesByBasename,
      };

      this.traceMapCache.set(mapFile, entry);
      while (this.traceMapCache.size > TRACE_MAP_CACHE_LIMIT) {
        const oldestKey = this.traceMapCache.keys().next().value;

        if (oldestKey === undefined) break;
        this.traceMapCache.delete(oldestKey);
      }

      return entry;
    } catch {
      return null;
    }
  }

  // Walk a directory recursively, collecting every *.js.map file. Used by the build-dir
  // scan; ignores read errors silently because directories may exist but be unreadable.
  private async collectSourceMapFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const walk = async (current: string): Promise<void> => {
      let entries;

      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const full = join(current, entry.name);

        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.js.map')) {
          results.push(full);
        }
      }
    };

    await walk(dir);

    return results;
  }

  private async findSourceMapsInDirs(roots: string[]): Promise<string[]> {
    const cacheKey = [...roots].sort().join('|');
    const now = Date.now();
    const cached = this.sourceMapListingCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.files;
    }

    const results: string[] = [];

    for (const root of roots) {
      for (const dir of BUILD_DIRS) {
        const candidate = join(root, dir);

        if (existsSync(candidate)) {
          results.push(...await this.collectSourceMapFiles(candidate));
        }
      }
    }

    this.sourceMapListingCache.set(cacheKey, {
      files: results,
      expiresAt: now + SOURCE_MAP_LISTING_TTL_MS,
    });

    return results;
  }

  // Sibling build dirs next to a TS source under <root>/src/.../foo.ts produce
  // <root>/(dist|build|out|lib)/foo.js.map -- collect those candidates without walking.
  private siblingMapCandidates(originalSourcePath: string): string[] {
    // Normalise to forward slashes so the marker also matches Windows-style
    // paths ("...\\src\\foo.ts"). Without this, the cheap sibling-lookup
    // shortcut quietly degrades to the full build-dir scan on Windows.
    const normalised = originalSourcePath.replace(/\\/g, '/');
    const idx = normalised.lastIndexOf(SOURCE_DIR_MARKER);

    if (idx === -1) return [];

    const baseRoot = normalised.substring(0, idx);
    const fileBase = normalised.substring(idx + SOURCE_DIR_MARKER.length);
    const baseName = fileBase.split('/').pop() ?? '';

    if (!baseName) return [];

    const mapName = baseName.replace(/\.ts$/, '.js.map');

    return BUILD_DIRS
      .map(dir => join(baseRoot, dir, mapName))
      .filter(candidate => existsSync(candidate));
  }

  /**
   * Heuristic for paths that may have a corresponding source map.
   * Restricted to authored TypeScript files; the previous includes('src/') check matched any
   * compiled JavaScript whose absolute path happened to contain 'src/' (e.g. node_modules).
   */
  private looksLikeOriginalSource(filePath: string): boolean {
    return filePath.endsWith('.ts') || filePath.endsWith('.tsx') || filePath.endsWith('.mts') || filePath.endsWith('.cts');
  }

  /**
   * Resolve source map position for TypeScript/JavaScript mapping.
   * columnNumber is required: resolveGeneratedPosition rejects 0 (1-based check),
   * so a default of 0 caused every defaulted call to silently fall back to the
   * original path. Callers must pass a real 1-based column.
   */
  async resolveSourceMapPosition(
    filePath: string,
    lineNumber: number,
    columnNumber: number,
  ): Promise<SourceMapResolution> {
    let targetFilePath = filePath;
    let targetLineNumber = lineNumber;
    let targetColumnNumber = columnNumber;
    let sourceMapInfo: { success: boolean; sourceMapUsed?: string; matchedSource?: string } = { success: false };

    if (this.looksLikeOriginalSource(filePath)) {
      try {
        // Extract relative path for source map resolution
        const srcMarkerIdx = filePath.lastIndexOf(SOURCE_DIR_MARKER);
        const relativePath = srcMarkerIdx !== -1
          ? filePath.substring(srcMarkerIdx + 1)
          : filePath;
        // Try the cheap sibling build-dir lookup first; only walk the full
        // build trees if no sibling map yields a successful generated position.
        const siblings = this.siblingMapCandidates(filePath);
        let resolved: { sourceMapUsed: string; line: number; column: number; matchedSource: string } | null = null;

        if (siblings.length > 0) {
          const siblingResult = await this.resolveGeneratedPosition(relativePath, lineNumber, columnNumber, siblings);
          const siblingData = JSON.parse(siblingResult.content[0]!.text);

          if (siblingData.success) {
            resolved = {
              sourceMapUsed: siblingData.sourceMapUsed,
              line: siblingData.generatedPosition.line,
              column: siblingData.generatedPosition.column,
              matchedSource: siblingData.matchedSource,
            };
          }
        }

        if (!resolved) {
          const projectRoot = findProjectRoot(filePath);
          const sourceMapPaths = projectRoot ? await this.findSourceMapsInDirs([projectRoot]) : [];

          for (const candidate of siblings) {
            if (!sourceMapPaths.includes(candidate)) {
              sourceMapPaths.push(candidate);
            }
          }

          const resolveResult = await this.resolveGeneratedPosition(relativePath, lineNumber, columnNumber, sourceMapPaths);
          const resolveData = JSON.parse(resolveResult.content[0]!.text);

          if (resolveData.success) {
            resolved = {
              sourceMapUsed: resolveData.sourceMapUsed,
              line: resolveData.generatedPosition.line,
              column: resolveData.generatedPosition.column,
              matchedSource: resolveData.matchedSource,
            };
          }
        }

        if (resolved) {
          sourceMapInfo = {
            success: true,
            sourceMapUsed: resolved.sourceMapUsed,
            matchedSource: resolved.matchedSource,
          };

          targetFilePath = resolved.sourceMapUsed.replace(/\.js\.map$/, '.js');
          targetLineNumber = resolved.line;
          targetColumnNumber = resolved.column;
        }
      } catch {
        // Fall back to original path
      }
    }

    return { targetFilePath, targetLineNumber, targetColumnNumber, sourceMapInfo };
  }

  async resolveGeneratedPosition(
    originalSource: string,
    originalLine: number,
    originalColumn: number,
    sourceMapPaths?: string[],
    originalSourcePath?: string,
  ) {
    const coordError = validateMcpCoordinates(originalLine, originalColumn);

    if (coordError) return coordError;

    if (!originalSource) {
      return srMapTextResponse({
        success: false,
        error: "Invalid originalSource: must be a non-empty path or filename",
      });
    }

    try {
      const mapFiles = await this.collectMapFilesForResolve(sourceMapPaths, originalSourcePath);
      const availableSources: Array<{ sourceMap: string; sources: string[] }> = [];

      for (const mapFile of mapFiles) {
        const cached = await this.getTraceMap(mapFile);

        if (!cached || cached.traceMap.sources.length === 0) continue;

        availableSources.push({
          sourceMap: mapFile,
          sources: cached.traceMap.sources.filter((source): source is string => Boolean(source)),
        });

        const matchedSource = this.matchSource(cached, originalSource);

        if (matchedSource) {
          // Convert MCP/DAP coordinates (1-based lines, 1-based columns) to trace-mapping coordinates
          // (1-based lines, 0-based columns).
          const generatedPosition = generatedPositionFor(cached.traceMap, {
            source: matchedSource,
            line: originalLine,
            column: originalColumn - 1,
            bias: LEAST_UPPER_BOUND,
          });

          if (generatedPosition.line !== null) {
            return srMapTextResponse({
              success: true,
              generatedPosition: {
                line: generatedPosition.line,
                column: generatedPosition.column + 1,
              },
              sourceMapUsed: mapFile,
              matchedSource,
            });
          }
        }
      }

      // Suggestions are only useful when nothing matched -- compute them lazily here.
      const suggestions = this.suggestSimilarSources(availableSources, originalSource);

      return srMapTextResponse({
        success: false,
        error: "No matching source found in available source maps",
        searchedMaps: mapFiles.length,
        originalSource,
        coordinateSystem: "MCP/DAP coordinates: 1-based lines, 1-based columns",
        inputCoordinates: { line: originalLine, column: originalColumn },
        availableSources,
        suggestions,
      });
    } catch (error) {
      return srMapTextResponse({
        success: false,
        error: "Failed to resolve generated position",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async resolveOriginalPosition(
    generatedLine: number,
    generatedColumn: number,
    sourceMapPaths?: string[],
    // Optional anchor used to locate the project root when the caller did not
    // pass an explicit sourceMapPaths list. Without this, autodiscovery walks
    // process.cwd(), which only happens to be the right project when the MCP
    // server was launched from there.
    generatedSourcePath?: string,
  ) {
    const coordError = validateMcpCoordinates(generatedLine, generatedColumn);

    if (coordError) return coordError;

    try {
      const mapFiles = await this.collectMapFilesForResolve(sourceMapPaths, generatedSourcePath);

      for (const mapFile of mapFiles) {
        const cached = await this.getTraceMap(mapFile);

        if (!cached) continue;

        // Convert MCP/DAP coordinates (1-based lines, 1-based columns) to trace-mapping
        // coordinates (1-based lines, 0-based columns).
        const originalPosition = originalPositionFor(cached.traceMap, {
          line: generatedLine,
          column: generatedColumn - 1,
        });

        if (originalPosition.source) {
          return srMapTextResponse({
            success: true,
            originalPosition: {
              source: originalPosition.source,
              line: originalPosition.line,
              column: originalPosition.column + 1,
              name: originalPosition.name,
            },
            sourceMapUsed: mapFile,
          });
        }
      }

      return srMapTextResponse({
        success: false,
        error: "No original position found",
        searchedMaps: mapFiles.length,
        coordinateSystem: "MCP/DAP coordinates: 1-based lines, 1-based columns",
        inputCoordinates: { line: generatedLine, column: generatedColumn },
      });
    } catch (error) {
      return srMapTextResponse({
        success: false,
        error: "Failed to resolve original position",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async collectMapFilesForResolve(
    sourceMapPaths: string[] | undefined,
    originalSourcePath: string | undefined,
  ): Promise<string[]> {
    // Honour an explicit list (including the empty array). `[]` means "do not
    // discover, just use these" -- callers rely on this to opt out of the
    // process.cwd() autodiscovery that would otherwise leak unrelated maps.
    if (sourceMapPaths !== undefined) {
      return sourceMapPaths.filter(path => existsSync(path));
    }

    const collected: string[] = [];

    if (originalSourcePath) {
      const projectRoot = findProjectRoot(originalSourcePath);

      if (projectRoot) {
        try {
          collected.push(...await this.findSourceMapsInDirs([projectRoot]));
        } catch {
          // ignore
        }
      }

      for (const candidate of this.siblingMapCandidates(originalSourcePath)) {
        if (!collected.includes(candidate)) {
          collected.push(candidate);
        }
      }
    }

    if (collected.length === 0) {
      collected.push(...await this.findSourceMapsInDirs([process.cwd()]));
    }

    return collected;
  }

  // Match using basename lookup first (cheap), then fall back to suffix matching only on
  // entries from that bucket. Avoids scanning the full sources[] of large bundles.
  private matchSource(cached: CachedTraceMap, originalSource: string): string | undefined {
    const normalizedOriginal = originalSource.replace(/\\/g, '/');
    const originalBaseName = normalizedOriginal.split('/').pop() ?? '';

    if (!originalBaseName) return undefined;

    const candidates = cached.sourcesByBasename.get(originalBaseName) ?? [];

    for (const candidate of candidates) {
      const normalizedCandidate = candidate.replace(/^(\.\.\/)+/, '').replace(/\\/g, '/');

      if (
        normalizedCandidate.endsWith(normalizedOriginal) ||
        normalizedOriginal.endsWith(normalizedCandidate) ||
        normalizedCandidate === originalBaseName ||
        normalizedCandidate.endsWith(`/${originalBaseName}`)
      ) {
        return candidate;
      }
    }

    return undefined;
  }

  private suggestSimilarSources(
    availableSources: Array<{ sourceMap: string; sources: string[] }>,
    originalSource: string,
  ): string[] {
    const originalBaseName = originalSource.split('/').pop() ?? '';

    if (!originalBaseName) return [];

    const matches = new Set<string>();

    for (const entry of availableSources) {
      for (const source of entry.sources) {
        const sourceBaseName = source.split('/').pop() ?? '';

        if (
          sourceBaseName.includes(originalBaseName) ||
          originalBaseName.includes(sourceBaseName)
        ) {
          matches.add(source);
        }
      }
    }

    return Array.from(matches);
  }
}
