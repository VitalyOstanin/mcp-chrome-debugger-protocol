import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    globalSetup: ['./tests/globalSetup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Integration tests spawn real Node.js inspector debuggee processes and bind
    // to network ports; running suites in parallel risks port collisions and
    // cross-suite debuggee state leaking between tests. Force serial execution.
    fileParallelism: false,
    maxWorkers: 1,
    isolate: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'coverage-integration',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', '**/*.test.ts', '**/*.spec.ts'],
    },
  },
});
