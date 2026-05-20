import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // Cap worker pool tightly -- tests run alongside the user's other work,
    // and saturating CPU has frozen the machine before. Keep this low.
    maxWorkers: '10%',
    isolate: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/index.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
      ],
      // Floors fix the current unit-coverage baseline so a future refactor
      // cannot silently drop it. Per-file overrides protect modules that are
      // already well covered. Raise the global numbers as integration-style
      // logic gets unit tests; integration coverage is uploaded separately via
      // the c8 + NODE_V8_COVERAGE pipeline in .github/workflows/node.js.yml.
      //
      // Numbers below match the actual unit-test baseline minus a 1pp buffer
      // so transient fluctuations (e.g. a small refactor changing a branch
      // count) don't fail CI without a corresponding coverage regression.
      // Last measured: src/utils.ts 93.54L / 100F / 73.68B / 93.93S;
      //                src/tool-state-manager.ts 98.03L / 100F / 91.3B / 98.24S;
      //                src/source-map-resolver.ts 36.06L / 57.14F / 23.27B / 35.29S;
      //                src/logpoint.ts 95.65L / 100F / 100B / 95.65S.
      thresholds: {
        lines: 11,
        functions: 10,
        branches: 11,
        statements: 11,
        'src/utils.ts': { lines: 93, functions: 100, branches: 72, statements: 93 },
        'src/tool-state-manager.ts': { lines: 98, functions: 100, branches: 90, statements: 98 },
        'src/source-map-resolver.ts': { lines: 36, functions: 57, branches: 23, statements: 35 },
        'src/logpoint.ts': { lines: 95, functions: 100, branches: 100, statements: 95 },
      },
    },
  },
});
