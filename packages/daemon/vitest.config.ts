import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Tests always see shared source — never a stale dist build.
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
  // Generous ceilings on purpose: the e2e suite spawns real PTYs and polls
  // real timers, so under a loaded machine (full-workspace vitest run, 4-core
  // CI runner) tight timeouts starve mid-test. Worst observed cascade: the
  // restart test dying between daemon stop and reassign left every later
  // test fetching a dead port. Slow-but-passing beats fast-but-flaky here —
  // a healthy run never gets near these numbers.
  test: {
    name: 'daemon',
    testTimeout: 60000,
    hookTimeout: 60000,
    // No test may leave a process running (test/helpers/process-guard.ts).
    globalSetup: ['test/helpers/process-guard.global.ts'],
    setupFiles: ['test/helpers/process-guard.setup.ts'],
  },
});
