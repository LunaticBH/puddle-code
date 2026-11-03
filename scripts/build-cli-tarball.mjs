#!/usr/bin/env node
// Package the built cockpit with its own Node; no npm or system Node at runtime.
// Windows gets puddle-cli-v<v>-win32-<arch>.zip with puddle.cmd/pudl.cmd beside
// bin\node.exe; install.sh stays inside, since a Windows CLI still bootstraps
// Linux and macOS hosts with it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveTool, nodeBinary, stageNodeRuntime } from './lib/node-runtime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const pkg = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));
const version = flag('--version') ?? pkg.version;
if (version !== pkg.version) throw new Error('--version must match the built CLI package version');
const windows = process.platform === 'win32';
if (
  !['linux', 'darwin', 'win32'].includes(process.platform) ||
  !['x64', 'arm64'].includes(process.arch)
) {
  throw new Error(`Unsupported CLI platform: ${process.platform}-${process.arch}`);
}
const target = `${process.platform}-${process.arch}`;
const out = resolve(root, flag('--out-dir') ?? 'dist-release');
const name = `puddle-cli-v${version}`;
const stage = join(out, 'stage', name);
const dist = join(root, 'packages/cli/dist');
for (const file of [
  'index.js',
  'pudl.js',
  'host-control.mjs',
  'install.sh',
  'install-cli.sh',
  ...(windows ? ['install-cli.ps1'] : []),
  'public/index.html',
]) {
  if (!existsSync(join(dist, file))) throw new Error(`Missing ${file}; run pnpm build first`);
}
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(dist, join(stage, 'cli'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
writeFileSync(join(stage, 'package.json'), JSON.stringify({ type: 'module' }));
writeFileSync(join(stage, 'VERSION'), `${version}\n`);
// Distinguishes an extracted archive from an npm install, even before installation.
writeFileSync(join(stage, 'STANDALONE'), 'puddle-cli\n');
if (windows) {
  // %~dp0 keeps literal paths out of the batch file (cmd reads it in the OEM code page).
  for (const [launcher, script] of [
    ['puddle', 'index.js'],
    ['pudl', 'pudl.js'],
  ]) {
    writeFileSync(
      join(stage, `${launcher}.cmd`),
      `@"%~dp0bin\\node.exe" "%~dp0cli\\${script}" %*\r\n`,
    );
  }
} else {
  writeFileSync(
    join(stage, 'puddle'),
    '#!/bin/sh\ndir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$dir/bin/node" "$dir/cli/index.js" "$@"\n',
  );
  chmodSync(join(stage, 'puddle'), 0o755);
  writeFileSync(
    join(stage, 'pudl'),
    '#!/bin/sh\ndir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$dir/bin/node" "$dir/cli/pudl.js" "$@"\n',
  );
  chmodSync(join(stage, 'pudl'), 0o755);
}
await stageNodeRuntime(root, stage, target);

// Offline inventory and help never start a daemon. An isolated home and PATH
// prove that the archive needs neither installed npm nor installed Node.
const home = mkdtempSync(join(tmpdir(), 'puddle-cli-smoke-'));
try {
  if (windows) smokeTestWindows(home);
  else {
    const env = { HOME: home, PUDDLE_HOME: join(home, '.puddle'), PATH: '/usr/bin:/bin' };
    const output = execFileSync(join(stage, 'puddle'), ['--version'], { env, encoding: 'utf8' });
    if (!output.includes(version)) throw new Error(`CLI version smoke test failed: ${output}`);
    execFileSync(join(stage, 'puddle'), ['--help'], { env, stdio: 'pipe' });
    execFileSync(join(stage, 'pudl'), ['--help'], { env, stdio: 'pipe' });
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
if (!args.includes('--stage-only')) {
  const file = `${name}-${target}.${windows ? 'zip' : 'tar.gz'}`;
  const archive = join(out, file);
  if (windows) {
    rmSync(archive, { force: true });
    execFileSync(archiveTool(), ['-a', '-c', '-f', archive, '-C', dirname(stage), name]);
  } else {
    execFileSync('tar', ['-czf', archive, '-C', dirname(stage), name], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
  }
  const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(`${archive}.sha256`, `${digest}  ${file}\n`);
  console.log(`CLI archive: ${archive}`);
}

/**
 * Windows runs bin\node.exe directly, as the launchers do. libuv copies the
 * profile variables from the parent when they are missing, so the isolated
 * home is passed explicitly; PATH holds System32 only.
 */
function smokeTestWindows(home) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const env = {
    SystemRoot: systemRoot,
    PATH: join(systemRoot, 'System32'),
    USERPROFILE: home,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PUDDLE_HOME: join(home, '.puddle'),
  };
  const run = (script, argv) =>
    execFileSync(nodeBinary(stage), [join(stage, 'cli', script), ...argv], {
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  const output = run('index.js', ['--version']);
  if (!output.includes(version)) throw new Error(`CLI version smoke test failed: ${output}`);
  run('index.js', ['--help']);
  run('pudl.js', ['--help']);
}
