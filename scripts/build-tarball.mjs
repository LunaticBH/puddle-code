#!/usr/bin/env node
/**
 * Builds the self-contained puddled release tarball for the CURRENT platform
 * (SPEC §10 "Distribution and bootstrap"). Deliberately no --platform flag:
 * native modules must never be cross-compiled, so each platform's tarball is
 * built on a machine (CI runner) of that platform, where `pnpm install` has
 * just produced correct binaries.
 *
 *   node scripts/build-tarball.mjs [--version X.Y.Z] [--out-dir dist-release] [--stage-only]
 *
 * Tarball tree (~27-34 MB gz; the pinned Node binary is >95% of it):
 *   puddled-v<v>/
 *   ├── puddled            # sh launcher: exec bin/node daemon/puddled.mjs "$@"
 *   ├── VERSION
 *   ├── PROTOCOL           # exact major.minor, readable without executing puddled
 *   ├── CONNECTOR_PROTOCOL # remote protocol, display-only in the component inventory
 *   ├── LICENSE
 *   ├── bin/node           # pinned runtime, nothing else from the Node dist
 *   └── daemon/
 *       ├── puddled.mjs    # esbuild bundle (daemon + shared + hono + ws + zod + yazl)
 *       ├── host-control.mjs # private control relay and host-only legacy inspection
 *       └── node_modules/  # pruned node-pty, better-sqlite3, bindings, file-uri-to-path
 *
 * On Windows the same tree ships as puddled-v<v>-win32-<arch>.zip (docs/windows.md):
 * bin\node.exe, node-pty's win32 prebuilds (conpty and winpty, no .pdb), and
 * puddled.cmd / puddle-connector.cmd for humans. The CLI and desktop start
 * bin\node.exe on daemon\puddled.mjs directly, never through cmd.exe.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { archiveTool, nodeBinary, stageNodeRuntime } from './lib/node-runtime.mjs';
import { smokePuddlang } from './lib/puddlang-smoke.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const version =
  flag('--version') ??
  JSON.parse(readFileSync(join(repoRoot, 'packages/daemon/package.json'), 'utf8')).version;
const protocolSource = readFileSync(join(repoRoot, 'packages/shared/src/protocol.ts'), 'utf8');
const protocolMatch = /PROTOCOL_VERSION\s*=\s*{\s*major:\s*(\d+),\s*minor:\s*(\d+)\s*}/.exec(
  protocolSource,
);
if (protocolMatch === null)
  fail('cannot read PROTOCOL_VERSION from packages/shared/src/protocol.ts');
const protocolVersion = `${protocolMatch[1]}.${protocolMatch[2]}`;
const connectorMatch = /REMOTE_PROTOCOL_VERSION\s*=\s*(\d+)/.exec(
  readFileSync(join(repoRoot, 'packages/shared/src/remote/protocol.ts'), 'utf8'),
);
if (!connectorMatch) fail('cannot read REMOTE_PROTOCOL_VERSION');
const outDir = resolve(repoRoot, flag('--out-dir') ?? 'dist-release');
const stageOnly = args.includes('--stage-only');

const windows = process.platform === 'win32';
const platform = windows ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
if (process.platform !== 'darwin' && process.platform !== 'linux' && !windows) {
  fail(`unsupported build platform ${process.platform}: archives target linux, darwin and win32`);
}
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const target = `${platform}-${arch}`;
const name = `puddled-v${version}-${target}`;
const stage = join(outDir, 'stage', `puddled-v${version}`);

function fail(message) {
  console.error(`build-tarball: ${message}`);
  process.exit(1);
}

function log(message) {
  console.log(`build-tarball: ${message}`);
}

/* 1 — bundle the daemon (+ @puddle/shared from source) into one ESM file. */
async function bundleDaemon() {
  mkdirSync(join(stage, 'daemon'), { recursive: true });
  await build({
    entryPoints: [join(repoRoot, 'packages/daemon/src/index.ts')],
    outfile: join(stage, 'daemon', 'puddled.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Native modules stay external (shipped pruned in daemon/node_modules);
    // ws's optional accelerators must stay unresolved requires it can catch.
    external: ['node-pty', 'better-sqlite3', 'bufferutil', 'utf-8-validate'],
    alias: {
      '@puddle/shared/node/platform': join(repoRoot, 'packages/shared/src/node/platform.ts'),
      '@puddle/shared/node/host-control': join(
        repoRoot,
        'packages/shared/src/node/host-control.ts',
      ),
      '@puddle/shared/node': join(repoRoot, 'packages/shared/src/node/security.ts'),
      '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts'),
    },
    define: { __PUDDLED_VERSION__: JSON.stringify(version) },
    // Bundled CJS deps keep guarded `require(...)` calls (ws's optional
    // natives); in an ESM bundle `require` must exist for them to fail softly.
    banner: {
      js: "import { createRequire as __puddleCreateRequire } from 'node:module';\nconst require = __puddleCreateRequire(import.meta.url);",
    },
    sourcemap: false,
    minify: false,
    logLevel: 'warning',
  });
  log(
    `bundled daemon (${(statSync(join(stage, 'daemon', 'puddled.mjs')).size / 1e6).toFixed(1)} MB)`,
  );
}

