import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'src/poc/**'],
    // Longer timeout for conformance tests which manipulate real SQLite files
    testTimeout: 10_000,
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
