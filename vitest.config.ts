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
      // No thresholds: with the current single unit-test, any non-zero floor is
      // arbitrary. Re-introduce real values once meaningful unit coverage exists.
    },
  },
});
