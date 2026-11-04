import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { system32Path } from '@puddle/shared/node/platform';
import { waitForStartedDaemon } from '../../src/lib/connection/cockpit.js';
import { readCurrentVersion } from '../../src/lib/installation/current-link.js';
import {
  controlPipePresent,
  stopWindowsDaemon,
} from '../../src/lib/installation/windows-daemon.js';
import {
  installWindowsDaemon,
  pruneCache,
  versionFromArchiveName,
  windowsLauncher,
} from '../../src/lib/installation/windows-install.js';
import { LocalTransport } from '../../src/lib/transport/local.js';

describe('Windows daemon release assets', () => {
  it('downloads the release zip and its SHA256SUMS by their release names', async () => {
    const home = join(mkdtempSync(join(tmpdir(), 'puddle-windows-download-')), '.puddle');
    const requested: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      requested.push(String(url));
      return String(url).endsWith('/SHA256SUMS')
        ? new Response(`${'0'.repeat(64)}  puddled-v1.2.3-win32-x64.zip\n`)
        : new Response('not the published zip');
    }) as typeof fetch;
    const savedRepo = process.env.PUDDLE_REPO;
    process.env.PUDDLE_REPO = 'acme/puddle';
    try {
      // The checksum refuses the download before anything is unpacked or started.
      await expect(installWindowsDaemon({ home, version: '1.2.3', fetchFn })).rejects.toThrow(
        'checksum mismatch',
      );
    } finally {
      if (savedRepo === undefined) delete process.env.PUDDLE_REPO;
      else process.env.PUDDLE_REPO = savedRepo;
    }
    expect(requested).toEqual([
      'https://github.com/acme/puddle/releases/download/v1.2.3/puddled-v1.2.3-win32-x64.zip',
      'https://github.com/acme/puddle/releases/download/v1.2.3/SHA256SUMS',
    ]);
    expect(existsSync(join(home, 'cache', 'puddled-v1.2.3-win32-x64.zip'))).toBe(false);
    expect(existsSync(join(home, 'bin', 'versions', '1.2.3'))).toBe(false);
  });

  it('derives the version from a Windows archive name, whichever separator its path uses', () => {
    expect(versionFromArchiveName('C:\\dl\\puddled-v0.3.14-win32-x64.zip')).toBe('0.3.14');
    expect(versionFromArchiveName('C:/dl/puddled-v0.3.14-win32-x64.zip')).toBe('0.3.14');
    expect(versionFromArchiveName('puddled-v1.0.0-rc.1-win32-x64.zip')).toBeUndefined();
    expect(versionFromArchiveName('puddled-v0.3.14-linux-x64.tar.gz')).toBeUndefined();
    expect(versionFromArchiveName('daemon.zip')).toBeUndefined();
  });

  it('writes a launcher for people that runs the current runtime', () => {
    expect(windowsLauncher()).toBe(
      '@"%~dp0current\\bin\\node.exe" "%~dp0current\\daemon\\puddled.mjs" %*\r\n',
    );
  });

  it('keeps the current download and one previous', () => {
    const cache = mkdtempSync(join(tmpdir(), 'puddle-windows-cache-'));
    const names = ['1.0.0', '1.1.0', '1.2.0'].map((v) => `puddled-v${v}-win32-x64.zip`);
    names.forEach((name, index) => {
      writeFileSync(join(cache, name), '');
      utimesSync(join(cache, name), index + 1, index + 1);
    });
    writeFileSync(join(cache, 'SHA256SUMS'), '');
    pruneCache(cache);
    expect(names.map((name) => existsSync(join(cache, name)))).toEqual([false, true, true]);
    expect(existsSync(join(cache, 'SHA256SUMS'))).toBe(true);
  });
});

const daemonDist = fileURLToPath(new URL('../../../daemon/dist/daemon.js', import.meta.url));

/**
 * The whole decision-5/6 path against a real release-shaped zip: this
 * machine's node.exe as the runtime and, as the daemon, a fixture that runs
 * the built daemon (`pnpm build` first). Windows only: it drives tar.exe,
 * junctions and detached node.exe processes.
 */
