import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      // In dev, resolve the sibling workspace package to its TS source
      // so tests don't require a prior `npm run build` of the dep.
      // Published consumers import from dist per the package's exports.
      'groundflare-estimate': fileURLToPath(
        new URL('../estimate/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // e2e tests run under a dedicated config (vitest.config.e2e.ts) with
    // Docker requirements + long timeouts; they are NOT part of the
    // default suite.
    // test/bun/** runs under `bun test` (see package.json "test:bun"):
    // those files import from "bun:sqlite" and use the bun:test API, which
    // vitest can't execute. Keep them out of the default vitest sweep.
    exclude: [
      'node_modules/**',
      'dist/**',
      'src/poc/**',
      'test/e2e/**',
      'test/bun/**',
    ],
    // Longer timeout for conformance tests which manipulate real SQLite files;
    // integration tests set per-test 30s timeouts where they spawn workerd.
    testTimeout: 10_000,
    // Run integration tests sequentially — spawning multiple workerd
    // processes in parallel is fine but log output interleaves badly.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/poc/**',
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/cli/index.ts',
      ],
      thresholds: {
        lines: 80,
        branches: 75,
        functions: 80,
        statements: 80,
      },
    },
  },
})
