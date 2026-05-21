import { TraceMap, originalPositionFor, generatedPositionFor, LEAST_UPPER_BOUND } from "@jridgewell/trace-mapping";
import { readFile, stat, readdir, access } from "node:fs/promises";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import safeStringify from "safe-stable-stringify";
import { findProjectRoot, errorMessage } from "./utils.js";
import { BUILD_DIRS, SOURCE_DIR_MARKER } from "./constants.js";

// Async existence check via fs.access — returns true on success, false on any
// error (ENOENT, EACCES, etc). Keeps the call-sites here off the synchronous
// existsSync hot path so a slow stat does not block the event loop while
// resolving breakpoints / source maps.
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);

    return true;
  } catch {
    return false;
  }
}

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

// Typed internal result of resolveGeneratedPosition / resolveOriginalPosition.
// The public MCP-wrapped methods stringify these; in-process callers consume
// the typed shape directly, sidestepping a JSON.parse round-trip and the
// implicit "the wire JSON happens to round-trip cleanly" coupling.
interface GeneratedPositionSuccess {
  success: true;
  generatedPosition: { line: number; column: number };
  sourceMapUsed: string;
  matchedSource: string;
}

interface GeneratedPositionFailure {
  success: false;
  reason: 'invalid-coordinates' | 'invalid-source' | 'no-match' | 'error';
  // Diagnostic payload mirrors the wire envelope so callers wanting to forward
  // the failure straight to MCP do not have to recompute fields.
  error: string;
  receivedLine?: number;
  receivedColumn?: number;
  searchedMaps?: number;
  originalSource?: string;
  inputCoordinates?: { line: number; column: number };
  availableSources?: Array<{ sourceMap: string; sources: string[] }>;
  suggestions?: string[];
  message?: string;
}

