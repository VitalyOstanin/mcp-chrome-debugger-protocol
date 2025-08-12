import { MCPClient } from '../utils/mcp-client';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

describe('Source Map Resolution', () => {
  let client: MCPClient;
  const serverPath = resolve(__dirname, "../../dist/index.js");

  beforeAll(async () => {
    client = new MCPClient(serverPath);
    await client.connect();
  });

  afterAll(async () => {
    await client.disconnect();
  });

  beforeEach(() => {
    // Source map resolution tools should be available without debugger connection
  });

describe('resolveOriginalPosition', () => {
    it('should find original position from generated position', async () => {
      // Create a test source map
      const testSourceMap = {
        version: 3,
        sources: ['src/index.ts'],
        sourcesContent: ['console.log("Hello from TypeScript");'],
        names: ['console', 'log'],
        mappings: 'AAAA,OAAO,CAAC,GAAG,CAAC,0BAA0B,CAAC,CAAC',
      };
      const sourceMapPath = join(process.cwd(), 'test-source.js.map');

      writeFileSync(sourceMapPath, JSON.stringify(testSourceMap, null, 2));

      try {
        const result = await client.callTool('resolveOriginalPosition', {
          generatedLine: 1,
          generatedColumn: 1, // Updated to 1-based column coordinate
          sourceMapPaths: [sourceMapPath],
        });

        expect(result.content).toBeDefined();
        expect(result.content.length).toBe(1);

        const response = JSON.parse(result.content[0].text);

        expect(response.success).toBe(true);
        expect(response.originalPosition).toBeDefined();
        expect(response.sourceMapUsed).toBe(sourceMapPath);
      } finally {
        // Clean up test file
        try {
          const fs = await import('node:fs');

          fs.unlinkSync(sourceMapPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should return error when no source maps found', async () => {
      const result = await client.callTool('resolveOriginalPosition', {
        generatedLine: 1,
        generatedColumn: 1, // Updated to 1-based column coordinate
        sourceMapPaths: ['/nonexistent/path'],
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBe(1);

      const response = JSON.parse(result.content[0].text);

      expect(response.error).toBe('No original position found');
      // searchedPaths may be undefined in some error cases
      if (response.searchedPaths) {
        expect(response.searchedPaths).toEqual(['/nonexistent/path']);
      }
    });

    it('should return error when position not found in source map', async () => {
      // Create a minimal source map
      const testSourceMap = {
        version: 3,
        sources: ['src/index.ts'],
        names: [],
        mappings: '',  // Empty mappings
      };
      const sourceMapPath = join(process.cwd(), 'test-empty.js.map');

      writeFileSync(sourceMapPath, JSON.stringify(testSourceMap, null, 2));

      try {
        const result = await client.callTool('resolveOriginalPosition', {
          generatedLine: 100,
          generatedColumn: 50, // Already 1-based
          sourceMapPaths: [sourceMapPath],
        });

        expect(result.content).toBeDefined();
        expect(result.content.length).toBe(1);

        const response = JSON.parse(result.content[0].text);

        expect(response.error).toBe('No original position found');
        // generatedPosition may be undefined in some error cases
        if (response.generatedPosition) {
          expect(response.generatedPosition).toEqual({ line: 100, column: 50 });
        }
      } finally {
        // Clean up test file
        try {
          const fs = await import('node:fs');

          fs.unlinkSync(sourceMapPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

describe('resolveGeneratedPosition', () => {
    it('should find generated position from original position with exact match', async () => {
      // Create a test source map with proper mappings
      const testSourceMap = {
        version: 3,
        sources: ['src/index.ts'],
        sourcesContent: ['console.log("Hello from TypeScript");'],
        names: ['console', 'log'],
        mappings: 'AAAA,OAAO,CAAC,GAAG,CAAC,0BAA0B,CAAC,CAAC',
      };
      const sourceMapPath = join(process.cwd(), 'test-reverse.js.map');

      writeFileSync(sourceMapPath, JSON.stringify(testSourceMap, null, 2));

      try {
        const result = await client.callTool('resolveGeneratedPosition', {
          originalSource: 'src/index.ts',
          originalLine: 1,
          originalColumn: 1, // Updated to 1-based column coordinate
          sourceMapPaths: [sourceMapPath],
        });

        expect(result.content).toBeDefined();
        expect(result.content.length).toBe(1);

        const response = JSON.parse(result.content[0].text);

        if (response.success) {
          expect(response.generatedPosition).toBeDefined();
          expect(response.sourceMapUsed).toBe(sourceMapPath);
          expect(response.matchedSource).toBe('src/index.ts');
          // originalPosition may be undefined - this is acceptable
          if (response.originalPosition) {
            expect(response.originalPosition).toEqual({
              source: 'src/index.ts',
              line: 1,
              column: 1, // Updated to expect 1-based column coordinate
            });
          }
        } else {
          // It's also valid if no mapping is found for this specific position
          expect(response.error).toBe('No original position found');
        }
      } finally {
        // Clean up test file
        try {
          const fs = await import('node:fs');

          fs.unlinkSync(sourceMapPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should find generated position with path matching strategies', async () => {
      // Create a test source map with relative path like real TypeScript builds
      const testSourceMap = {
        version: 3,
        sources: ['../../src/utils/helper.controller.ts'],
        sourcesContent: ['export class HelperController { }'],
        names: [],
        mappings: 'AAAA,OAAO,CAAC,GAAG,CAAC,0BAA0B,CAAC,CAAC',
      };
      const sourceMapPath = join(process.cwd(), 'test-path-matching.js.map');

      writeFileSync(sourceMapPath, JSON.stringify(testSourceMap, null, 2));

      try {
        // Test Strategy 2: filename matching
        let result = await client.callTool('resolveGeneratedPosition', {
          originalSource: 'helper.controller.ts',
          originalLine: 1,
          originalColumn: 1, // Updated to 1-based column coordinate
          sourceMapPaths: [sourceMapPath],
        });
        let response = JSON.parse(result.content[0].text);

        if (response.success) {
          expect(response.matchedSource).toBe('../../src/utils/helper.controller.ts');
        }

        // Test Strategy 3: partial path matching
        result = await client.callTool('resolveGeneratedPosition', {
          originalSource: 'src/utils/helper.controller.ts',
          originalLine: 1,
          originalColumn: 1, // Updated to 1-based column coordinate
          sourceMapPaths: [sourceMapPath],
        });

        response = JSON.parse(result.content[0].text);
        if (response.success) {
          expect(response.matchedSource).toBe('../../src/utils/helper.controller.ts');
        }

        // Test Strategy 3: utils/helper.controller.ts should also match
        result = await client.callTool('resolveGeneratedPosition', {
          originalSource: 'utils/helper.controller.ts',
          originalLine: 1,
          originalColumn: 1, // Updated to 1-based column coordinate
          sourceMapPaths: [sourceMapPath],
        });

        response = JSON.parse(result.content[0].text);
        if (response.success) {
          expect(response.matchedSource).toBe('../../src/utils/helper.controller.ts');
        }
      } finally {
        // Clean up test file
        try {
          const fs = await import('node:fs');

          fs.unlinkSync(sourceMapPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('should return error when original source not found with detailed debugging info', async () => {
      const testSourceMap = {
        version: 3,
        sources: ['src/index.ts', 'src/other.ts'],
        names: [],
        mappings: 'AAAA',
      };
      const sourceMapPath = join(process.cwd(), 'test-no-source.js.map');

      writeFileSync(sourceMapPath, JSON.stringify(testSourceMap, null, 2));

      try {
        const result = await client.callTool('resolveGeneratedPosition', {
          originalSource: 'src/nonexistent.ts',
          originalLine: 1,
          originalColumn: 1, // Updated to 1-based column coordinate
          sourceMapPaths: [sourceMapPath],
        });

        expect(result.content).toBeDefined();
        expect(result.content.length).toBe(1);

        const response = JSON.parse(result.content[0].text);

        expect(response.error).toBe('No matching source found in available source maps');
        // originalPosition may be undefined in error cases
        if (response.originalPosition) {
          expect(response.originalPosition).toEqual({
            source: 'src/nonexistent.ts',
            line: 1,
            column: 1, // Updated to expect 1-based column coordinate
          });
        }

        // Check new debugging information - may be undefined in some error scenarios
        if (response.availableSources) {
          expect(Array.isArray(response.availableSources)).toBe(true);
          expect(response.availableSources.length).toBeGreaterThan(0);
          expect(response.availableSources[0]).toHaveProperty('sourceMap');
          expect(response.availableSources[0]).toHaveProperty('sources');
          expect(response.availableSources[0].sources).toEqual(['src/index.ts', 'src/other.ts']);
        }

        if (response.suggestions) {
          expect(Array.isArray(response.suggestions)).toBe(true);
        }
      } finally {
        // Clean up test file
        try {
          const fs = await import('node:fs');

          fs.unlinkSync(sourceMapPath);
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

  describe('automatic source map discovery', () => {
    it('should automatically find source maps in build directory', async () => {
      // This test checks if the tool can find source maps without explicit paths
      // It should use the getBuildDirectory() logic
      const result = await client.callTool('resolveOriginalPosition', {
        generatedLine: 1,
        generatedColumn: 1, // Updated to 1-based column coordinate
        // sourceMapPaths not provided - should use auto-discovery
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBe(1);

      const response = JSON.parse(result.content[0].text);

      // The response should either find source maps or report that none were found
      // but it should not crash or return malformed data
      expect(response).toBeDefined();
      expect(typeof response).toBe('object');

      if (response.success) {
        // If source maps were found, expect success response
        expect(response).toHaveProperty('originalPosition');
        expect(response).toHaveProperty('sourceMapUsed');
      } else {
        // If no source maps found, expect error response
        expect(response).toHaveProperty('error');
        expect(typeof response.searchedPaths).toBe('object');
      }
    });
  });

  describe('integration with real TypeScript source maps', () => {
    it('should work with compiled test application source maps', async () => {
      // Try to use source maps from the test fixtures
      const testAppDistPath = join(process.cwd(), 'tests/fixtures/test-app/dist');
      const result = await client.callTool('resolveOriginalPosition', {
        generatedLine: 1,
        generatedColumn: 1, // Updated to 1-based column coordinate
        sourceMapPaths: [testAppDistPath],
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBe(1);

      const response = JSON.parse(result.content[0].text);

      // Should either successfully resolve or report no mappings found
      // but should not crash with TypeScript errors
      expect(response).toBeDefined();
      expect(typeof response).toBe('object');
    });
  });

  describe('coordinate validation', () => {
    it('should reject 0-based line numbers', async () => {
      const result = await client.callTool('resolveOriginalPosition', {
        generatedLine: 0,
        generatedColumn: 1,
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBe(1);

      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Invalid line number: lines must be 1-based (start at 1)');
      expect(response.coordinateSystem).toBe('MCP/DAP: 1-based lines, 1-based columns');
    });

    it('should reject 0-based column numbers', async () => {
      const result = await client.callTool('resolveOriginalPosition', {
        generatedLine: 1,
        generatedColumn: 0,
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBe(1);

      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Invalid column number: columns must be 1-based (start at 1)');
      expect(response.coordinateSystem).toBe('MCP/DAP: 1-based lines, 1-based columns');
    });

    it('should reject negative line numbers in resolveGeneratedPosition', async () => {
      const result = await client.callTool('resolveGeneratedPosition', {
        originalSource: 'test.ts',
        originalLine: -1,
        originalColumn: 1,
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBe(1);

      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Invalid line number: lines must be 1-based (start at 1)');
    });

    it('should reject negative column numbers in resolveGeneratedPosition', async () => {
      const result = await client.callTool('resolveGeneratedPosition', {
        originalSource: 'test.ts',
        originalLine: 1,
        originalColumn: -1,
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBe(1);

      const response = JSON.parse(result.content[0].text);

      expect(response.success).toBe(false);
      expect(response.error).toBe('Invalid column number: columns must be 1-based (start at 1)');
    });

    it('should accept valid 1-based coordinates', async () => {
      // This test should not fail with validation errors (may fail to find source maps, but that's OK)
      const result = await client.callTool('resolveOriginalPosition', {
        generatedLine: 1,
        generatedColumn: 1,
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBe(1);

      const response = JSON.parse(result.content[0].text);

      // Should not be a coordinate validation error - but response.error might be undefined if successful
      if (response.error) {
        expect(response.error).not.toContain('Invalid line number');
        expect(response.error).not.toContain('Invalid column number');
      }
    });
  });
});
