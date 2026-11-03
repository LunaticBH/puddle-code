#!/usr/bin/env node
/**
 * Builds the publishable CLI: one esbuild bundle (ws and @puddle/shared
 * inlined, so the published package has zero runtime dependencies), the
 * canonical install.sh beside it, and the built web UI under dist/public —
 * `npm i -g @puddle-code/cli` ships the whole cockpit (SPEC §2: UI updates
 * ride the CLI, hosts only update when the protocol breaks).
 */
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const version = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version;

// Fresh dist every build: `files: ["dist"]` publishes the whole directory,
// so leftovers from older builds would ship (v0.0.1 carried stray tsc
// artefacts from the pre-Phase-6 stub for exactly this reason).
rmSync(join(pkgRoot, 'dist'), { recursive: true, force: true });

// Baked at release time from the publishing repository (release.yml exports
// PUDDLE_REPO_SLUG); absent in dev builds, where PUDDLE_REPO takes over.
const slug = process.env.PUDDLE_REPO_SLUG;

await build({
  entryPoints: { index: join(pkgRoot, 'src/index.ts'), pudl: join(pkgRoot, 'src/pudl.ts') },
  outdir: join(pkgRoot, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['bufferutil', 'utf-8-validate'], // ws's optional accelerators
  alias: {
    '@puddle/shared/node/platform': join(repoRoot, 'packages/shared/src/node/platform.ts'),
    '@puddle/shared/node/host-control': join(repoRoot, 'packages/shared/src/node/host-control.ts'),
    '@puddle/shared/node': join(repoRoot, 'packages/shared/src/node/security.ts'),
    '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts'),
  },
  define: {
    __PUDDLE_CLI_VERSION__: JSON.stringify(version),
    ...(slug ? { __PUDDLE_REPO_SLUG__: JSON.stringify(slug) } : {}),
  },
  banner: {
    js: "import { createRequire as __puddleCreateRequire } from 'node:module';\nconst require = __puddleCreateRequire(import.meta.url);",
  },
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
});

cpSync(join(repoRoot, 'scripts/install.sh'), join(pkgRoot, 'dist/install.sh'));
cpSync(join(repoRoot, 'scripts/install-cli.sh'), join(pkgRoot, 'dist/install-cli.sh'));

// npm only renders a README living in the package directory, and shows no
// changelog at all — so surface both by copying them in at build time (both
// are git-ignored here; `files` publishes them). The changelog is the durable
// per-version archive, not the rolling root file (which is reset to an empty
// template on publish). Non-fatal when the archive isn't cut yet (dev builds).
cpSync(join(repoRoot, 'README.md'), join(pkgRoot, 'README.md'));
const versionChangelog = join(repoRoot, `docs/changelogs/CHANGELOG-v${version}.md`);
if (existsSync(versionChangelog)) {
  cpSync(versionChangelog, join(pkgRoot, 'CHANGELOG.md'));
} else {
  rmSync(join(pkgRoot, 'CHANGELOG.md'), { force: true });
  console.warn(`cli build: no ${versionChangelog} yet — publishing without CHANGELOG.md`);
}

const webDist = join(repoRoot, 'packages/web/dist');
if (!existsSync(join(webDist, 'index.html'))) {
  console.error('cli build: packages/web/dist is missing — build the web package first');
  process.exit(1);
}
cpSync(webDist, join(pkgRoot, 'dist/public'), { recursive: true });
console.log(
  `cli build: dist/index.js + install.sh + public/ (v${version}${slug ? `, repo ${slug}` : ''})`,
);

await build({
  entryPoints: [join(pkgRoot, 'src/host-control.ts')],
  outfile: join(pkgRoot, 'dist/host-control.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  alias: {
    '@puddle/shared/node/platform': join(repoRoot, 'packages/shared/src/node/platform.ts'),
    '@puddle/shared/node/host-control': join(repoRoot, 'packages/shared/src/node/host-control.ts'),
    '@puddle/shared/node': join(repoRoot, 'packages/shared/src/node/security.ts'),
    '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts'),
  },
});