describe.runIf(process.platform === 'win32' && existsSync(daemonDist))(
  'installing and supervising a Windows daemon',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'puddle-windows-install-'));
    const home = join(root, '.puddle');
    const zip = join(root, 'puddled-v1.2.3-win32-x64.zip');
    const savedHome = process.env.PUDDLE_HOME;

    beforeAll(() => {
      const tree = join(root, 'stage', 'puddled-v1.2.3');
      mkdirSync(join(tree, 'bin'), { recursive: true });
      mkdirSync(join(tree, 'daemon'), { recursive: true });
      try {
        linkSync(process.execPath, join(tree, 'bin', 'node.exe'));
      } catch {
        copyFileSync(process.execPath, join(tree, 'bin', 'node.exe'));
      }
      writeFileSync(
        join(tree, 'daemon', 'puddled.mjs'),
        [
          "if (process.argv.includes('--version')) {",
          "  console.log('puddled 1.2.3 (protocol 25.7)');",
          '  process.exit(0);',
          '}',
          `const { startDaemon } = await import(${JSON.stringify(pathToFileURL(daemonDist).href)});`,
          'await startDaemon({ port: 0, adapters: [], version: "1.2.3", onShutdown: () => process.exit(0) });',
          '',
        ].join('\n'),
      );
      writeFileSync(join(tree, 'VERSION'), '1.2.3\n');
      writeFileSync(join(tree, 'PROTOCOL'), '25.7\n');
      execFileSync(
        system32Path('tar.exe'),
        [
          '-a',
          '-c',
          '--options',
          'zip:compression=store',
          '-f',
          zip,
          '-C',
          dirname(tree),
          'puddled-v1.2.3',
        ],
        { windowsHide: true },
      );
      const digest = createHash('sha256').update(readFileSync(zip)).digest('hex');
      writeFileSync(`${zip}.sha256`, `${digest}  puddled-v1.2.3-win32-x64.zip\n`);
      process.env.PUDDLE_HOME = home;
    });

    afterAll(async () => {
      await stopWindowsDaemon(home).catch(() => undefined);
      if (savedHome === undefined) delete process.env.PUDDLE_HOME;
      else process.env.PUDDLE_HOME = savedHome;
    });

    it('verifies, unpacks, links, starts and stops the daemon', async () => {
      const lines: string[] = [];
      const logger = {
        info: (line: string) => lines.push(line),
        warn: (line: string) => lines.push(line),
      };
      await installWindowsDaemon({ home, tarball: zip, logger });

      expect(readCurrentVersion(home)).toBe('1.2.3');
      expect(readlinkSync(join(home, 'bin', 'current'))).toContain('versions\\1.2.3');
      expect(readFileSync(join(home, 'supervisor'), 'utf8')).toBe('detached\n');
      expect(readFileSync(join(home, 'bin', 'puddled.cmd'), 'utf8')).toBe(windowsLauncher());
      const firstPid = Number(readFileSync(join(home, 'puddled.pid'), 'utf8'));

      const started = await waitForStartedDaemon(new LocalTransport(), 60_000);
      expect(started.authority.version?.version).toBe('1.2.3');
      started.authority.close();

      // The idempotent path: nothing is unpacked again, but the daemon is replaced.
      await installWindowsDaemon({ home, tarball: zip, logger });
      expect(lines).toContain('version 1.2.3 already installed');
      expect(Number(readFileSync(join(home, 'puddled.pid'), 'utf8'))).not.toBe(firstPid);
      (await waitForStartedDaemon(new LocalTransport(), 60_000)).authority.close();

      // A launcher that only needs a daemon leaves a running one alone.
      const secondPid = readFileSync(join(home, 'puddled.pid'), 'utf8');
      await installWindowsDaemon({ home, tarball: zip, logger, replaceRunning: false });
      expect(readFileSync(join(home, 'puddled.pid'), 'utf8')).toBe(secondPid);

      await stopWindowsDaemon(home);
      expect(await controlPipePresent(home)).toBe(false);
      expect(existsSync(join(home, 'puddled.pid'))).toBe(false);
    }, 180_000);

    it('refuses an archive that does not match its checksum', async () => {
      const other = join(root, 'other');
      mkdirSync(other);
      const bad = join(other, 'puddled-v1.2.4-win32-x64.zip');
      copyFileSync(zip, bad);
      writeFileSync(`${bad}.sha256`, `${'0'.repeat(64)}  puddled-v1.2.4-win32-x64.zip\n`);
      await expect(installWindowsDaemon({ home, tarball: bad })).rejects.toThrow(
        'checksum mismatch',
      );
      expect(existsSync(join(home, 'bin', 'versions', '1.2.4'))).toBe(false);
    });
  },
);