/* 2 — copy the two native packages, pruned to their runtime shape. */
function copyNativePackages() {
  const req = createRequire(join(repoRoot, 'packages/daemon/package.json'));
  const dest = join(stage, 'daemon', 'node_modules');

  const pkgRoot = (spec) => dirname(req.resolve(`${spec}/package.json`));

  // node-pty: lib/*.js + package.json + whichever of build/Release (node-gyp,
  // Linux) or prebuilds/<target> (darwin) exists. Loader probes both
  // (lib/utils.js), so this stays correct if Linux prebuilds appear later.
  const pty = pkgRoot('node-pty');
  const ptyDest = join(dest, 'node-pty');
  copyFiltered(join(pty, 'lib'), join(ptyDest, 'lib'), (p) => {
    return !p.endsWith('.js.map') && !p.endsWith('.test.js');
  });
  cpSync(join(pty, 'package.json'), join(ptyDest, 'package.json'));
  const ptyBuild = join(pty, 'build', 'Release');
  const ptyPrebuild = join(pty, 'prebuilds', target);
  if (windows) {
    copyWindowsPty(ptyBuild, ptyPrebuild, ptyDest);
  } else if (existsSync(ptyBuild)) {
    cpSync(ptyBuild, join(ptyDest, 'build', 'Release'), { recursive: true, dereference: true });
  } else if (existsSync(ptyPrebuild)) {
    cpSync(ptyPrebuild, join(ptyDest, 'prebuilds', target), {
      recursive: true,
      dereference: true,
    });
  } else {
    fail(`node-pty has neither build/Release nor prebuilds/${target} — run pnpm install here`);
  }
  // The spawn-helper must stay executable (see scripts/fix-node-pty-perms.mjs).
  for (const dir of [join(ptyDest, 'build', 'Release'), join(ptyDest, 'prebuilds', target)]) {
    const helper = join(dir, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }

  // better-sqlite3: lib + the compiled binding; deps/ (9.8 MB of sqlite
  // source) and src/ are build-time only.
  const bs3 = pkgRoot('better-sqlite3');
  const bs3Dest = join(dest, 'better-sqlite3');
  cpSync(join(bs3, 'lib'), join(bs3Dest, 'lib'), { recursive: true, dereference: true });
  cpSync(join(bs3, 'package.json'), join(bs3Dest, 'package.json'));
  const bs3Node = join(bs3, 'build', 'Release', 'better_sqlite3.node');
  if (!existsSync(bs3Node)) {
    fail('better-sqlite3 has no build/Release/better_sqlite3.node — run pnpm install here');
  }
  mkdirSync(join(bs3Dest, 'build', 'Release'), { recursive: true });
  cpSync(bs3Node, join(bs3Dest, 'build', 'Release', 'better_sqlite3.node'));

  // bindings (better-sqlite3's runtime loader) and its one dependency, whole.
  const bindingsReq = createRequire(join(bs3, 'package.json'));
  for (const small of ['bindings', 'file-uri-to-path']) {
    cpSync(dirname(bindingsReq.resolve(`${small}/package.json`)), join(dest, small), {
      recursive: true,
      dereference: true,
    });
  }
  log('copied pruned native packages');
}

/**
 * node-pty's Windows post-install always leaves build/Release/conpty/ behind,
 * even when the binaries come from prebuilds, so the directory alone proves
 * nothing: look for the module itself. winpty stays for Windows builds that
 * predate conpty support; debug symbols (most of the 30 MB) never ship.
 */
function copyWindowsPty(ptyBuild, ptyPrebuild, ptyDest) {
  const source = existsSync(join(ptyBuild, 'conpty.node'))
    ? [ptyBuild, join(ptyDest, 'build', 'Release')]
    : existsSync(join(ptyPrebuild, 'conpty.node'))
      ? [ptyPrebuild, join(ptyDest, 'prebuilds', target)]
      : fail(`node-pty has no conpty.node in build/Release or prebuilds/${target}`);
  copyFiltered(source[0], source[1], (p) => !p.endsWith('.pdb'));
  if (!existsSync(join(source[1], 'conpty', 'conpty.dll'))) {
    fail('node-pty is missing conpty/conpty.dll — run pnpm install here');
  }
}

function copyFiltered(from, to, keep) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) copyFiltered(src, dst, keep);
    else if (keep(src)) cpSync(src, dst, { dereference: true });
  }
}

