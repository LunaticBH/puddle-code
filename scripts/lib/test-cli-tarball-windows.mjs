// Windows half of scripts/test-cli-tarball.mjs: install.ps1, the batch
// launchers, junction upgrades and deferred self-removal, with only System32
// and Windows PowerShell on PATH. Invoke-WebRequest cannot be shimmed through
// PATH, so a loopback server plays GitHub (PUDDLE_RELEASE_ORIGIN).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const system32 = join(systemRoot, 'System32');
const powershell = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export async function testWindowsCliArchive(root, version, archive) {
  const file = basename(archive);
  const sums = readFileSync(`${archive}.sha256`, 'utf8');
  assert.equal(
    sums.split(/\s+/)[0],
    createHash('sha256').update(readFileSync(archive)).digest('hex'),
  );
  const server = createServer((request, response) => {
    const base = '/example/puddle/releases';
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === `${base}/latest`) {
      response.writeHead(302, { location: `https://github.com${base}/tag/v${version}` });
      response.end();
    } else if (path === `${base}/download/v${version}/SHA256SUMS`) {
      response.end(sums);
    } else if (path === `${base}/download/v${version}/${file}`) {
      response.end(readFileSync(archive));
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const temp = mkdtempSync(join(tmpdir(), 'puddle-cli-distribution-'));
  const home = join(temp, "home with 'quotes' and spaces");
  const local = join(home, 'AppData', 'Local');
  mkdirSync(local, { recursive: true });
  mkdirSync(join(temp, 'tmp'));
  // Disposable CI runners exercise the user PATH edit; elsewhere it stays untouched.
  const editPath = process.env.CI !== undefined;
  const env = {
    SystemRoot: systemRoot,
    ComSpec: join(system32, 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: `${system32};${join(system32, 'WindowsPowerShell', 'v1.0')}`,
    USERPROFILE: home,
    HOME: home,
    LOCALAPPDATA: local,
    APPDATA: join(home, 'AppData', 'Roaming'),
    TEMP: join(temp, 'tmp'),
    TMP: join(temp, 'tmp'),
    PUDDLE_HOME: join(home, '.puddle'),
    PUDDLE_REPO: 'example/puddle',
    PUDDLE_RELEASE_ORIGIN: `http://127.0.0.1:${server.address().port}`,
  };
  const installRoot = join(local, 'puddle', 'cli');
  const binDir = join(local, 'puddle', 'bin');
  const launcher = join(binDir, 'puddle.cmd');
  const exec = async (command, args) =>
    (await run(command, args, { env, encoding: 'utf8' })).stdout;
  // cmd.exe /s strips the outer quotes, leaving the quoted launcher path intact.
  const puddle = (args, at = launcher) =>
    run(env.ComSpec, ['/d', '/s', '/c', `""${at}" ${args.join(' ')}"`], {
      env,
      encoding: 'utf8',
      windowsVerbatimArguments: true,
    }).then((result) => result.stdout);
  const userPath = async () =>
    exec(powershell, [
      '-NoProfile',
      '-Command',
      "[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
    ]);
  try {
    await assert.rejects(exec(join(system32, 'where.exe'), ['node']));
    const publicDir = join(temp, 'public');
    await run(process.execPath, [
      join(root, 'scripts/stage-installers.mjs'),
      publicDir,
      'example/puddle',
    ]);
    await exec(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(publicDir, 'install.ps1'),
      '-Archive',
      archive,
      '-Sums',
      `${archive}.sha256`,
      ...(editPath ? [] : ['-NoPathUpdate']),
    ]);
    if (editPath) assert.ok((await userPath()).toLowerCase().includes(binDir.toLowerCase()));
    assert.match(await puddle(['--version']), new RegExp(version.replaceAll('.', '\\.')));
    assert.match(await puddle(['--help']), /puddle launch/);
    const before = readlinkSync(join(installRoot, 'current'));
    await puddle(['upgrade', `cli@${version}`]);
    const after = readlinkSync(join(installRoot, 'current'));
    assert.notEqual(after, before);
    assert.ok(
      existsSync(join(before, 'cli', 'public', 'index.html')),
      'keep assets for running cockpits',
    );
    assert.ok((await puddle(['--version'], join(before, 'puddle.cmd'))).includes(version));
    await puddle(['upgrade', 'cli']); // latest-version resolution
    const current = readlinkSync(join(installRoot, 'current'));
    await assert.rejects(puddle(['upgrade', 'cli@999.999.999']));
    assert.equal(readlinkSync(join(installRoot, 'current')), current);
    assert.ok((await puddle(['--version'])).includes(version));
    mkdirSync(env.PUDDLE_HOME, { recursive: true });
    const data = join(env.PUDDLE_HOME, 'retained-test-data');
    writeFileSync(data, 'retain daemon data');
    await puddle(['remove', 'cli', '--yes']);
    assert.equal(existsSync(launcher), false);
    // The running node.exe lives in the tree, so a hidden helper removes it on exit.
    for (let i = 0; i < 150 && existsSync(installRoot); i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(existsSync(installRoot), false);
    assert.equal(readFileSync(data, 'utf8'), 'retain daemon data');
    if (editPath) assert.ok(!(await userPath()).toLowerCase().includes(binDir.toLowerCase()));
    console.log(
      'Standalone CLI (Windows): install.ps1, launchers, pinned/latest upgrade, failed upgrade and removal pass without system Node/npm.',
    );
  } finally {
    server.close();
    rmSync(temp, { recursive: true, force: true });
  }
}
