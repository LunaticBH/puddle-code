import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDaemon, readInstallScript } from '../../src/lib/installation/bootstrap.js';
import type { Transport } from '../../src/lib/transport/transport.js';
import {
  standaloneInstallation,
  removeStandaloneCli,
} from '../../src/lib/installation/standalone-cli.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const installer = join(root, 'scripts/install-cli.sh');
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

describe('standalone CLI installer', () => {
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

it('publishes only the CLI as install.sh and removes obsolete staged installers', () => {
  const f = fixture();
  const output = join(f.temp, 'public');
  mkdirSync(output);
  for (const name of ['install.sh', 'install-cli.sh', 'install-daemon.sh']) {
    writeFileSync(join(output, name), 'obsolete installer');
  }
  writeFileSync(join(output, 'index.html'), 'application');
  execFileSync(process.execPath, [
    join(root, 'scripts/stage-installers.mjs'),
    output,
    'example/puddle',
  ]);
  expect(readdirSync(output).sort()).toEqual(['index.html', 'install.sh']);
  const script = readFileSync(join(output, 'install.sh'), 'utf8');
  expect(script).toBe(readFileSync(installer, 'utf8').replaceAll('@@REPO@@', 'example/puddle'));
  expect(script).not.toContain('@@REPO@@');
  expect(execFileSync('sh', ['-s', '--', '--help'], { input: script, encoding: 'utf8' })).toContain(
    'usage: install.sh',
  );
  expect(readFileSync(join(output, 'index.html'), 'utf8')).toBe('application');
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