type GeneratedPositionResult = GeneratedPositionSuccess | GeneratedPositionFailure;

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
// of SourceMapResolver. Centralising this kills the boilerplate that previously
// appeared seven times. Uses safe-stable-stringify so wire-format size and
// key order match createSuccessResponse / createErrorResponse from utils.ts.
function srMapTextResponse(payload: unknown): { content: Array<{ type: string; text: string }> } {
  return {
    content: [{ type: "text", text: safeStringify(payload) ?? '' }],
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

/**
 * Resolves TypeScript<->JavaScript coordinates against `*.js.map` files.
 *
 * Maintains two caches keyed by file mtime/size:
 *
 * 1. `traceMapCache` -- parsed {@link TraceMap} per `.map` file, plus a
 *    `sourcesByBasename` index for O(1) source-name lookups.
 * 2. `sourceMapListingCache` -- short-TTL directory listings so repeat
 *    breakpoint placements do not rescan the build directory.
 *
 * All public methods accept and return DAP/MCP 1-based line / column numbers
 * and convert to the trace-mapping 0-based column convention internally.
 * Cache invalidation is automatic: rebuilds are paid only for `.map` files
 * whose mtime+size actually changed on disk.
 */
export class SourceMapResolver {
  // mapFile -> { mtime, parsed TraceMap }. Trim oldest entries past the limit so a long
  // session debugging across many bundles doesn't grow unbounded. mtime+size tracking
  // means rebuilds are only paid for files that actually changed on disk.
  private readonly traceMapCache = new Map<string, CachedTraceMap>();
  private readonly sourceMapListingCache = new Map<string, SourceMapListing>();
  // Cross-map basename index: sourceBaseName -> set of map files whose
  // `sources[]` contains a path with that basename. Lets the resolve loop
  // skip directly to maps that might contain the requested source, instead of
  // doing one matchSource() call per map in the listing. Populated lazily by
  // getTraceMap; entries are removed on cache replace, LRU eviction, and the
  // invalidate* methods.
  private readonly mapsByBasename = new Map<string, Set<string>>();

  private addBasenamesForMap(mapFile: string, entry: CachedTraceMap): void {
    for (const sourceBase of entry.sourcesByBasename.keys()) {
      let set = this.mapsByBasename.get(sourceBase);

      if (!set) {
        set = new Set<string>();
        this.mapsByBasename.set(sourceBase, set);
      }

      set.add(mapFile);
    }
  }

  private removeBasenamesForMap(mapFile: string, entry: CachedTraceMap): void {
    for (const sourceBase of entry.sourcesByBasename.keys()) {
      const set = this.mapsByBasename.get(sourceBase);

      if (!set) continue;

      set.delete(mapFile);

      if (set.size === 0) this.mapsByBasename.delete(sourceBase);
    }
  }

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

        // Source-map source paths use '/' per spec; basename() handles that
        // case and (on Windows) also normalises backslashes if a source map
        // ever emitted them.
        const sourceBase = basename(source);

        if (!sourceBase) continue;

        const bucket = sourcesByBasename.get(sourceBase) ?? [];

        bucket.push(source);
        sourcesByBasename.set(sourceBase, bucket);
      }

      const entry: CachedTraceMap = {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        traceMap,
        sourcesByBasename,
      };

      // Update the cross-map index: drop stale basenames (when an old entry
      // existed at this key with different sources after a rebuild), then add
      // the new ones.
      if (cached) this.removeBasenamesForMap(mapFile, cached);
      this.addBasenamesForMap(mapFile, entry);

      this.traceMapCache.set(mapFile, entry);
      while (this.traceMapCache.size > TRACE_MAP_CACHE_LIMIT) {
        const oldestKey = this.traceMapCache.keys().next().value;

        if (oldestKey === undefined) break;

        const evicted = this.traceMapCache.get(oldestKey);

        if (evicted) this.removeBasenamesForMap(oldestKey, evicted);

        this.traceMapCache.delete(oldestKey);
      }

      return entry;
    } catch {
      // stat/readFile failure (file vanished mid-build, permission denied,
      // malformed map JSON). Treat as cache miss; the caller falls back to the
      // original (TS) path so a broken map never blocks debugging.
      return null;
    }
  }

  // Directory names that are never walked when scanning a build root for
  // `.js.map` files. node_modules can be huge and the maps inside belong to
  // third-party packages we are not setting breakpoints on; .git holds packfile
  // blobs; .cache / .next / .turbo / .nuxt / .svelte-kit / .vercel are
  // framework caches that ship many transient maps from intermediate
  // compilation. Skipping these is a correctness + cost win: the listing only
  // contains application output.
  private static readonly SKIP_DIR_NAMES = new Set([
    'node_modules',
    '.git',
    '.cache',
    '.next',
    '.turbo',
    '.nuxt',
    '.svelte-kit',
    '.vercel',
  ]);

  // Walk a directory recursively, collecting every *.js.map file, but skipping
  // the directory names in SKIP_DIR_NAMES so a project root with deep
  // node_modules does not turn into a multi-second scan. Done by hand instead
  // of via `readdir(..., { recursive: true })` because the built-in walker has
  // no pre-descent filter -- it walks everything and lets us filter after.
  // Errors on individual subdirectories are ignored (unreadable / disappeared
  // mid-build) so a broken subtree never breaks the whole listing.
  private async collectSourceMapFiles(dir: string): Promise<string[]> {
    const results: string[] = [];
    const stack: string[] = [dir];

    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries;

      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        // Missing or unreadable subtree is not fatal; move on.
        continue;
      }

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SourceMapResolver.SKIP_DIR_NAMES.has(entry.name)) continue;
          stack.push(join(current, entry.name));
        } else if (entry.isFile() && entry.name.endsWith('.js.map')) {
          results.push(join(current, entry.name));
        }
      }
    }

    return results;
  }

  private async findSourceMapsInDirs(roots: string[]): Promise<string[]> {
    // Use safeStringify so a root path containing `|` (legal on POSIX) cannot
    // collide with another root list whose components, joined by `|`, happen
    // to produce the same string after sort. safe-stable-stringify keeps the
    // serialization deterministic and matches project policy banning raw JSON.stringify.
    const cacheKey = safeStringify([...roots].sort());
    const now = Date.now();
    const cached = this.sourceMapListingCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.files;
    }

    const results: string[] = [];

    for (const root of roots) {
      for (const dir of BUILD_DIRS) {
        const candidate = join(root, dir);

        if (await pathExists(candidate)) {
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
  private async siblingMapCandidates(originalSourcePath: string): Promise<string[]> {
    // Normalise to forward slashes so the marker also matches Windows-style
    // paths ("...\\src\\foo.ts"). Without this, the cheap sibling-lookup
    // shortcut quietly degrades to the full build-dir scan on Windows.
    const normalised = originalSourcePath.replace(/\\/g, '/');
    const idx = normalised.lastIndexOf(SOURCE_DIR_MARKER);

    if (idx === -1) return [];

    const baseRoot = normalised.substring(0, idx);
    const fileBase = normalised.substring(idx + SOURCE_DIR_MARKER.length);
    const baseName = basename(fileBase);

    if (!baseName) return [];

    // Strip *any* TS/JS source extension before composing the map name. The
    // previous `.ts -> .js.map` rule worked for TypeScript-only projects but
    // ignored .tsx/.mts/.cts authored sources, and also missed pre-compiled
    // .js inputs (esbuild/swc keeping the .js extension), so the sibling-map
    // fast path silently degraded to the full build-dir scan for those.
    const mapName = `${baseName.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, '')}.js.map`;
    const candidates = BUILD_DIRS.map(dir => join(baseRoot, dir, mapName));
    const existsFlags = await Promise.all(candidates.map(c => pathExists(c)));

    return candidates.filter((_, i) => existsFlags[i]);
  }

  /**
   * Heuristic for paths that may have a corresponding source map.
   *
   * - Authored TypeScript (`.ts/.tsx/.mts/.cts`) is always considered original
   *   because that is the canonical input shape for this server.
   * - Plain JavaScript (`.js/.jsx/.mjs/.cjs`) is considered original only when
   *   either (a) the path sits under SOURCE_DIR_MARKER (looks like authored
   *   source kept in `/src/...`) or (b) an adjacent `<file>.map` exists. Both
   *   gates are cheap and prevent every plain-JS breakpoint placement from
   *   kicking off a project-wide source-map discovery scan when the file has
   *   no source map at all (the common case for runtime/node_modules JS).
   */
  private async looksLikeOriginalSource(filePath: string): Promise<boolean> {
    if (/\.(ts|tsx|mts|cts)$/.test(filePath)) return true;
    if (!/\.(js|jsx|mjs|cjs)$/.test(filePath)) return false;

    const normalised = filePath.replace(/\\/g, '/');

    if (normalised.includes(SOURCE_DIR_MARKER)) return true;

    return pathExists(`${filePath}.map`);
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

    if (await this.looksLikeOriginalSource(filePath)) {
      try {
        // Extract relative path for source map resolution
        const srcMarkerIdx = filePath.lastIndexOf(SOURCE_DIR_MARKER);
        const relativePath = srcMarkerIdx !== -1
          ? filePath.substring(srcMarkerIdx + 1)
          : filePath;
        // Try the cheap sibling build-dir lookup first; only walk the full
        // build trees if no sibling map yields a successful generated position.
        const siblings = await this.siblingMapCandidates(filePath);
        let resolved: { sourceMapUsed: string; line: number; column: number; matchedSource: string } | null = null;

        if (siblings.length > 0) {
          // Pass the absolute filePath so matchSource can require an exact
          // suffix match — in monorepos with several maps containing the same
          // basename (e.g. `index.ts` in multiple packages) the basename-only
          // heuristic would otherwise pick a wrong sibling deterministically
          // by readdir order. Calls the typed internal API to avoid a
          // JSON.parse round-trip through the MCP envelope.
          const siblingData = await this.resolveGeneratedPositionInternal(
            relativePath, lineNumber, columnNumber, siblings, filePath,
          );

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
          // Set-based dedup: avoid the O(N^2) array.includes() loop when the
          // project has dozens of .js.map candidates.
          const dedup = new Set<string>(
            projectRoot ? await this.findSourceMapsInDirs([projectRoot]) : [],
          );

          for (const candidate of siblings) {
            dedup.add(candidate);
          }

          const sourceMapPaths = Array.from(dedup);
          const resolveData = await this.resolveGeneratedPositionInternal(
            relativePath, lineNumber, columnNumber, sourceMapPaths, filePath,
          );

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
        // Any source-map resolution failure (no project root, malformed maps,
        // missing sibling) falls back to the original TS path. The runtime
        // will surface a "no script for url" diagnostic if the path was wrong.
      }
    }

    return { targetFilePath, targetLineNumber, targetColumnNumber, sourceMapInfo };
  }

  /**
   * Typed internal entry point. Public `resolveGeneratedPosition` wraps this in
   * an MCP envelope; in-process callers (e.g. {@link resolveSourceMapPosition})
   * consume the typed result directly.
   */
  private async resolveGeneratedPositionInternal(
    originalSource: string,
    originalLine: number,
    originalColumn: number,
    sourceMapPaths: string[] | undefined,
    originalSourcePath: string | undefined,
  ): Promise<GeneratedPositionResult> {
    if (originalLine < 1) {
      return {
        success: false,
        reason: 'invalid-coordinates',
        error: 'Invalid line number: lines must be 1-based (start at 1)',
        receivedLine: originalLine,
      };
    }

    if (originalColumn < 1) {
      return {
        success: false,
        reason: 'invalid-coordinates',
        error: 'Invalid column number: columns must be 1-based (start at 1)',
        receivedColumn: originalColumn,
      };
    }

    if (!originalSource) {
      return {
        success: false,
        reason: 'invalid-source',
        error: 'Invalid originalSource: must be a non-empty path or filename',
      };
    }

    try {
      const mapFiles = await this.collectMapFilesForResolve(sourceMapPaths, originalSourcePath);
      const availableSources: Array<{ sourceMap: string; sources: string[] }> = [];
      // Walk hot candidates first: maps already parsed and known to contain a
      // source with this basename. Falls back to the full listing for anything
      // not yet seen by getTraceMap, preserving correctness on cold caches.
      const originalBaseName = basename(originalSource.replace(/\\/g, '/'));
      const hotCandidates = originalBaseName
        ? this.mapsByBasename.get(originalBaseName)
        : undefined;
      const orderedMapFiles = hotCandidates && hotCandidates.size > 0
        ? [
          ...mapFiles.filter(m => hotCandidates.has(m)),
          ...mapFiles.filter(m => !hotCandidates.has(m)),
        ]
        : mapFiles;

      for (const mapFile of orderedMapFiles) {
        const cached = await this.getTraceMap(mapFile);

        if (!cached || cached.traceMap.sources.length === 0) continue;

        availableSources.push({
          sourceMap: mapFile,
          sources: cached.traceMap.sources.filter((source): source is string => Boolean(source)),
        });

        const matchedSource = this.matchSource(cached, mapFile, originalSource, originalSourcePath);

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
            return {
              success: true,
              generatedPosition: {
                line: generatedPosition.line,
                column: generatedPosition.column + 1,
              },
              sourceMapUsed: mapFile,
              matchedSource,
            };
          }
        }
      }

      return {
        success: false,
        reason: 'no-match',
        error: 'No matching source found in available source maps',
        searchedMaps: mapFiles.length,
        originalSource,
        inputCoordinates: { line: originalLine, column: originalColumn },
        availableSources,
        // Suggestions are only useful when nothing matched -- compute lazily.
        suggestions: this.suggestSimilarSources(availableSources, originalSource),
      };
    } catch (error) {
      return {
        success: false,
        reason: 'error',
        error: 'Failed to resolve generated position',
        message: errorMessage(error),
      };
    }
  }

  async resolveGeneratedPosition(
    originalSource: string,
    originalLine: number,
    originalColumn: number,
    sourceMapPaths?: string[],
    originalSourcePath?: string,
  ) {
    const result = await this.resolveGeneratedPositionInternal(
      originalSource, originalLine, originalColumn, sourceMapPaths, originalSourcePath,
    );

    if (result.success) {
      return srMapTextResponse({
        success: true,
        generatedPosition: result.generatedPosition,
        sourceMapUsed: result.sourceMapUsed,
        matchedSource: result.matchedSource,
      });
    }

    // Failure envelope: include the same diagnostic fields the prior wire
    // format carried so MCP consumers see no regression.
    return srMapTextResponse({
      success: false,
      error: result.error,
      ...(result.receivedLine !== undefined ? {
        receivedLine: result.receivedLine,
        coordinateSystem: 'MCP/DAP: 1-based lines, 1-based columns',
      } : {}),
      ...(result.receivedColumn !== undefined ? {
        receivedColumn: result.receivedColumn,
        coordinateSystem: 'MCP/DAP: 1-based lines, 1-based columns',
      } : {}),
      ...(result.searchedMaps !== undefined ? { searchedMaps: result.searchedMaps } : {}),
      ...(result.originalSource !== undefined ? { originalSource: result.originalSource } : {}),
      ...(result.inputCoordinates !== undefined ? {
        coordinateSystem: 'MCP/DAP coordinates: 1-based lines, 1-based columns',
        inputCoordinates: result.inputCoordinates,
      } : {}),
      ...(result.availableSources !== undefined ? { availableSources: result.availableSources } : {}),
      ...(result.suggestions !== undefined ? { suggestions: result.suggestions } : {}),
      ...(result.message !== undefined ? { message: result.message } : {}),
    });
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
        message: errorMessage(error),
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
      const existsFlags = await Promise.all(sourceMapPaths.map(p => pathExists(p)));

      return sourceMapPaths.filter((_, i) => existsFlags[i]);
    }

    // Set-based dedup: previous loop did Array.includes() per candidate, which
    // is O(N^2) for files with dozens of .js.map siblings on the hot
    // setBreakpoint path.
    const collected = new Set<string>();

    if (originalSourcePath) {
      const projectRoot = findProjectRoot(originalSourcePath);

      if (projectRoot) {
        try {
          for (const m of await this.findSourceMapsInDirs([projectRoot])) {
            collected.add(m);
          }
        } catch {
          // findSourceMapsInDirs swallows per-directory errors itself; this
          // outer catch is a safety net for an unexpected throw (TraceMap
          // construction). siblingMapCandidates below is still useful.
        }
      }

      for (const candidate of await this.siblingMapCandidates(originalSourcePath)) {
        collected.add(candidate);
      }
    }

    if (collected.size === 0) {
      for (const m of await this.findSourceMapsInDirs([process.cwd()])) {
        collected.add(m);
      }
    }

    return Array.from(collected);
  }

  // Match using basename lookup first (cheap), then fall back to suffix matching only on
  // entries from that bucket. Avoids scanning the full sources[] of large bundles.
  //
  // When `originalSourcePath` is provided, the candidate is additionally
  // required to resolve to that exact absolute path (relative to the map's
  // own directory). This is what disambiguates a monorepo where the same
  // basename appears in multiple packages -- without it, the basename
  // heuristic would non-deterministically pick whichever map walked first.
  private matchSource(
    cached: CachedTraceMap,
    mapFile: string,
    originalSource: string,
    originalSourcePath?: string,
  ): string | undefined {
    const normalizedOriginal = originalSource.replace(/\\/g, '/');
    const originalBaseName = basename(normalizedOriginal);

    if (!originalBaseName) return undefined;

    const candidates = cached.sourcesByBasename.get(originalBaseName) ?? [];
    const mapDir = dirname(mapFile);
    const normalizedAbsTarget = originalSourcePath
      ? resolvePath(originalSourcePath).replace(/\\/g, '/')
      : undefined;

    for (const candidate of candidates) {
      const normalizedCandidate = candidate.replace(/^(\.\.\/)+/, '').replace(/\\/g, '/');
      const basenameMatch =
        normalizedCandidate.endsWith(normalizedOriginal) ||
        normalizedOriginal.endsWith(normalizedCandidate) ||
        normalizedCandidate === originalBaseName ||
        normalizedCandidate.endsWith(`/${originalBaseName}`);

      if (!basenameMatch) continue;

      if (normalizedAbsTarget !== undefined) {
        const resolvedCandidate = resolvePath(mapDir, candidate).replace(/\\/g, '/');

        if (resolvedCandidate !== normalizedAbsTarget) continue;
      }

      return candidate;
    }

    return undefined;
  }

  /**
   * Drop the cached directory listing of `.js.map` files. Use after a known
   * rebuild when waiting up to {@link SOURCE_MAP_LISTING_TTL_MS} for the TTL
   * to expire is not acceptable -- e.g. an AI agent that just triggered a
   * build and immediately wants to set a breakpoint on the freshly emitted
   * file. Passing `roots` clears only matching entries; passing nothing
   * clears the whole listing cache. The parsed trace-map cache is keyed by
   * mtime+size and self-invalidates per file, so it stays intact.
   */
  invalidateSourceMapListing(roots?: string[]): void {
    if (roots === undefined) {
      this.sourceMapListingCache.clear();

      return;
    }

    const targetKey = safeStringify([...roots].sort());

    this.sourceMapListingCache.delete(targetKey);
  }

  /**
   * Drop the parsed {@link TraceMap} cache entry for a single `.map` file, or
   * the whole cache when no argument is passed. The cache is already keyed by
   * mtime+size, so callers rarely need this -- it exists for tests and for
   * recovery from cases where an upstream tool rewrote a map atomically with
   * the same size+mtime.
   *
   * Also keeps the cross-map basename index ({@link mapsByBasename}) in sync
   * so subsequent resolves do not get pointed at maps that are no longer in
   * the parsed cache.
   */
  invalidateTraceMap(mapFile?: string): void {
    if (mapFile === undefined) {
      this.traceMapCache.clear();
      this.mapsByBasename.clear();

      return;
    }

    const cached = this.traceMapCache.get(mapFile);

    if (cached) this.removeBasenamesForMap(mapFile, cached);

    this.traceMapCache.delete(mapFile);
  }

  private suggestSimilarSources(
    availableSources: Array<{ sourceMap: string; sources: string[] }>,
    originalSource: string,
  ): string[] {
    const originalBaseName = basename(originalSource);

    if (!originalBaseName) return [];

    const matches = new Set<string>();

    for (const entry of availableSources) {
      for (const source of entry.sources) {
        const sourceBaseName = basename(source);

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
