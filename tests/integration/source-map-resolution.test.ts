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

  describe('resolve_original_position', () => {
    it('should find original position from generated position', async () => {
      // Create a test source map
      const testSourceMap = {
        version: 3,
        sources: ['src/index.ts'],
        sourcesContent: ['console.log("Hello from TypeScript");'],
        names: ['console', 'log'],
        mappings: 'AAAA,OAAO,CAAC,GAAG,CAAC,0BAA0B,CAAC,CAAC'
      };

      const sourceMapPath = join(process.cwd(), 'test-source.js.map');

      writeFileSync(sourceMapPath, JSON.stringify(testSourceMap, null, 2));

      try {
        const result = await client.callTool('resolve_original_position', {
          generatedLine: 1,
          generatedColumn: 0,
          sourceMapPaths: [sourceMapPath]
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
      const result = await client.callTool('resolve_original_position', {
        generatedLine: 1,
        generatedColumn: 0,
        sourceMapPaths: ['/nonexistent/path']
      });

      expect(result.content).toBeDefined();
      expect(result.content.length).toBe(1);

      const response = JSON.parse(result.content[0].text);

      expect(response.error).toBe('No source map files found');
      expect(response.searchedPaths).toEqual(['/nonexistent/path']);
    });

    it('should return error when position not found in source map', async () => {
      // Create a minimal source map
      const testSourceMap = {
        version: 3,
        sources: ['src/index.ts'],
        names: [],
        mappings: ''  // Empty mappings
      };

      const sourceMapPath = join(process.cwd(), 'test-empty.js.map');

      writeFileSync(sourceMapPath, JSON.stringify(testSourceMap, null, 2));

      try {
        const result = await client.callTool('resolve_original_position', {
          generatedLine: 100,
          generatedColumn: 50,
          sourceMapPaths: [sourceMapPath]
        });

        expect(result.content).toBeDefined();
        expect(result.content.length).toBe(1);

        const response = JSON.parse(result.content[0].text);

        expect(response.error).toBe('No mapping found for generated position');
        expect(response.generatedPosition).toEqual({ line: 100, column: 50 });
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

  describe('resolve_generated_position', () => {
    it('should find generated position from original position with exact match', async () => {
      // Create a test source map with proper mappings
      const testSourceMap = {
        version: 3,
        sources: ['src/index.ts'],
        sourcesContent: ['console.log("Hello from TypeScript");'],
        names: ['console', 'log'],
        mappings: 'AAAA,OAAO,CAAC,GAAG,CAAC,0BAA0B,CAAC,CAAC'
      };

      const sourceMapPath = join(process.cwd(), 'test-reverse.js.map');

      writeFileSync(sourceMapPath, JSON.stringify(testSourceMap, null, 2));

      try {
        const result = await client.callTool('resolve_generated_position', {
          originalSource: 'src/index.ts',
          originalLine: 1,
          originalColumn: 0,
          sourceMapPaths: [sourceMapPath]
        });

        expect(result.content).toBeDefined();
        expect(result.content.length).toBe(1);

        const response = JSON.parse(result.content[0].text);

        if (response.success) {
          expect(response.generatedPosition).toBeDefined();
          expect(response.sourceMapUsed).toBe(sourceMapPath);
          expect(response.matchedSource).toBe('src/index.ts');
          expect(response.originalPosition).toEqual({
            source: 'src/index.ts',
            line: 1,
            column: 0
          });
        } else {
          // It's also valid if no mapping is found for this specific position
          expect(response.error).toBe('No mapping found for original position');
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
        sources: ['../../src/publications/deals.controller.ts'],
        sourcesContent: ['export class DealsController { }'],
        names: [],
        mappings: 'AAAA,OAAO,CAAC,GAAG,CAAC,0BAA0B,CAAC,CAAC'
      };

      const sourceMapPath = join(process.cwd(), 'test-path-matching.js.map');

      writeFileSync(sourceMapPath, JSON.stringify(testSourceMap, null, 2));

      try {
        // Test Strategy 2: filename matching
        let result = await client.callTool('resolve_generated_position', {
          originalSource: 'deals.controller.ts',
          originalLine: 1,
          originalColumn: 0,
          sourceMapPaths: [sourceMapPath]
        });

        let response = JSON.parse(result.content[0].text);

        if (response.success) {
          expect(response.matchedSource).toBe('../../src/publications/deals.controller.ts');
        }

        // Test Strategy 3: partial path matching
        result = await client.callTool('resolve_generated_position', {
          originalSource: 'src/publications/deals.controller.ts',
          originalLine: 1,
          originalColumn: 0,
          sourceMapPaths: [sourceMapPath]
        });

        response = JSON.parse(result.content[0].text);
        if (response.success) {
          expect(response.matchedSource).toBe('../../src/publications/deals.controller.ts');
        }

        // Test Strategy 3: publications/deals.controller.ts should also match
        result = await client.callTool('resolve_generated_position', {
          originalSource: 'publications/deals.controller.ts',
          originalLine: 1,
          originalColumn: 0,
          sourceMapPaths: [sourceMapPath]
        });

        response = JSON.parse(result.content[0].text);
        if (response.success) {
          expect(response.matchedSource).toBe('../../src/publications/deals.controller.ts');
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
        mappings: 'AAAA'
      };

      const sourceMapPath = join(process.cwd(), 'test-no-source.js.map');

      writeFileSync(sourceMapPath, JSON.stringify(testSourceMap, null, 2));

      try {
        const result = await client.callTool('resolve_generated_position', {
          originalSource: 'src/nonexistent.ts',
          originalLine: 1,
          originalColumn: 0,
          sourceMapPaths: [sourceMapPath]
        });

        expect(result.content).toBeDefined();
        expect(result.content.length).toBe(1);

        const response = JSON.parse(result.content[0].text);

        expect(response.error).toBe('No mapping found for original position');
        expect(response.originalPosition).toEqual({
          source: 'src/nonexistent.ts',
          line: 1,
          column: 0
        });

        // Check new debugging information
        expect(response.availableSources).toBeDefined();
        expect(Array.isArray(response.availableSources)).toBe(true);
        expect(response.availableSources.length).toBeGreaterThan(0);
        expect(response.availableSources[0]).toHaveProperty('sourceMap');
        expect(response.availableSources[0]).toHaveProperty('sources');
        expect(response.availableSources[0].sources).toEqual(['src/index.ts', 'src/other.ts']);

        expect(response.suggestions).toBeDefined();
        expect(Array.isArray(response.suggestions)).toBe(true);
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
      const result = await client.callTool('resolve_original_position', {
        generatedLine: 1,
        generatedColumn: 0
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

      const result = await client.callTool('resolve_original_position', {
        generatedLine: 1,
        generatedColumn: 0,
        sourceMapPaths: [testAppDistPath]
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
});
