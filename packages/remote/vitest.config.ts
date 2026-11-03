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
      '@puddle/remote-transport': fileURLToPath(
        new URL('../remote-transport/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { name: 'remote', include: ['test/**/*.test.ts'], testTimeout: 20000 },
});
