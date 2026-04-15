/**
 * Tier 3 e2e runner config.
 *
 * Runs the Docker-backed end-to-end tests under test/e2e/. Requires
 * Docker Desktop (or an equivalent Docker daemon) to be running on the
 * host. Image builds are cached via the Docker engine's own layer cache.
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    // Building an image + booting systemd + probing SSH all take real
    // wall-clock time; bump the global timeout generously.
    testTimeout: 120_000,
    hookTimeout: 360_000,
    // Sequential: each test spins up a container bound to a host port;
    // parallelism would tangle ports and amplify flakiness.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    sequence: { concurrent: false },
  },
})
