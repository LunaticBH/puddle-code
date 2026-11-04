import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { windowsHostArch } from '@puddle/shared/node/platform';
import { installDaemon, readInstallScript } from '../../src/lib/installation/bootstrap.js';
import type { Transport } from '../../src/lib/transport/transport.js';
import {
  standaloneInstallation,
  removeStandaloneCli,
  TREE_CLEANUP_COMMAND,
  treeCleanupArgs,
  windowsStandaloneLauncher,
  windowsUpgradeCommand,
} from '../../src/lib/installation/standalone-cli.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const installer = join(root, 'scripts/install-cli.sh');
const powershellInstaller = join(root, 'scripts/install-cli.ps1');
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const windowsPowerShell = join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const psFlags = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const temps: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'puddle-cli-installer-'));
  temps.push(temp);
  const home = join(temp, 'home');
  const prefix = join(home, '.local/share/puddle/cli');
  const launcher = join(home, '.local/bin/puddle');
  const stage = join(temp, 'stage/puddle-cli-v1.2.3');
  const tarball = join(temp, `puddle-cli-v1.2.3-${process.platform}-${process.arch}.tar.gz`);
  mkdirSync(home);
  mkdirSync(join(stage, 'cli/public'), { recursive: true });
  mkdirSync(join(stage, 'bin'));
  symlinkSync(process.execPath, join(stage, 'bin/node'));
  writeFileSync(join(stage, 'puddle'), '#!/bin/sh\nprintf "fixture CLI help\\n"\n', {
    mode: 0o755,
  });
  writeFileSync(join(stage, 'STANDALONE'), 'puddle-cli\n');
  writeFileSync(join(stage, 'VERSION'), '1.2.3\n');
  for (const file of [
    'index.js',
    'host-control.mjs',
    'public/index.html',
    'install.sh',
    'install-cli.sh',
  ])
    writeFileSync(join(stage, 'cli', file), 'fixture');
  const pack = () => {
    execFileSync('tar', ['-czf', tarball, '-C', join(temp, 'stage'), 'puddle-cli-v1.2.3']);
    const hash = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    writeFileSync(`${tarball}.sha256`, `${hash}  ${tarball.split('/').pop()}\n`);
  };
  pack();
  const install = (args: string[] = []) =>
    execFileSync('sh', [installer, '--tarball', tarball, '--sums', `${tarball}.sha256`, ...args], {
      env: { HOME: home, PATH: process.env.PATH },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  return { temp, home, prefix, launcher, stage, tarball, pack, install };
}

// install-cli.sh is the POSIX installer (symlinks, modes, sh); install-cli.ps1
// has its own suite below.
describe.skipIf(process.platform === 'win32')('standalone CLI installer', () => {
  it('migrates owned puddlang launchers to pudl and permits older archive removal', async () => {
    const f = fixture();
    const legacy = join(f.home, '.local/bin/puddlang');
    const current = join(f.home, '.local/bin/pudl');
    const command = '#!/bin/sh\nexit 0\n';
    writeFileSync(join(f.stage, 'puddlang'), command, { mode: 0o755 });
    f.pack();
    f.install();
    expect(existsSync(legacy)).toBe(true);

    rmSync(join(f.stage, 'puddlang'));
    writeFileSync(join(f.stage, 'pudl'), command, { mode: 0o755 });
    f.pack();
    f.install();
    expect(existsSync(legacy)).toBe(false);
    expect(execFileSync(current, ['--help']).length).toBe(0);
    expect(
      JSON.parse(readFileSync(join(f.prefix, 'installation.json'), 'utf8')).scriptLauncher,
    ).toBe(realpathSync(current));

    // An unrelated executable with the former name must survive reinstalls.
    writeFileSync(legacy, 'unrelated command');
    f.install();
    expect(readFileSync(legacy, 'utf8')).toBe('unrelated command');
    rmSync(legacy);

    rmSync(join(f.stage, 'pudl'));
    writeFileSync(join(f.stage, 'puddlang'), command, { mode: 0o755 });
    f.pack();
    f.install();
    expect(existsSync(current)).toBe(false);
    await removeStandaloneCli({
      root: realpathSync(f.prefix),
      release: realpathSync(join(f.prefix, 'current')),
      launcher: f.launcher,
      scriptLauncher: legacy,
    });
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(f.launcher)).toBe(false);
  });

  it('installs, upgrades and removes both owned launchers; supports older archives', async () => {
    const f = fixture();
    const script = join(f.home, '.local/bin/pudl');
    f.install();
    writeFileSync(join(f.stage, 'pudl'), '#!/bin/sh\nprintf "fixture pudl help\\n"\n', {
      mode: 0o755,
    });
    f.pack();
    f.install();
    expect(execFileSync(script, ['--help'], { encoding: 'utf8' })).toContain('fixture pudl');
    rmSync(join(f.stage, 'pudl'));
    f.pack();
    f.install();
    expect(existsSync(script)).toBe(false);
    writeFileSync(join(f.stage, 'pudl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    f.pack();
    f.install();
    const installation = {
      root: realpathSync(f.prefix),
      release: join(f.prefix, readlinkSync(join(f.prefix, 'current'))),
      launcher: f.launcher,
      scriptLauncher: script,
    };
    writeFileSync(script, 'replacement');
    await expect(removeStandaloneCli(installation)).rejects.toThrow('pudl launcher was replaced');
    expect(existsSync(f.launcher)).toBe(true);
    rmSync(script);
    f.install();
    await removeStandaloneCli(installation);
    expect(existsSync(f.launcher)).toBe(false);
    expect(existsSync(script)).toBe(false);
  });

  it('does not overwrite an unrelated pudl command', () => {
    const f = fixture();
    f.install();
    const previous = readlinkSync(join(f.prefix, 'current'));
    writeFileSync(join(f.stage, 'pudl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    f.pack();
    const script = join(f.home, '.local/bin/pudl');
    writeFileSync(script, 'unrelated');
    expect(() => f.install()).toThrow('unrelated launcher');
    expect(readFileSync(script, 'utf8')).toBe('unrelated');
    expect(readlinkSync(join(f.prefix, 'current'))).toBe(previous);
  });
  it('retains immutable trees on reinstall and migrates owned legacy permissions', () => {
    const f = fixture();
    f.install();
    const previous = readlinkSync(join(f.prefix, 'current'));
    chmodSync(f.prefix, 0o755);
    f.install();
    expect(statSync(f.prefix).mode & 0o777).toBe(0o700);
    expect(readlinkSync(join(f.prefix, 'current'))).not.toBe(previous);
    expect(existsSync(join(f.prefix, previous, 'cli/public/index.html'))).toBe(true);
    expect(execFileSync(f.launcher, ['--help'], { encoding: 'utf8' })).toContain('fixture CLI');
  });

  it('rejects checksum failures before replacing a working installation', () => {
    const f = fixture();
    f.install();
    const previous = readlinkSync(join(f.prefix, 'current'));
    writeFileSync(`${f.tarball}.sha256`, `${'0'.repeat(64)}  ${f.tarball.split('/').pop()}\n`);
    expect(() => f.install()).toThrow('checksum mismatch');
    expect(readlinkSync(join(f.prefix, 'current'))).toBe(previous);
    expect(existsSync(join(f.prefix, '.install-lock'))).toBe(false);
  });

  it('rejects a missing checksum entry and incomplete or broken archives', () => {
    const f = fixture();
    f.install();
    const previous = readlinkSync(join(f.prefix, 'current'));
    writeFileSync(`${f.tarball}.sha256`, '');
    expect(() => f.install()).toThrow('missing or ambiguous checksum');
    writeFileSync(join(f.stage, 'puddle'), '#!/bin/sh\nexit 1\n');
    f.pack();
    expect(() => f.install()).toThrow('CLI smoke test failed');
    rmSync(join(f.stage, 'cli/public/index.html'));
    f.pack();
    expect(() => f.install()).toThrow('archive is missing');
    expect(readlinkSync(join(f.prefix, 'current'))).toBe(previous);
  });

  it('refuses an unrelated launcher, including a symlink, without overwriting it', () => {
    const f = fixture();
    mkdirSync(join(f.home, '.local/bin'), { recursive: true });
    writeFileSync(f.launcher, 'another installation');
    expect(() => f.install()).toThrow('Refusing to replace an unrelated launcher');
    expect(readFileSync(f.launcher, 'utf8')).toBe('another installation');
    rmSync(f.launcher);
    symlinkSync(join(f.stage, 'puddle'), f.launcher);
    expect(() => f.install()).toThrow('Refusing to replace an unrelated launcher');
    expect(readlinkSync(f.launcher)).toBe(join(f.stage, 'puddle'));
    expect(existsSync(join(f.prefix, 'current'))).toBe(false);
  });

  it('refuses unmanaged, symlinked or writable-by-others installation roots', () => {
    const f = fixture();
    writeFileSync(join(f.home, 'keep'), 'keep');
    expect(() => f.install(['--prefix', f.home])).toThrow('non-empty unmanaged');
    const alias = join(f.temp, 'alias');
    symlinkSync(f.home, alias);
    expect(() => f.install(['--prefix', alias])).toThrow('must not be a symlink');
    expect(() => f.install(['--prefix', `${alias}/`])).toThrow('must not be a symlink');
    chmodSync(f.home, 0o777);
    expect(() => f.install(['--prefix', f.home])).toThrow('not writable by others');
    expect(readFileSync(join(f.home, 'keep'), 'utf8')).toBe('keep');
  });

  it('rejects invalid versions and overlapping operations', () => {
    const f = fixture();
    expect(() => f.install(['--version', '../../outside'])).toThrow('invalid release version');
    f.install();
    mkdirSync(join(f.prefix, '.install-lock'));
    expect(() => f.install()).toThrow('another installer is running');
    expect(existsSync(join(f.prefix, '.install-lock'))).toBe(true);
  });

  it('does not treat an unmanaged standalone archive as an npm installation', () => {
    const f = fixture();
    expect(() => standaloneInstallation(join(f.stage, 'cli/index.js'))).toThrow(
      'not an installer-managed',
    );
    expect(standaloneInstallation(fileURLToPath(import.meta.url))).toBeNull();
  });
});

it('publishes only the CLI installers and removes obsolete staged installers', () => {
  const temp = mkdtempSync(join(tmpdir(), 'puddle-cli-installers-'));
  temps.push(temp);
  const output = join(temp, 'public');
  mkdirSync(output);
  for (const name of ['install.sh', 'install-cli.sh', 'install-daemon.sh', 'install-cli.ps1']) {
    writeFileSync(join(output, name), 'obsolete installer');
  }
  writeFileSync(join(output, 'index.html'), 'application');
  execFileSync(process.execPath, [
    join(root, 'scripts/stage-installers.mjs'),
    output,
    'example/puddle',
  ]);
  expect(readdirSync(output).sort()).toEqual(['index.html', 'install.ps1', 'install.sh']);
  const script = readFileSync(join(output, 'install.sh'), 'utf8');
  expect(script).toBe(readFileSync(installer, 'utf8').replaceAll('@@REPO@@', 'example/puddle'));
  expect(script).not.toContain('@@REPO@@');
  const powershell = readFileSync(join(output, 'install.ps1'), 'utf8');
  expect(powershell).toBe(
    readFileSync(join(root, 'scripts/install-cli.ps1'), 'utf8').replaceAll(
      '@@REPO@@',
      'example/puddle',
    ),
  );
  expect(powershell).not.toContain('@@REPO@@');
  expect(readFileSync(join(output, 'index.html'), 'utf8')).toBe('application');
  if (process.platform === 'win32') {
    expect(
      execFileSync(windowsPowerShell, [...psFlags, '-File', join(output, 'install.ps1'), '-Help'], {
        encoding: 'utf8',
      }),
    ).toContain('usage: install.ps1');
  } else {
    expect(
      execFileSync('sh', ['-s', '--', '--help'], { input: script, encoding: 'utf8' }),
    ).toContain('usage: install.sh');
  }
});

it('keeps the Windows installer ASCII for Windows PowerShell 5.1', () => {
  // 5.1 reads a script without a byte order mark in the ANSI code page.
  const script = readFileSync(join(root, 'scripts/install-cli.ps1'), 'utf8');
  expect([...script].filter((c) => c !== '\n' && (c < ' ' || c > '~'))).toEqual([]);
});

it('pipes the embedded daemon bootstrap over SSH with the GitHub release source', async () => {
  vi.stubEnv('PUDDLE_REPO', 'example/puddle');
  const transport: Transport = {
    kind: 'ssh',
    label: 'user@host',
    exec: vi.fn<Transport['exec']>().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
    readFile: vi.fn<Transport['readFile']>(),
    copyTo: vi.fn<Transport['copyTo']>(),
    dispose: vi.fn(),
  };
  await installDaemon(transport, { version: '1.2.3' });
  expect(transport.exec).toHaveBeenCalledWith(
    "sh -s -- '--version' '1.2.3' '--repo' 'example/puddle'",
    expect.objectContaining({ stdin: readInstallScript() }),
  );
  expect(readInstallScript()).toContain('https://github.com/$REPO/releases/download/v$VERSION');
  expect(readInstallScript()).toContain('puddled-v$VERSION-$OS-$ARCH.tar.gz');
});

describe('Windows standalone launchers (any OS)', () => {
  it('reaches a sibling root through %~dp0 so no literal profile path enters the batch file', () => {
    expect(
      windowsStandaloneLauncher(
        'C:\\Users\\Zoë\\AppData\\Local\\puddle\\cli',
        'C:\\Users\\Zoë\\AppData\\Local\\puddle\\bin',
      ),
    ).toBe(
      '@rem puddle standalone launcher\r\n' +
        '@(goto) 2>nul & "%~dp0..\\cli\\current\\bin\\node.exe" "%~dp0..\\cli\\current\\cli\\index.js" %*\r\n',
    );
    expect(windowsStandaloneLauncher('C:\\p\\cli', 'C:\\p\\bin', 'pudl')).toContain(
      '"%~dp0..\\cli\\current\\cli\\pudl.js" %*\r\n',
    );
  });

  it('waits a second between self-removal retries, not only once the tree is gone', () => {
    // cmd.exe runs everything after an unbracketed `if` as its body.
    expect(TREE_CLEANUP_COMMAND).toContain(
      '& (if not exist "%PUDDLE_CLEANUP_ROOT%" exit /b 0) & ping -n 2 127.0.0.1 >nul)',
    );
    expect(treeCleanupArgs()).toEqual(['/d', '/s', '/c', `"${TREE_CLEANUP_COMMAND}"`]);
  });

  it('falls back to the absolute root across drives', () => {
    expect(windowsStandaloneLauncher('D:\\tools\\puddle', 'C:\\bin')).toBe(
      '@rem puddle standalone launcher\r\n' +
        '@(goto) 2>nul & "D:\\tools\\puddle\\current\\bin\\node.exe" "D:\\tools\\puddle\\current\\cli\\index.js" %*\r\n',
    );
  });

  it('upgrades through the release installer with Windows PowerShell, never touching PATH', () => {
    const installation = {
      root: 'C:\\Users\\a\\AppData\\Local\\puddle\\cli',
      release: 'C:\\Users\\a\\AppData\\Local\\puddle\\cli\\versions\\1.2.3.abc',
      launcher: 'C:\\Users\\a\\AppData\\Local\\puddle\\bin\\puddle.cmd',
    };
    expect(
      windowsUpgradeCommand(installation, '1.2.4', 'example/puddle', { SystemRoot: 'C:\\Win' }),
    ).toEqual({
      file: 'C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        win32.join(installation.release, 'cli', 'install-cli.ps1'),
        '-Prefix',
        installation.root,
        '-BinDir',
        'C:\\Users\\a\\AppData\\Local\\puddle\\bin',
        '-NoPathUpdate',
        '-Version',
        '1.2.4',
        '-Repo',
        'example/puddle',
      ],
    });
  });
});

// Every run passes -NoPathUpdate: the default edits the real HKCU PATH, which
// scripts/test-cli-tarball.mjs exercises on disposable CI runners only.
describe.runIf(process.platform === 'win32')('Windows standalone CLI installer', () => {
  // install.ps1 takes the operating system's architecture, and the fixture's
  // node.exe is this process's: tests need a native Node (not x64 on Arm).
  let hostArch = 'x64';
  let otherArch = 'arm64';
  beforeAll(async () => {
    hostArch = await windowsHostArch();
    otherArch = hostArch === 'x64' ? 'arm64' : 'x64';
  });

  /** `profile` names the user's home folder; the archive sits beside it. */
  function windowsFixture(profile = 'home', name = `puddle-cli-v1.2.3-win32-${hostArch}.zip`) {
    const temp = mkdtempSync(join(tmpdir(), 'puddle-ps-installer-'));
    temps.push(temp);
    const home = join(temp, profile);
    const localAppData = join(home, 'AppData', 'Local');
    const prefix = join(localAppData, 'puddle', 'cli');
    const bin = join(localAppData, 'puddle', 'bin');
    const launcher = join(bin, 'puddle.cmd');
    const stage = join(temp, 'stage', 'puddle-cli-v1.2.3');
    const packed = join(temp, name);
    const archive = profile === 'home' ? packed : join(home, name);
    mkdirSync(localAppData, { recursive: true });
    mkdirSync(join(stage, 'cli', 'public'), { recursive: true });
    mkdirSync(join(stage, 'bin'));
    try {
      linkSync(process.execPath, join(stage, 'bin', 'node.exe')); // no privilege, no 80 MB copy
    } catch {
      copyFileSync(process.execPath, join(stage, 'bin', 'node.exe'));
    }
    writeFileSync(join(stage, 'cli', 'index.js'), "console.log('fixture CLI help');\n");
    writeFileSync(join(stage, 'puddle.cmd'), '@"%~dp0bin\\node.exe" "%~dp0cli\\index.js" %*\r\n');
    writeFileSync(join(stage, 'STANDALONE'), 'puddle-cli\n');
    writeFileSync(join(stage, 'VERSION'), '1.2.3\n');
    for (const file of [
      'host-control.mjs',
      'public/index.html',
      'install.sh',
      'install-cli.sh',
      'install-cli.ps1',
    ])
      writeFileSync(join(stage, 'cli', file), 'fixture');
    const pack = () => {
      rmSync(packed, { force: true });
      // Stored, not deflated: the fixture carries a whole node.exe.
      execFileSync(join(systemRoot, 'System32', 'tar.exe'), [
        '-a',
        '--options',
        'zip:compression=store',
        '-c',
        '-f',
        packed,
        '-C',
        join(temp, 'stage'),
        'puddle-cli-v1.2.3',
      ]);
      if (archive !== packed) copyFileSync(packed, archive);
      const hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
      writeFileSync(`${archive}.sha256`, `${hash}  ${name}\n`);
    };
    pack();
    const install = (args: string[] = [], powershell = windowsPowerShell) =>
      execFileSync(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          powershellInstaller,
          '-Archive',
          archive,
          '-Sums',
          `${archive}.sha256`,
          '-NoPathUpdate',
          ...args,
        ],
        { env: { ...process.env, LOCALAPPDATA: localAppData }, encoding: 'utf8', stdio: 'pipe' },
      );
    const current = () => readlinkSync(join(prefix, 'current'));
    return { temp, home, prefix, bin, launcher, stage, archive, pack, install, current };
  }

  const runLauncher = (launcher: string, args: string[]) =>
    execFileSync(
      join(systemRoot, 'System32', 'cmd.exe'),
      ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`],
      {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      },
    );

  it('installs into %LOCALAPPDATA%, keeps immutable trees on reinstall and removes cleanly', async () => {
    const f = windowsFixture();
    f.install();
    const prefix = realpathSync(f.prefix);
    expect(readFileSync(f.launcher, 'utf8')).toBe(
      windowsStandaloneLauncher(prefix, realpathSync(f.bin)),
    );
    expect(readFileSync(f.launcher, 'utf8')).toContain('%~dp0..\\cli\\current\\bin\\node.exe');
    expect(runLauncher(f.launcher, ['--help'])).toContain('fixture CLI help');
    expect(JSON.parse(readFileSync(join(prefix, 'installation.json'), 'utf8'))).toEqual({
      kind: 'puddle-cli',
      launcher: join(realpathSync(f.bin), 'puddle.cmd'),
    });
    const previous = f.current();
    expect(readdirSync(join(prefix, 'versions'))).toHaveLength(1);

    f.install();
    expect(f.current()).not.toBe(previous);
    expect(existsSync(join(previous, 'cli', 'public', 'index.html'))).toBe(true);
    expect(existsSync(join(prefix, '.install-lock'))).toBe(false);

    const release = realpathSync(join(prefix, 'current'));
    const installation = standaloneInstallation(
      join(release, 'cli', 'index.js'),
      join(release, 'bin', 'node.exe'),
      'win32',
    );
    expect(installation).toEqual({
      root: prefix,
      release,
      launcher: join(realpathSync(f.bin), 'puddle.cmd'),
    });
    // The launcher starts node.exe through the `current` junction, and
    // process.execPath keeps that unresolved spelling (Node resolves only the
    // entry script), so the junction must resolve to the same release.
    expect(
      standaloneInstallation(
        join(release, 'cli', 'index.js'),
        join(prefix, 'current', 'bin', 'node.exe'),
        'win32',
      ),
    ).toEqual(installation);
    await removeStandaloneCli(installation!, 'win32');
    expect(existsSync(f.launcher)).toBe(false);
    expect(existsSync(f.prefix)).toBe(false);
  });

  it('owns pudl.cmd only while releases ship it and never overwrites an unrelated one', async () => {
    const f = windowsFixture();
    const script = join(f.bin, 'pudl.cmd');
    writeFileSync(join(f.stage, 'pudl.cmd'), '@exit /b 0\r\n');
    writeFileSync(join(f.stage, 'cli', 'pudl.js'), "console.log('fixture pudl help');\n");
    f.pack();
    f.install();
    expect(runLauncher(script, ['--help'])).toContain('fixture pudl help');

    rmSync(join(f.stage, 'pudl.cmd'));
    f.pack();
    f.install();
    expect(existsSync(script)).toBe(false);

    writeFileSync(script, 'unrelated');
    writeFileSync(join(f.stage, 'pudl.cmd'), '@exit /b 0\r\n');
    f.pack();
    const previous = f.current();
    expect(() => f.install()).toThrow('unrelated launcher');
    expect(readFileSync(script, 'utf8')).toBe('unrelated');
    expect(f.current()).toBe(previous);

    rmSync(script);
    f.install();
    const release = realpathSync(join(f.prefix, 'current'));
    const installation = standaloneInstallation(
      join(release, 'cli', 'index.js'),
      join(release, 'bin', 'node.exe'),
      'win32',
    )!;
    expect(installation.scriptLauncher).toBe(join(realpathSync(f.bin), 'pudl.cmd'));
    writeFileSync(script, 'replacement');
    await expect(removeStandaloneCli(installation, 'win32')).rejects.toThrow(
      'pudl launcher was replaced',
    );
    expect(existsSync(f.launcher)).toBe(true);
  });

  it('rejects checksum failures and broken archives before replacing a working installation', () => {
    const f = windowsFixture();
    f.install();
    const previous = f.current();
    writeFileSync(
      `${f.archive}.sha256`,
      `${'0'.repeat(64)}  puddle-cli-v1.2.3-win32-${hostArch}.zip\n`,
    );
    expect(() => f.install()).toThrow('checksum mismatch');
    writeFileSync(`${f.archive}.sha256`, '');
    expect(() => f.install()).toThrow('missing or ambiguous checksum');
    writeFileSync(join(f.stage, 'cli', 'index.js'), 'process.exit(1);\n');
    f.pack();
    expect(() => f.install()).toThrow('CLI smoke test failed');
    rmSync(join(f.stage, 'cli', 'public', 'index.html'));
    f.pack();
    expect(() => f.install()).toThrow('archive is missing');
    expect(f.current()).toBe(previous);
    expect(existsSync(join(f.prefix, '.install-lock'))).toBe(false);
    expect(readdirSync(join(f.prefix, 'versions'))).toHaveLength(1);
  });

  it('refuses an archive named for another architecture', () => {
    const f = windowsFixture('home', `puddle-cli-v1.2.3-win32-${otherArch}.zip`);
    expect(() => f.install()).toThrow(
      `this archive is the win32-${otherArch} build; this machine needs win32-${hostArch}`,
    );
    expect(() => f.install(['-Version', '1.2.3'])).toThrow(`this machine needs win32-${hostArch}`);
    expect(existsSync(join(f.prefix, 'current'))).toBe(false);
  });

  it('refuses an archive whose node.exe is another architecture', () => {
    const f = windowsFixture();
    const node = join(f.stage, 'bin', 'node.exe');
    // Unlink first: the fixture's node.exe is a hard link to the running one.
    rmSync(node);
    const image = Buffer.alloc(0x200);
    image.write('MZ', 0, 'latin1');
    image.writeUInt32LE(0x80, 0x3c);
    image.write('PE\0\0', 0x80, 'latin1');
    image.writeUInt16LE(otherArch === 'arm64' ? 0xaa64 : 0x8664, 0x84);
    writeFileSync(node, image);
    f.pack();
    expect(() => f.install()).toThrow(
      `archive is not the win32-${hostArch} build (its node.exe is ${otherArch})`,
    );
    writeFileSync(node, 'not a PE image');
    f.pack();
    expect(() => f.install()).toThrow(`(its node.exe is not a PE image)`);
    expect(existsSync(join(f.prefix, 'current'))).toBe(false);
    expect(readdirSync(join(f.prefix, 'versions'))).toEqual([]);
  });

  it('takes the operating system architecture from a 32-bit Windows PowerShell', () => {
    // WOW64 gives this process PROCESSOR_ARCHITECTURE=x86; the registry still
    // names the machine. The emulation-proof check that x64 runners can make.
    const wow64 = join(systemRoot, 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (!existsSync(wow64)) return;
    const f = windowsFixture();
    f.install([], wow64);
    expect(runLauncher(f.launcher, ['--help'])).toContain('fixture CLI help');
  });

  it('refuses an unrelated launcher without overwriting it', () => {
    const f = windowsFixture();
    mkdirSync(f.bin, { recursive: true });
    writeFileSync(f.launcher, 'another installation');
    expect(() => f.install()).toThrow('Refusing to replace an unrelated launcher');
    expect(readFileSync(f.launcher, 'utf8')).toBe('another installation');
    expect(existsSync(join(f.prefix, 'current'))).toBe(false);
  });

  it('refuses unmanaged, junction or writable-by-others installation roots', () => {
    const f = windowsFixture();
    const unmanaged = join(f.home, 'unmanaged');
    mkdirSync(unmanaged);
    writeFileSync(join(unmanaged, 'keep'), 'keep');
    expect(() => f.install(['-Prefix', unmanaged])).toThrow('non-empty unmanaged');
    const alias = join(f.temp, 'alias');
    symlinkSync(f.home, alias, 'junction');
    expect(() => f.install(['-Prefix', alias])).toThrow('must not be a symlink or junction');
    expect(() => f.install(['-Prefix', `${alias}\\`])).toThrow('must not be a symlink or junction');
    const shared = join(f.home, 'shared');
    mkdirSync(shared);
    execFileSync(join(systemRoot, 'System32', 'icacls.exe'), [
      shared,
      '/grant',
      '*S-1-1-0:(OI)(CI)M',
    ]);
    expect(() => f.install(['-Prefix', shared])).toThrow('not writable by others');
    expect(readFileSync(join(unmanaged, 'keep'), 'utf8')).toBe('keep');
  });

  it('rejects invalid versions, relative paths and overlapping operations', () => {
    const f = windowsFixture();
    expect(() => f.install(['-Version', '..\\..\\outside'])).toThrow('invalid release version');
    expect(() => f.install(['-Prefix', 'relative\\cli'])).toThrow(
      '-Prefix must be an absolute path',
    );
    f.install();
    mkdirSync(join(f.prefix, '.install-lock'));
    expect(() => f.install()).toThrow('another installer is running');
    expect(existsSync(join(f.prefix, '.install-lock'))).toBe(true);
  });

  it('does not treat an unmanaged standalone archive as an installation', () => {
    const f = windowsFixture();
    expect(() =>
      standaloneInstallation(join(f.stage, 'cli', 'index.js'), process.execPath, 'win32'),
    ).toThrow(expect.objectContaining({ hint: expect.stringContaining('install.ps1') }));
  });

  it('installs under a profile whose name the ANSI code page cannot hold', async () => {
    // CJK and Cyrillic: neither fits cp1252, so tar.exe would read `?` for them.
    const f = windowsFixture('测试 Иван');
    f.install();
    expect(runLauncher(f.launcher, ['--help'])).toContain('fixture CLI help');
    expect(
      readdirSync(realpathSync(f.prefix)).filter((name) => name.startsWith('.download.')),
    ).toEqual([]);
    const release = realpathSync(join(f.prefix, 'current'));
    const installation = standaloneInstallation(
      join(release, 'cli', 'index.js'),
      join(release, 'bin', 'node.exe'),
      'win32',
    );
    await removeStandaloneCli(installation!, 'win32');
    expect(existsSync(f.prefix)).toBe(false);
  });

  it('keeps retrying a self-removal until the exiting process releases the tree', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'puddle-ps-cleanup-'));
    temps.push(temp);
    const tree = join(temp, 'cli');
    const held = join(tree, 'versions', '1.2.3', 'bin');
    mkdirSync(held, { recursive: true });
    writeFileSync(join(tree, 'INSTALLATION'), 'puddle-cli\n');
    // A working directory cannot be removed: the stand-in for the exiting node.exe.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], {
      cwd: held,
      stdio: 'ignore',
      windowsHide: true,
    });
    await new Promise((resolve) => holder.once('spawn', resolve));
    const started = Date.now();
    const cleanup = spawn(join(systemRoot, 'System32', 'cmd.exe'), treeCleanupArgs(), {
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env, PUDDLE_CLEANUP_ROOT: tree },
    });
    const code = await new Promise((resolve) => cleanup.once('exit', resolve));
    expect(code).toBe(0);
    expect(existsSync(tree)).toBe(false);
    expect(Date.now() - started).toBeGreaterThan(1500);
  }, 30_000);
});
