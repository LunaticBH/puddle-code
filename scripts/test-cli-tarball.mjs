#!/usr/bin/env node
// Exercise the real packaged CLI with only required system tools on PATH. No daemons start.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version;
if (process.platform === 'win32') {
  const { testWindowsCliArchive } = await import('./lib/test-cli-tarball-windows.mjs');
  await testWindowsCliArchive(
    root,
    version,
    // install.ps1 takes the OS architecture, which a native Node shares.
    resolve(
      process.argv[2] ??
        join(root, `dist-release/puddle-cli-v${version}-win32-${process.arch}.zip`),
    ),
  );
  process.exit(0);
}
const archive = resolve(
  process.argv[2] ??
    join(root, `dist-release/puddle-cli-v${version}-${process.platform}-${process.arch}.tar.gz`),
);
const temp = mkdtempSync(join(tmpdir(), 'puddle-cli-distribution-'));
const home = join(temp, "home with 'quotes' and spaces");
const bin = join(temp, 'tools');
mkdirSync(home);
mkdirSync(bin);
for (const tool of [
  'sh',
  'uname',
  'id',
  'stat',
  'mkdir',
  'chmod',
  'cat',
  'ls',
  'mktemp',
  'dirname',
  'basename',
  'tar',
  'gzip', // GNU tar invokes gzip through PATH when extracting .tar.gz archives.
  'sed',
  'grep',
  'awk',
  'cut',
  'rm',
  'rmdir',
  'readlink',
  'cp',
  ...(existsSync('/usr/bin/sha256sum') ? ['sha256sum'] : ['shasum']),
]) {
  const source = ['/usr/bin', '/bin'].map((dir) => join(dir, tool)).find(existsSync);
  assert.ok(source, `Missing fixture tool ${tool}`);
  // Invoke the original path: macOS's Perl launcher locates versioned shasum
  // scripts beside it, so relocating shasum through a symlink breaks dispatch.
  // These source paths contain only fixed system directories and tool names.
  writeFileSync(join(bin, tool), `#!/bin/sh\nexec '${source}' "$@"\n`, { mode: 0o755 });
}
// Simulate GitHub responses with the freshly built archive, never the network.
writeFileSync(
  join(bin, 'curl'),
  `#!/bin/sh
out=""
latest=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) latest=1; shift 2 ;;
    *) url="$1"; shift ;;
  esac
done
if [ "$latest" = 1 ]; then printf 'https://github.com/example/puddle/releases/tag/v%s' "$FIXTURE_VERSION"; exit; fi
case "$url" in
  */SHA256SUMS) cp "$FIXTURE_ARCHIVE.sha256" "$out" ;;
  */puddle-cli-v"$FIXTURE_VERSION"-*.tar.gz) cp "$FIXTURE_ARCHIVE" "$out" ;;
  *) exit 22 ;;
esac
`,
  { mode: 0o755 },
);
const env = {
  HOME: home,
  PATH: bin,
  PUDDLE_HOME: join(home, '.puddle'),
  PUDDLE_REPO: 'example/puddle',
  FIXTURE_VERSION: version,
  FIXTURE_ARCHIVE: archive,
};
const installRoot = join(home, '.local/share/puddle/cli');
const launcher = join(home, '.local/bin/puddle');
const run = (file, args, extra = {}) =>
  execFileSync(file, args, { env, encoding: 'utf8', stdio: 'pipe', ...extra });
try {
  assert.equal(existsSync(join(bin, 'node')), false);
  assert.equal(existsSync(join(bin, 'npm')), false);
  // Pipe the installer exactly as curl | sh would, including paths with quotes.
  const publicDir = join(temp, 'public');
  execFileSync(process.execPath, [
    join(root, 'scripts/stage-installers.mjs'),
    publicDir,
    'example/puddle',
  ]);
  const script = readFileSync(join(publicDir, 'install.sh'), 'utf8');
  run(join(bin, 'sh'), ['-s', '--', '--tarball', archive, '--sums', `${archive}.sha256`], {
    input: script,
  });
  assert.match(run(launcher, ['--version']), new RegExp(version.replaceAll('.', '\\.')));
  assert.match(run(launcher, ['--help']), /puddle launch/);
  const before = readlinkSync(join(installRoot, 'current'));
  run(launcher, ['upgrade', `cli@${version}`]);
  const after = readlinkSync(join(installRoot, 'current'));
  assert.notEqual(after, before);
  assert.ok(
    existsSync(join(installRoot, before, 'cli/public/index.html')),
    'keep assets for running cockpits',
  );
  assert.ok(run(join(installRoot, before, 'puddle'), ['--version']).includes(version));
  run(launcher, ['upgrade', 'cli']); // latest-version resolution
  const current = readlinkSync(join(installRoot, 'current'));
  assert.throws(() => run(launcher, ['upgrade', 'cli@999.999.999']));
  assert.equal(readlinkSync(join(installRoot, 'current')), current);
  assert.ok(run(launcher, ['--version']).includes(version));
  mkdirSync(env.PUDDLE_HOME, { recursive: true });
  const data = join(env.PUDDLE_HOME, 'retained-test-data');
  writeFileSync(data, 'retain daemon data');
  run(launcher, ['remove', 'cli', '--yes']);
  assert.equal(existsSync(launcher), false);
  assert.equal(existsSync(installRoot), false);
  assert.equal(readFileSync(data, 'utf8'), 'retain daemon data');
  console.log(
    'Standalone CLI: install, run, pinned/latest upgrade, failed upgrade and removal pass without system Node/npm.',
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