/**
 * A batch launcher for humans. cmd.exe reads batch files in the OEM code
 * page, so the file holds no literal path: %~dp0 is the launcher's own
 * directory, resolved by cmd itself.
 */
function writeWindowsLauncher(name, script) {
  writeFileSync(
    join(stage, `${name}.cmd`),
    `@"%~dp0bin\\node.exe" "%~dp0daemon\\${script}" %*\r\n`,
  );
}

/* 4 — launcher, VERSION, PROTOCOL, LICENSE. */
function writeMetadata() {
  if (windows) {
    writeWindowsLauncher('puddled', 'puddled.mjs');
    writeWindowsLauncher('puddle-connector', 'connector.mjs');
  } else {
    writePosixLaunchers();
  }
  writeFileSync(join(stage, 'VERSION'), `${version}\n`);
  // Read directly by `puddle --version`; an offline inventory must never
  // execute an unknown historical daemon just to discover compatibility.
  writeFileSync(join(stage, 'PROTOCOL'), `${protocolVersion}\n`);
  writeFileSync(join(stage, 'CONNECTOR_PROTOCOL'), `${connectorMatch[1]}\n`);
  cpSync(join(repoRoot, 'LICENSE'), join(stage, 'LICENSE'));
}

function writePosixLaunchers() {
  // dirname of ~/.puddle/bin/current/puddled resolves THROUGH the `current`
  // symlink, so bin/node is found without readlink -f. install.sh writes
  // ~/.puddle/bin/puddled as an exec wrapper (never a symlink) for this reason.
  writeFileSync(
    join(stage, 'puddled'),
    '#!/bin/sh\ndir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$dir/bin/node" "$dir/daemon/puddled.mjs" "$@"\n',
  );
  chmodSync(join(stage, 'puddled'), 0o755);
  writeFileSync(
    join(stage, 'puddle-connector'),
    '#!/bin/sh\ndir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$dir/bin/node" "$dir/daemon/connector.mjs" "$@"\n',
  );
  chmodSync(join(stage, 'puddle-connector'), 0o755);
}

/* 5 — smoke test: a broken bundle, missing banner, or wrong-ABI native dies here. */
function smokeTest() {
  if (windows) {
    smokeTestWindows();
    return;
  }
  const out = execFileSync(join(stage, 'puddled'), ['--version'], { encoding: 'utf8' });
  if (!out.startsWith(`puddled ${version} `)) {
    fail(`smoke test failed: unexpected --version output ${JSON.stringify(out)}`);
  }
  const connector = execFileSync(join(stage, 'puddle-connector'), ['--version'], {
    encoding: 'utf8',
  });
  if (!connector.startsWith('puddle-connector ')) fail('connector smoke test failed');
  log(`smoke test passed: ${out.trim()}; ${connector.trim()}`);
}

/**
 * Windows starts bin\node.exe directly, as the supervisor does. node-pty loads
 * conpty lazily (on the first spawn) and `--version` never opens the database,
 * so both native modules are exercised explicitly from the staged tree.
 */
