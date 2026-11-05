import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: {
    alias: {
      '@puddle/shared/node/platform': fileURLToPath(
        new URL('../shared/src/node/platform.ts', import.meta.url),
      ),
      '@puddle/shared/node/host-control': fileURLToPath(
        new URL('../shared/src/node/host-control.ts', import.meta.url),
      ),
      '@puddle/shared/node': fileURLToPath(
        new URL('../shared/src/node/security.ts', import.meta.url),
      ),
      '@puddle/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'process-e2e',
    include: ['e2e/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 90_000,
    hookTimeout: 60_000,
    // No test may leave a process running (daemon/test/helpers/process-guard.ts).
    globalSetup: ['../daemon/test/helpers/process-guard.global.ts'],
    setupFiles: ['../daemon/test/helpers/process-guard.setup.ts'],
  },
});
