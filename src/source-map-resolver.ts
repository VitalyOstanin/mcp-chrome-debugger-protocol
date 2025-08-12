import { TraceMap, originalPositionFor, generatedPositionFor, LEAST_UPPER_BOUND } from "@jridgewell/trace-mapping";
import { readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SourceMapResolution {
  targetFilePath: string;
  targetLineNumber: number;
  targetColumnNumber: number;
  sourceMapInfo: {
    success: boolean;
    sourceMapUsed?: string;
    matchedSource?: string;
  };
}

export class SourceMapResolver {
  /**
   * Find project root directory from a file path by looking for package.json
   */
  private findProjectRootFromPath(filePath: string): string | null {
    let currentDir = dirname(filePath);

    while (currentDir !== dirname(currentDir)) {
      if (existsSync(join(currentDir, 'package.json'))) {
        return currentDir;
      }
      currentDir = dirname(currentDir);
    }

    return null;
  }

  /**
   * Find all source map files in a specific project
   */
  private async findSourceMapsInProject(projectRoot: string): Promise<string[]> {
    const buildDirs = ['dist', 'build', 'out', 'lib'];
    const results: string[] = [];
    const walk = async (dir: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const full = join(dir, entry.name);

          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.isFile() && entry.name.endsWith('.js.map')) {
            results.push(full);
          }
        }
      } catch {
        // ignore
      }
    };

    for (const buildDir of buildDirs) {
      const projectBuildDir = join(projectRoot, buildDir);

      if (existsSync(projectBuildDir)) {
        await walk(projectBuildDir);
      }
    }

    return results;
  }

  /**
   * Resolve source map position for TypeScript/JavaScript mapping
   */
  async resolveSourceMapPosition(
    filePath: string,
    lineNumber: number,
    columnNumber: number = 0,
  ): Promise<SourceMapResolution> {
    let targetFilePath = filePath;
    let targetLineNumber = lineNumber;
    let targetColumnNumber = columnNumber;
    let sourceMapInfo: { success: boolean; sourceMapUsed?: string; matchedSource?: string } = { success: false };

    if (filePath.endsWith('.ts') || filePath.includes('src/')) {
      try {
        // Extract relative path for source map resolution
        const relativePath = filePath.includes('src/')
          ? filePath.substring(filePath.indexOf('src/'))
          : filePath;
        // Find source map files from the target project directory
        const projectRoot = this.findProjectRootFromPath(filePath);
        const sourceMapPaths = projectRoot ? await this.findSourceMapsInProject(projectRoot) : [];

        // Also try a direct sibling build directory next to the TS source
        // e.g. <root>/src/index.ts -> <root>/(dist|build|out|lib)/index.js.map
        try {
          const srcMarker = '/src/';
          const idx = filePath.lastIndexOf(srcMarker);

          if (idx !== -1) {
            const baseRoot = filePath.substring(0, idx);
            const fileBase = filePath.substring(idx + srcMarker.length).replace(/\\/g, '/');
            const baseName = fileBase.split('/').pop() ?? '';
            const mapName = baseName.replace(/\.ts$/, '.js.map');
            const buildDirs = ['dist', 'build', 'out', 'lib'];

            for (const dir of buildDirs) {
              const candidate = join(baseRoot, dir, mapName);

              if (existsSync(candidate) && !sourceMapPaths.includes(candidate)) {
                sourceMapPaths.push(candidate);
              }
            }
          }
        } catch { void 0; }

        const resolveResult = await this.resolveGeneratedPosition(relativePath, lineNumber, columnNumber, sourceMapPaths);
        const resolveData = JSON.parse(resolveResult.content[0].text);

        if (resolveData.success) {
          sourceMapInfo = {
            success: true,
            sourceMapUsed: resolveData.sourceMapUsed,
            matchedSource: resolveData.matchedSource,
          };

          targetFilePath = resolveData.sourceMapUsed.replace(/\.js\.map$/, '.js');
          targetLineNumber = resolveData.generatedPosition.line;
          targetColumnNumber = resolveData.generatedPosition.column;
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
    // Validate MCP/DAP coordinate system: both lines and columns are 1-based
    if (originalLine < 1) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Invalid line number: lines must be 1-based (start at 1)",
            receivedLine: originalLine,
            coordinateSystem: "MCP/DAP: 1-based lines, 1-based columns",
          }),
        }],
      };
    }

    if (originalColumn < 1) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Invalid column number: columns must be 1-based (start at 1)",
            receivedColumn: originalColumn,
            coordinateSystem: "MCP/DAP: 1-based lines, 1-based columns",
          }),
        }],
      };
    }

    try {
      let mapFiles: string[] = [];

      if (sourceMapPaths?.length) {
        mapFiles = sourceMapPaths.filter(path => existsSync(path));
      } else {
        // Auto-detect maps
        if (originalSourcePath) {
          // 1) Find project root from the absolute TS path
          const projectRoot = this.findProjectRootFromPath(originalSourcePath);

          if (projectRoot) {
            try {
              const found = await this.findSourceMapsInProject(projectRoot);

              mapFiles.push(...found);
            } catch { void 0; }
          }

          // 2) Try sibling build dirs next to the TS source
          try {
            const srcMarker = '/src/';
            const idx = originalSourcePath.lastIndexOf(srcMarker);

            if (idx !== -1) {
              const baseRoot = originalSourcePath.substring(0, idx);
              const fileBase = originalSourcePath.substring(idx + srcMarker.length).replace(/\\/g, '/');
              const baseName = fileBase.split('/').pop() ?? '';
              const mapName = baseName.replace(/\.ts$/, '.js.map');
              const buildDirs = ['dist', 'build', 'out', 'lib'];

              for (const dir of buildDirs) {
                const candidate = join(baseRoot, dir, mapName);

                if (existsSync(candidate) && !mapFiles.includes(candidate)) {
                  mapFiles.push(candidate);
                }
              }
            }
          } catch { void 0; }
        }

        // 3) Fallback: search in current working directory build dirs (async)
        if (mapFiles.length === 0) {
          const buildDirs = ['dist', 'build', 'out', 'lib'];
          const results: string[] = [];
          const walk = async (dir: string) => {
            try {
              const entries = await readdir(dir, { withFileTypes: true });

              for (const entry of entries) {
                const full = join(dir, entry.name);

                if (entry.isDirectory()) {
                  await walk(full);
                } else if (entry.isFile() && entry.name.endsWith('.js.map')) {
                  results.push(full);
                }
              }
            } catch {
              // ignore
            }
          };

          for (const buildDir of buildDirs) {
            if (existsSync(buildDir)) {
              await walk(buildDir);
            }
          }

          mapFiles.push(...results);
        }
      }

      const availableSources = [];
      const suggestions = [];

      for (const mapFile of mapFiles) {
        try {
          const mapContent = readFileSync(mapFile, 'utf-8');
          const map = new TraceMap(mapContent);

          if (map.sources.length) {
            availableSources.push({
              sourceMap: mapFile,
              sources: map.sources.filter(Boolean),
            });

            // Add suggestions based on similar source names
            const originalBaseName = originalSource.split('/').pop() ?? '';
            const similarSources = map.sources.filter(source => {
              if (!source) return false;

              const sourceBaseName = source.split('/').pop() ?? '';

              return sourceBaseName.includes(originalBaseName) || originalBaseName.includes(sourceBaseName);
            });

            if (similarSources.length) {
              suggestions.push(...similarSources);
            }

            const matchedSource = map.sources.find(source => {
              if (!source) return false;

              const normalizedSource = source.replace(/^\.\.\//, '').replace(/\\/g, '/');
              const normalizedOriginal = originalSource.replace(/\\/g, '/');

              return normalizedSource.endsWith(normalizedOriginal) ||
                     normalizedOriginal.endsWith(normalizedSource) ||
                     normalizedSource.includes(normalizedOriginal.split('/').pop() ?? '');
            });

            if (matchedSource) {
              // Convert MCP/DAP coordinates (1-based lines, 1-based columns) to trace-mapping coordinates (1-based lines, 0-based columns)
              const generatedPosition = generatedPositionFor(map, {
                source: matchedSource,
                line: originalLine, // MCP 1-based line matches trace-mapping 1-based line
                column: originalColumn - 1, // Convert MCP 1-based column to trace-mapping 0-based column
                bias: LEAST_UPPER_BOUND,
              });

              if (generatedPosition.line !== null) {
                return {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      success: true,
                      generatedPosition: {
                        line: generatedPosition.line, // trace-mapping returns 1-based line (matches MCP/DAP)
                        column: generatedPosition.column + 1, // Convert trace-mapping 0-based column back to MCP/DAP 1-based column
                      },
                      sourceMapUsed: mapFile,
                      matchedSource,
                    }),
                  }],
                };
              }
            }
          }
        } catch {
          continue;
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "No matching source found in available source maps",
            searchedMaps: mapFiles.length,
            originalSource,
            coordinateSystem: "MCP/DAP coordinates: 1-based lines, 1-based columns",
            inputCoordinates: { line: originalLine, column: originalColumn },
            availableSources,
            suggestions: [...new Set(suggestions)],
          }),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Failed to resolve generated position",
            message: error instanceof Error ? error.message : String(error),
          }),
        }],
      };
    }
  }

  async resolveOriginalPosition(generatedLine: number, generatedColumn: number, sourceMapPaths?: string[]) {
    // Validate MCP/DAP coordinate system: both lines and columns are 1-based
    if (generatedLine < 1) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Invalid line number: lines must be 1-based (start at 1)",
            receivedLine: generatedLine,
            coordinateSystem: "MCP/DAP: 1-based lines, 1-based columns",
          }),
        }],
      };
    }

    if (generatedColumn < 1) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Invalid column number: columns must be 1-based (start at 1)",
            receivedColumn: generatedColumn,
            coordinateSystem: "MCP/DAP: 1-based lines, 1-based columns",
          }),
        }],
      };
    }

    try {
      let mapFiles: string[] = [];

      if (sourceMapPaths) {
        mapFiles = sourceMapPaths.filter(path => existsSync(path));
      } else {
        // Use consistent search strategy as resolveGeneratedPosition (async)
        const buildDirs = ['dist', 'build', 'out', 'lib'];
        const results: string[] = [];
        const walk = async (dir: string) => {
          try {
            const entries = await readdir(dir, { withFileTypes: true });

            for (const entry of entries) {
              const full = join(dir, entry.name);

              if (entry.isDirectory()) {
                await walk(full);
              } else if (entry.isFile() && entry.name.endsWith('.js.map')) {
                results.push(full);
              }
            }
          } catch {
            // ignore
          }
        };

        for (const buildDir of buildDirs) {
          if (existsSync(buildDir)) {
            await walk(buildDir);
          }
        }

        mapFiles.push(...results);
      }

      for (const mapFile of mapFiles) {
        try {
          const mapContent = readFileSync(mapFile, 'utf-8');
          const map = new TraceMap(mapContent);
          // Convert MCP/DAP coordinates (1-based lines, 1-based columns) to trace-mapping coordinates (1-based lines, 0-based columns)
          const originalPosition = originalPositionFor(map, {
            line: generatedLine, // MCP 1-based line matches trace-mapping 1-based line
            column: generatedColumn - 1, // Convert MCP 1-based column to trace-mapping 0-based column
          });

          if (originalPosition.source) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: true,
                  originalPosition: {
                    source: originalPosition.source,
                    line: originalPosition.line, // trace-mapping returns 1-based line (matches MCP/DAP)
                    column: (originalPosition.column || 0) + 1, // Convert trace-mapping 0-based column back to MCP/DAP 1-based column
                    name: originalPosition.name,
                  },
                  sourceMapUsed: mapFile,
                }),
              }],
            };
          }
        } catch {
          continue;
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "No original position found",
            searchedMaps: mapFiles.length,
            coordinateSystem: "MCP/DAP coordinates: 1-based lines, 1-based columns",
            inputCoordinates: { line: generatedLine, column: generatedColumn },
          }),
        }],
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Failed to resolve original position",
            message: error instanceof Error ? error.message : String(error),
          }),
        }],
      };
    }
  }
}