function smokeTestWindows() {
  const node = nodeBinary(stage);
  const run = (script) =>
    execFileSync(node, [join(stage, 'daemon', script), '--version'], { encoding: 'utf8' });
  const out = run('puddled.mjs');
  if (!out.startsWith(`puddled ${version} `)) {
    fail(`smoke test failed: unexpected --version output ${JSON.stringify(out)}`);
  }
  const connector = run('connector.mjs');
  if (!connector.startsWith('puddle-connector ')) fail('connector smoke test failed');
  execFileSync(
    node,
    [
      '-e',
      `const db = new (require('better-sqlite3'))(':memory:');
      if (db.prepare('select 1 as one').get().one !== 1) process.exit(2);
      db.close();
      const term = require('node-pty').spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'exit 7'], {});
      const timer = setTimeout(() => process.exit(3), 20000);
      term.onExit(({ exitCode }) => { clearTimeout(timer); process.exit(exitCode === 7 ? 0 : 4); });`,
    ],
    { cwd: join(stage, 'daemon'), stdio: 'inherit' },
  );
  log(`smoke test passed: ${out.trim()}; ${connector.trim()}; conpty and sqlite load`);
}

/* 6 — tar + checksum. */
function pack() {
  if (windows) {
    packWindows();
    return;
  }
  const tarball = join(outDir, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', join(outDir, 'stage'), `puddled-v${version}`], {
    // Prevents AppleDouble ._* entries in tarballs built on macOS.
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  // sha256sum -c compatible: "<hex>  <filename>".
  writeFileSync(`${tarball}.sha256`, `${digest}  ${name}.tar.gz\n`);
  log(`wrote ${tarball} (${(statSync(tarball).size / 1e6).toFixed(1)} MB)`);
}

/* System32's bsdtar writes a deflated zip from the suffix (-a). */
function packWindows() {
  const zip = join(outDir, `${name}.zip`);
  rmSync(zip, { force: true });
  execFileSync(archiveTool(), [
    '-a',
    '-c',
    '-f',
    zip,
    '-C',
    join(outDir, 'stage'),
    `puddled-v${version}`,
  ]);
  const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
  writeFileSync(`${zip}.sha256`, `${digest}  ${name}.zip\n`);
  log(`wrote ${zip} (${(statSync(zip).size / 1e6).toFixed(1)} MB)`);
}

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
await bundleDaemon();
await build({
  entryPoints: ['runner', 'runtime-api', 'zod'].map((name) =>
    join(repoRoot, `packages/daemon/src/puddlang/${name}.ts`),
  ),
  outdir: join(stage, 'daemon'),
  bundle: true,
  splitting: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  alias: { '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts') },
});
writeFileSync(join(stage, 'daemon/package.json'), JSON.stringify({ type: 'module' }));
await build({
  entryPoints: [join(repoRoot, 'packages/cli/src/host-control.ts')],
  outfile: join(stage, 'daemon/host-control.mjs'),
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
await build({
  entryPoints: [join(repoRoot, 'packages/connector/src/index.ts')],
  outfile: join(stage, 'daemon/connector.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: ['better-sqlite3', 'bufferutil', 'utf-8-validate'],
  alias: {
    '@puddle/shared/node/platform': join(repoRoot, 'packages/shared/src/node/platform.ts'),
    '@puddle/shared/node/host-control': join(repoRoot, 'packages/shared/src/node/host-control.ts'),
    '@puddle/shared/node': join(repoRoot, 'packages/shared/src/node/security.ts'),
    '@puddle/shared': join(repoRoot, 'packages/shared/src/index.ts'),
    '@puddle/remote-transport': join(repoRoot, 'packages/remote-transport/src/index.ts'),
  },
  banner: {
    js: "import { createRequire as __puddleCreateRequire } from 'node:module';\nconst require = __puddleCreateRequire(import.meta.url);",
  },
});
copyNativePackages();
await stageNodeRuntime(repoRoot, stage, target, log);
writeMetadata();
smokeTest();
await smokePuddlang(stage);
log('puddlang runner smoke test passed');
if (!stageOnly) pack();
