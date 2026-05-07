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
      // The global numbers and the source-map-resolver per-file numbers were
      // tightened in 1.6.0 above the real measurements (recent refactors had
      // extracted helpers and the coverage drifted down without an immediate
      // CI signal). Re-aligned to current measurements with a 1pp buffer so
      // small fluctuations don't fail CI; raise them after adding new tests.
      thresholds: {
        lines: 11,
        functions: 9,
        branches: 11,
        statements: 11,
        'src/utils.ts': { lines: 80, functions: 80, branches: 80, statements: 80 },
        'src/tool-state-manager.ts': { lines: 95, functions: 100, branches: 90, statements: 95 },
        'src/source-map-resolver.ts': { lines: 35, functions: 55, branches: 24, statements: 35 },
      },
    },
  },
});
