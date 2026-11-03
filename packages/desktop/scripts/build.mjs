#!/usr/bin/env node
/**
 * Builds the desktop shell, mirroring the CLI's build exactly: the main
 * process bundles the SAME `packages/cli/src/lib` sources (aliased, ws
 * inlined), install.sh lands beside the bundle (readInstallScript finds it
 * there; Electron's fs patch reads it fine from inside app.asar), and the
 * built web UI is copied under dist/public — one codebase, two downstream
 * builds (SPEC §10).
 */
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '..', '..');
// The lib reports the CLI's version in handshakes; bake the same number.
const cliVersion = JSON.parse(
  readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'),
).version;
const slug = process.env.PUDDLE_REPO_SLUG;

rmSync(join(pkgRoot, 'dist'), { recursive: true, force: true });

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  alias: {
    '@puddle-code/cli/lib': join(repoRoot, 'packages/cli/src/lib/index.ts'),
    '@puddle/shared/node/platform': join(repoRoot, 'packages/shared/src/node/platform.ts'),
    '@puddle/shared/node/host-control': join(repoRoot, 'packages/shared/src/node/host-control.ts'),
    '@puddle/shared/node': join(repoRoot, 'packages/shared/src/node/security.ts'),
    '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts'),
  },
  define: {
    __PUDDLE_CLI_VERSION__: JSON.stringify(cliVersion),
    ...(slug ? { __PUDDLE_REPO_SLUG__: JSON.stringify(slug) } : {}),
  },
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
};

await build({
  ...shared,
  entryPoints: [join(pkgRoot, 'src/main.ts')],
  outfile: join(pkgRoot, 'dist/main.js'),
  format: 'esm',
  banner: {
    js: "import { createRequire as __puddleCreateRequire } from 'node:module';\nconst require = __puddleCreateRequire(import.meta.url);",
  },
});

// Preload scripts run sandboxed and must be CommonJS.
await build({
  ...shared,
  entryPoints: [
    join(pkgRoot, 'src/preload.ts'),
    join(pkgRoot, 'src/prompt-preload.ts'),
    join(pkgRoot, 'src/picker-preload.ts'),
    join(pkgRoot, 'src/auth-preload.ts'),
    join(pkgRoot, 'src/askpass-helper.ts'),
  ],
  outdir: join(pkgRoot, 'dist'),
  outExtension: { '.js': '.cjs' },
  format: 'cjs',
});

cpSync(join(pkgRoot, 'src/connect-prompt.html'), join(pkgRoot, 'dist/connect-prompt.html'));
cpSync(join(pkgRoot, 'src/host-picker.html'), join(pkgRoot, 'dist/host-picker.html'));
cpSync(join(pkgRoot, 'src/ssh-auth-prompt.html'), join(pkgRoot, 'dist/ssh-auth-prompt.html'));
cpSync(join(repoRoot, 'scripts/install.sh'), join(pkgRoot, 'dist/install.sh'));

const webDist = join(repoRoot, 'packages/web/dist');
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('desktop build: packages/web/dist is missing — run the web build first');
  process.exit(1);
}
cpSync(webDist, join(pkgRoot, 'dist/public'), { recursive: true });

console.log(
  `desktop build: dist/main.js + preloads + shell prompts + install.sh + public/ (cli v${cliVersion})`,
);

cpSync(
  join(repoRoot, 'packages/cli/dist/host-control.mjs'),
  join(pkgRoot, 'dist/host-control.mjs'),
);
