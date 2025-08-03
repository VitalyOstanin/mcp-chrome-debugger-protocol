import { TraceMap, originalPositionFor, generatedPositionFor, LEAST_UPPER_BOUND } from "@jridgewell/trace-mapping";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
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
    const mapFiles: string[] = [];
    const buildDirs = ['dist', 'build', 'out', 'lib'];

    for (const buildDir of buildDirs) {
      const projectBuildDir = join(projectRoot, buildDir);

      if (existsSync(projectBuildDir)) {
        try {
          const findCmd = process.platform === 'win32'
            ? `dir /s /b "${projectBuildDir}\\*.js.map"`
            : `find "${projectBuildDir}" -name "*.js.map"`;
          const output = execSync(findCmd, { encoding: 'utf-8' });
          const foundMaps = output.trim().split('\n').filter(Boolean);

          mapFiles.push(...foundMaps);
        } catch {
          // Continue with other build directories
        }
      }
    }

    return mapFiles;
  }

  /**
   * Resolve source map position for TypeScript/JavaScript mapping
   */
  async resolveSourceMapPosition(
    filePath: string,
    lineNumber: number,
    columnNumber: number = 0
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
        const sourceMapPaths = projectRoot ? await this.findSourceMapsInProject(projectRoot) : undefined;

        const resolveResult = await this.resolveGeneratedPosition(relativePath, lineNumber, columnNumber, sourceMapPaths);
        const resolveData = JSON.parse(resolveResult.content[0].text);

        if (resolveData.success) {
          sourceMapInfo = {
            success: true,
            sourceMapUsed: resolveData.sourceMapUsed,
            matchedSource: resolveData.matchedSource
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

  async resolveGeneratedPosition(originalSource: string, originalLine: number, originalColumn: number, sourceMapPaths?: string[]) {
    try {
      let mapFiles: string[] = [];

      if (sourceMapPaths && sourceMapPaths.length > 0) {
        mapFiles = sourceMapPaths.filter(path => existsSync(path));
      } else {
        // Fallback: search in current project build directories only
        const buildDirs = ['dist', 'build', 'out', 'lib'];

        for (const buildDir of buildDirs) {
          if (existsSync(buildDir)) {
            try {
              const findCmd = process.platform === 'win32'
                ? `dir /s /b "${buildDir}\\*.js.map"`
                : `find "${buildDir}" -name "*.js.map"`;
              const output = execSync(findCmd, { encoding: 'utf-8' });
              const foundMaps = output.trim().split('\n').filter(Boolean);

              mapFiles.push(...foundMaps);
            } catch {
              // Continue with other build directories
            }
          }
        }
      }

      for (const mapFile of mapFiles) {
        try {
          const mapContent = readFileSync(mapFile, 'utf-8');
          const map = new TraceMap(mapContent);

          if (map.sources) {
            const matchedSource = map.sources.find(source => {
              if (!source) return false;
              const normalizedSource = source.replace(/^\.\.\//, '').replace(/\\/g, '/');
              const normalizedOriginal = originalSource.replace(/\\/g, '/');

              return normalizedSource.endsWith(normalizedOriginal) ||
                     normalizedOriginal.endsWith(normalizedSource) ||
                     normalizedSource.includes(normalizedOriginal.split('/').pop() ?? '');
            });

            if (matchedSource) {
              // Используем точный column number
              const generatedPosition = generatedPositionFor(map, {
                source: matchedSource,
                line: originalLine,
                column: originalColumn,
                bias: LEAST_UPPER_BOUND
              });

              if (generatedPosition.line !== null && generatedPosition.column !== null) {
                return {
                  content: [{
                    type: "text",
                    text: JSON.stringify({
                      success: true,
                      generatedPosition: {
                        line: generatedPosition.line,
                        column: generatedPosition.column
                      },
                      sourceMapUsed: mapFile,
                      matchedSource
                    })
                  }]
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
            originalSource
          })
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Failed to resolve generated position",
            message: error instanceof Error ? error.message : String(error)
          })
        }]
      };
    }
  }

  async resolveOriginalPosition(generatedLine: number, generatedColumn: number, sourceMapPaths?: string[]) {
    try {
      let mapFiles: string[] = [];

      if (sourceMapPaths) {
        mapFiles = sourceMapPaths.filter(path => existsSync(path));
      } else {
        // Use consistent search strategy as resolveGeneratedPosition
        const searchPaths = new Set<string>();

        // Look in current project build directories
        const buildDirs = ['dist', 'build', 'out', 'lib'];

        for (const buildDir of buildDirs) {
          if (existsSync(buildDir)) {
            searchPaths.add(buildDir);
          }
        }

        // Search for source maps in all identified paths
        for (const searchPath of searchPaths) {
          try {
            const findCmd = process.platform === 'win32'
              ? `dir /s /b "${searchPath}\\*.js.map"`
              : `find "${searchPath}" -name "*.js.map"`;
            const output = execSync(findCmd, { encoding: 'utf-8' });
            const foundMaps = output.trim().split('\n').filter(Boolean);

            mapFiles.push(...foundMaps);
          } catch {
            // Continue with other search paths
          }
        }
      }

      for (const mapFile of mapFiles) {
        try {
          const mapContent = readFileSync(mapFile, 'utf-8');
          const map = new TraceMap(mapContent);

          const originalPosition = originalPositionFor(map, {
            line: generatedLine,
            column: generatedColumn
          });

          if (originalPosition.source && originalPosition.line !== null) {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: true,
                  originalPosition: {
                    source: originalPosition.source,
                    line: originalPosition.line,
                    column: originalPosition.column || 0,
                    name: originalPosition.name
                  },
                  sourceMapUsed: mapFile
                })
              }]
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
            generatedLine,
            generatedColumn
          })
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "Failed to resolve original position",
            message: error instanceof Error ? error.message : String(error)
          })
        }]
      };
    }
  }
}
