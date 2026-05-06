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
      // already well covered (utils, tool-state-manager, source-map-resolver).
      // Raise the global numbers as integration-style logic gets unit tests.
      thresholds: {
        lines: 13,
        functions: 9,
        branches: 13,
        statements: 13,
        'src/utils.ts': { lines: 80, functions: 80, branches: 80, statements: 80 },
        'src/tool-state-manager.ts': { lines: 95, functions: 100, branches: 90, statements: 95 },
        'src/source-map-resolver.ts': { lines: 65, functions: 80, branches: 50, statements: 65 },
      },
    },
  },
});
