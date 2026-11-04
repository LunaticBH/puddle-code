import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyDesktopUpdate,
  checkForDesktopUpdate,
  desktopAppInstallPath,
  desktopUpdateAt,
  findInstalledDesktopApp,
  isNewerVersion,
  nsisInstallerArguments,
  parseSums,
  parseUninstallString,
  pickDesktopAsset,
  pruneDesktopUpdateCache,
  readAuthenticodeSignatures,
  stageDesktopUpdate,
  uninstallWindowsDesktop,
  windowsInstalledApp,
  type DesktopUpdate,
} from '../../src/lib/installation/desktop-update.js';
import { peImage } from '@puddle/shared/node/platform';
import { latestReleaseVersion } from '../../src/lib/installation/releases.js';

const sha256 = (data: string): string => createHash('sha256').update(data).digest('hex');

describe('isNewerVersion', () => {
  it('compares x.y.z numerically, not lexically', () => {
    expect(isNewerVersion('0.0.14', '0.0.13')).toBe(true);
    expect(isNewerVersion('0.0.13', '0.0.13')).toBe(false);
    expect(isNewerVersion('0.0.9', '0.0.13')).toBe(false);
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
  });

  it('tolerates a v prefix and rejects anything unparseable', () => {
    expect(isNewerVersion('v0.0.14', '0.0.13')).toBe(true);
    expect(isNewerVersion('nightly', '0.0.13')).toBe(false);
    expect(isNewerVersion('0.0.14-rc.1', '0.0.13')).toBe(false);
  });
});

describe('pickDesktopAsset', () => {
  const assets = [
    { name: 'Puddle-0.0.14-arm64-mac.zip', browser_download_url: 'u1' },
    { name: 'Puddle-0.0.14-arm64.dmg', browser_download_url: 'u2' },
    { name: 'Puddle-0.0.14.AppImage', browser_download_url: 'u3' },
    { name: 'Puddle-0.0.14-arm64.AppImage', browser_download_url: 'u4' },
    { name: 'SHA256SUMS', browser_download_url: 'u5' },
  ];

  it('matches platform + arch against electron-builder names', () => {
    expect(pickDesktopAsset(assets, 'darwin', 'arm64')?.name).toBe('Puddle-0.0.14-arm64-mac.zip');
    expect(pickDesktopAsset(assets, 'linux', 'x64')?.name).toBe('Puddle-0.0.14.AppImage');
    expect(pickDesktopAsset(assets, 'linux', 'arm64')?.name).toBe('Puddle-0.0.14-arm64.AppImage');
  });

  it('returns null when the release has nothing for this machine', () => {
    expect(pickDesktopAsset(assets, 'darwin', 'x64')).toBeNull(); // not published
    expect(pickDesktopAsset(assets, 'win32', 'x64')).toBeNull();
  });
});

describe('parseSums', () => {
  it('reads shasum output, ignoring noise', () => {
    const hex = 'a'.repeat(64);
    const sums = parseSums(`${hex}  Puddle-0.0.14-arm64-mac.zip\nnot a sum line\n`);
    expect(sums.get('Puddle-0.0.14-arm64-mac.zip')).toBe(hex);
    expect(sums.size).toBe(1);
  });
});

describe('mac desktop app locations', () => {
  it('discovers an existing app in the system or user Applications directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'puddle-app-location-'));
    try {
      const systemApplications = join(dir, 'system-applications');
      const home = join(dir, 'home');
      const app = join(home, 'Applications', 'Puddle.app', 'Contents');
      await mkdir(app, { recursive: true });
      await writeFile(
        join(app, 'Info.plist'),
        '<key>CFBundleShortVersionString</key><string>1.2.3</string>',
      );
      await expect(
        findInstalledDesktopApp({
          platform: 'darwin',
          homeDir: home,
          systemApplicationsDir: systemApplications,
        }),
      ).resolves.toEqual({
        appPath: join(home, 'Applications', 'Puddle.app'),
        version: '1.2.3',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prefers writable /Applications and falls back to a created ~/Applications', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'puddle-app-target-'));
    try {
      const systemApplications = join(dir, 'Applications');
      const home = join(dir, 'home');
      await mkdir(systemApplications, { recursive: true });
      await expect(
        desktopAppInstallPath({
          platform: 'darwin',
          homeDir: home,
          systemApplicationsDir: systemApplications,
          canWrite: () => Promise.resolve(true),
        }),
      ).resolves.toBe(join(systemApplications, 'Puddle.app'));

      await expect(
        desktopAppInstallPath({
          platform: 'darwin',
          homeDir: home,
          systemApplicationsDir: systemApplications,
          canWrite: () => Promise.resolve(false),
        }),
      ).resolves.toBe(join(home, 'Applications', 'Puddle.app'));
      expect((await stat(join(home, 'Applications'))).isDirectory()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('checkForDesktopUpdate', () => {
  const release = (tag: string) =>
    new Response(
      JSON.stringify({
        tag_name: tag,
        assets: [
          { name: `Puddle-${tag.slice(1)}-arm64-mac.zip`, browser_download_url: 'https://a/zip' },
          { name: 'SHA256SUMS', browser_download_url: 'https://a/sums' },
        ],
      }),
    );

  beforeAll(() => {
    process.env.PUDDLE_REPO = 'example/puddle';
  });
  afterAll(() => {
    delete process.env.PUDDLE_REPO;
  });

  it('offers a newer release for this platform', async () => {
    const update = await checkForDesktopUpdate('0.0.13', {
      platform: 'darwin',
      arch: 'arm64',
      fetchFn: () => Promise.resolve(release('v0.0.14')),
    });
    expect(update).toEqual({
      version: '0.0.14',
      asset: { name: 'Puddle-0.0.14-arm64-mac.zip', url: 'https://a/zip' },
      sumsUrl: 'https://a/sums',
    });
  });

  it('returns null when current, or when nothing fits this machine', async () => {
    const current = await checkForDesktopUpdate('0.0.14', {
      platform: 'darwin',
      arch: 'arm64',
      fetchFn: () => Promise.resolve(release('v0.0.14')),
    });
    expect(current).toBeNull();
    const wrongArch = await checkForDesktopUpdate('0.0.13', {
      platform: 'darwin',
      arch: 'x64',
      fetchFn: () => Promise.resolve(release('v0.0.14')),
    });
    expect(wrongArch).toBeNull();
  });

  it('throws on API failure so pollers can retry', async () => {
    await expect(
      checkForDesktopUpdate('0.0.13', {
        fetchFn: () => Promise.resolve(new Response('rate limited', { status: 403 })),
      }),
    ).rejects.toThrow(/HTTP 403/);
  });

  it('desktopUpdateAt pins a tag — downgrades included — and names a missing one', async () => {
    const pinned = await desktopUpdateAt('0.0.12', {
      platform: 'darwin',
      arch: 'arm64',
      fetchFn: () => Promise.resolve(release('v0.0.12')), // no newer-than check
    });
    expect(pinned?.version).toBe('0.0.12');
    await expect(
      desktopUpdateAt('9.9.9', {
        fetchFn: () => Promise.resolve(new Response('nope', { status: 404 })),
      }),
    ).rejects.toThrow(/no release v9\.9\.9/);
  });
});

describe('latestReleaseVersion', () => {
  beforeAll(() => {
    process.env.PUDDLE_REPO = 'example/puddle';
  });
  afterAll(() => {
    delete process.env.PUDDLE_REPO;
  });

  it('resolves the latest tag, stripping the v', async () => {
    await expect(
      latestReleaseVersion({
        fetchFn: () => Promise.resolve(new Response(JSON.stringify({ tag_name: 'v0.0.33' }))),
      }),
    ).resolves.toBe('0.0.33');
  });

  it('fails legibly when the API is unreachable', async () => {
    await expect(
      latestReleaseVersion({
        fetchFn: () => Promise.resolve(new Response('rate limited', { status: 403 })),
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe('stageDesktopUpdate + applyDesktopUpdate (AppImage path)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'puddle-update-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const NAME = 'Puddle-0.0.14.AppImage';
  const BODY = '#!/bin/sh\necho new-version\n';
  const update: DesktopUpdate = {
    version: '0.0.14',
    asset: { name: NAME, url: 'https://a/appimage' },
    sumsUrl: 'https://a/sums',
  };
  const serve =
    (sums: string): typeof fetch =>
    (input) =>
      Promise.resolve(String(input).endsWith('/sums') ? new Response(sums) : new Response(BODY));

  // The AppImage swap is a /bin/sh helper and asserts a Unix mode bit.
  it.skipIf(process.platform === 'win32')(
    'downloads, verifies, and stages; the swap replaces the target and cleans up',
    async () => {
      const staged = await stageDesktopUpdate(update, {
        cacheDir: join(dir, 'cache'),
        fetchFn: serve(`${sha256(BODY)}  ${NAME}\n`),
      });
      expect(staged.kind).toBe('appimage');
      expect((await stat(staged.stagedPath)).mode & 0o100).toBeTruthy(); // executable

      const target = join(dir, 'installed.AppImage');
      await writeFile(target, '#!/bin/sh\necho old-version\n');
      await chmod(target, 0o755);
      await applyDesktopUpdate(staged, { targetPath: target, detach: false, relaunch: false });
      expect(await readFile(target, 'utf8')).toBe(BODY);
      await expect(stat(staged.dir)).rejects.toThrow(); // staging dir removed
    },
  );

  it('rejects a checksum mismatch and leaves no staging directory behind', async () => {
    const cacheDir = join(dir, 'cache-bad');
    await mkdir(cacheDir, { recursive: true });
    await expect(
      stageDesktopUpdate(update, {
        cacheDir,
        fetchFn: serve(`${'b'.repeat(64)}  ${NAME}\n`),
      }),
    ).rejects.toThrow(/checksum mismatch/);
    await expect(stat(join(cacheDir, update.version))).rejects.toThrow();
  });
});

describe('Windows NSIS desktop updates', () => {
  const NAME = 'Puddle-0.0.14-x64-setup.exe';
  const BODY = 'MZ fake installer';
  const update: DesktopUpdate = {
    version: '0.0.14',
    asset: { name: NAME, url: 'https://a/setup' },
    sumsUrl: 'https://a/sums',
  };

  it('picks only the installer built for this architecture', () => {
    const assets = [
      { name: 'Puddle-0.0.14-arm64-mac.zip', browser_download_url: 'u1' },
      { name: NAME, browser_download_url: 'u2' },
      { name: 'Puddle-0.0.14-x64-setup.exe.blockmap', browser_download_url: 'u3' },
      { name: 'Puddle-0.0.14-arm64-setup.exe.blockmap', browser_download_url: 'u5' },
    ];
    const arm64 = { name: 'Puddle-0.0.14-arm64-setup.exe', browser_download_url: 'u4' };
    expect(pickDesktopAsset(assets, 'win32', 'x64')?.name).toBe(NAME);
    // Windows on Arm never falls back to the emulated x64 build.
    expect(pickDesktopAsset(assets, 'win32', 'arm64')).toBeNull();
    expect(pickDesktopAsset([...assets, arm64], 'win32', 'arm64')?.name).toBe(arm64.name);
    expect(pickDesktopAsset([arm64, ...assets], 'win32', 'x64')?.name).toBe(NAME);
    expect(pickDesktopAsset([arm64], 'win32', 'x64')).toBeNull();
    expect(pickDesktopAsset([...assets, arm64], 'win32', 'ia32')).toBeNull();
  });

  it('chooses by the operating system architecture, not the process', async () => {
    process.env.PUDDLE_REPO = 'example/puddle';
    try {
      const release = () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              tag_name: 'v0.0.14',
              assets: [
                { name: NAME, browser_download_url: 'https://a/x64' },
                { name: 'Puddle-0.0.14-arm64-setup.exe', browser_download_url: 'https://a/arm64' },
                { name: 'SHA256SUMS', browser_download_url: 'https://a/sums' },
              ],
            }),
          ),
        );
      let asked = 0;
      const hostArch = () => {
        asked++;
        return Promise.resolve('arm64');
      };
      const update = await checkForDesktopUpdate('0.0.13', {
        platform: 'win32',
        hostArch,
        fetchFn: release,
      });
      expect(update?.asset).toEqual({
        name: 'Puddle-0.0.14-arm64-setup.exe',
        url: 'https://a/arm64',
      });
      expect(asked).toBe(1);
      const pinned = await desktopUpdateAt('0.0.14', {
        platform: 'win32',
        hostArch: () => Promise.resolve('x64'),
        fetchFn: release,
      });
      expect(pinned?.asset.name).toBe(NAME);
      // An explicit architecture wins, and POSIX never asks for the host's.
      const explicit = await checkForDesktopUpdate('0.0.13', {
        platform: 'win32',
        arch: 'x64',
        hostArch: () => Promise.reject(new Error('not asked')),
        fetchFn: release,
      });
      expect(explicit?.asset.name).toBe(NAME);
      await expect(
        checkForDesktopUpdate('0.0.13', {
          platform: 'linux',
          hostArch: () => Promise.reject(new Error('not asked')),
          fetchFn: release,
        }),
      ).resolves.toBeNull();
    } finally {
      delete process.env.PUDDLE_REPO;
    }
  });

  it('stages the verified installer itself, without unpacking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'puddle-update-win-'));
    try {
      const staged = await stageDesktopUpdate(update, {
        cacheDir: dir,
        platform: 'win32',
        fetchFn: (input) =>
          Promise.resolve(
            new Response(String(input).endsWith('/sums') ? `${sha256(BODY)}  ${NAME}\n` : BODY),
          ),
      });
      expect(staged).toEqual({
        version: '0.0.14',
        kind: 'nsis',
        stagedPath: join(dir, '0.0.14', NAME),
        dir: join(dir, '0.0.14'),
      });
      expect(await readFile(staged.stagedPath, 'utf8')).toBe(BODY);

      const zip = { ...update, asset: { name: 'Puddle-0.0.14-win.zip', url: 'https://a/zip' } };
      await expect(
        stageDesktopUpdate(zip, {
          cacheDir: dir,
          platform: 'win32',
          fetchFn: (input) =>
            Promise.resolve(
              new Response(
                String(input).endsWith('/sums') ? `${sha256(BODY)}  ${zip.asset.name}\n` : BODY,
              ),
            ),
        }),
      ).rejects.toThrow(/not a Windows installer/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('Authenticode publisher', () => {
    const PUBLISHER = 'CN=Example Publisher, O=Example Publisher, C=GB';
    /** A PE header with (or without) a certificate table: what peImage reads. */
    const peFile = (signed: boolean): Buffer => {
      const image = Buffer.alloc(0x400);
      image.write('MZ', 0, 'latin1');
      image.writeUInt32LE(0x80, 0x3c);
      image.write('PE\0\0', 0x80, 'latin1');
      image.writeUInt16LE(0x8664, 0x84);
      image.writeUInt16LE(112 + 16 * 8, 0x80 + 20);
      image.writeUInt16LE(0x20b, 0x98);
      image.writeUInt32LE(16, 0x98 + 108);
      if (signed) {
        image.writeUInt32LE(0x300, 0x98 + 112 + 4 * 8);
        image.writeUInt32LE(8, 0x98 + 112 + 4 * 8 + 4);
      }
      return image;
    };
    const stage = async (
      dir: string,
      currentApp: string,
      answer: (files: string[]) => Promise<string>,
    ) => {
      const calls: string[][] = [];
      const staged = stageDesktopUpdate(update, {
        cacheDir: dir,
        platform: 'win32',
        currentApp,
        powershell: (script, env) => {
          expect(script).toContain('Get-AuthenticodeSignature -LiteralPath $file');
          const files = env.PUDDLE_AUTHENTICODE_FILES!.split('\n');
          calls.push(files);
          return answer(files);
        },
        fetchFn: (input) =>
          Promise.resolve(
            new Response(String(input).endsWith('/sums') ? `${sha256(BODY)}  ${NAME}\n` : BODY),
          ),
      });
      return { staged, calls };
    };
    const signatures = (...rows: Array<[string, string | null]>) =>
      Promise.resolve(JSON.stringify(rows.map(([status, publisher]) => ({ status, publisher }))));

    it('keeps checksum-only trust for an unsigned app, without starting PowerShell', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'puddle-update-sign-'));
      try {
        const app = join(dir, 'Puddle.exe');
        await writeFile(app, peFile(false));
        const { staged, calls } = await stage(dir, app, () =>
          Promise.reject(new Error('not asked')),
        );
        await expect(staged).resolves.toMatchObject({ kind: 'nsis' });
        expect(calls).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('accepts an installer from the signed app’s own publisher', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'puddle-update-sign-'));
      try {
        const app = join(dir, 'Puddle.exe');
        await writeFile(app, peFile(true));
        const { staged, calls } = await stage(dir, app, () =>
          signatures(['Valid', PUBLISHER], ['Valid', PUBLISHER]),
        );
        await expect(staged).resolves.toMatchObject({ stagedPath: join(dir, '0.0.14', NAME) });
        expect(calls).toEqual([[app, join(dir, '0.0.14', NAME)]]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('refuses another publisher, an unsigned installer or an unanswerable check', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'puddle-update-sign-'));
      try {
        const app = join(dir, 'Puddle.exe');
        await writeFile(app, peFile(true));
        const other = await stage(dir, app, () =>
          signatures(['Valid', PUBLISHER], ['Valid', 'CN=Someone Else']),
        );
        await expect(other.staged).rejects.toThrow(
          `${NAME} is signed by CN=Someone Else, not by ${PUBLISHER}`,
        );
        expect(existsSync(join(dir, '0.0.14'))).toBe(false);
        const unsigned = await stage(dir, app, () =>
          signatures(['Valid', PUBLISHER], ['NotSigned', null]),
        );
        await expect(unsigned.staged).rejects.toThrow(`${NAME} is not validly signed (NotSigned)`);
        const tampered = await stage(dir, app, () =>
          signatures(['Valid', PUBLISHER], ['HashMismatch', PUBLISHER]),
        );
        await expect(tampered.staged).rejects.toThrow('not validly signed (HashMismatch)');
        const blocked = await stage(dir, app, () => Promise.reject(new Error('blocked by policy')));
        await expect(blocked.staged).rejects.toThrow('could not check the Authenticode signature');
        const short = await stage(dir, app, () => signatures(['Valid', PUBLISHER]));
        await expect(short.staged).rejects.toThrow('could not check the Authenticode signature');
        expect(existsSync(join(dir, '0.0.14'))).toBe(false);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('treats a certificate table without a signer as unsigned', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'puddle-update-sign-'));
      try {
        const app = join(dir, 'Puddle.exe');
        await writeFile(app, peFile(true));
        const { staged } = await stage(dir, app, () =>
          signatures(['NotSigned', null], ['NotSigned', null]),
        );
        await expect(staged).resolves.toMatchObject({ kind: 'nsis' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('reads one signature per file, single or many', async () => {
      await expect(
        readAuthenticodeSignatures(['a.exe'], () =>
          Promise.resolve('{"status":"Valid","publisher":"CN=A"}'),
        ),
      ).resolves.toEqual([{ status: 'Valid', publisher: 'CN=A' }]);
      await expect(
        readAuthenticodeSignatures(['a.exe', 'b.exe'], () =>
          Promise.resolve('[{"status":"NotSigned","publisher":null},{"status":3}]'),
        ),
      ).resolves.toEqual([
        { status: 'NotSigned', publisher: null },
        { status: 'UnknownError', publisher: null },
      ]);
    });

    it.runIf(process.platform === 'win32')(
      'asks Windows PowerShell for real signatures',
      async () => {
        const dir = await mkdtemp(join(tmpdir(), 'puddle-update-sign-'));
        try {
          const unsigned = join(dir, 'unsigned é.ps1');
          await writeFile(unsigned, 'Write-Output 1\r\n');
          const [script, node] = await readAuthenticodeSignatures([unsigned, process.execPath]);
          expect(script).toEqual({ status: 'NotSigned', publisher: null });
          // Official Node builds carry their publisher's signature.
          if (peImage(process.execPath)?.signed) expect(node?.publisher).not.toBeNull();
          // A failure reports PowerShell's message, not a CLIXML error record.
          const missing = readAuthenticodeSignatures([join(dir, 'missing.exe')]);
          await expect(missing).rejects.toThrow(/missing\.exe/);
          await expect(missing).rejects.not.toThrow(/CLIXML/);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      60_000,
    );
  });

  it('runs the installer silently, as electron-updater does', () => {
    expect(nsisInstallerArguments(true, true)).toEqual(['--updated', '/S', '--force-run']);
    expect(nsisInstallerArguments(true, false)).toEqual(['--updated', '/S']);
    expect(nsisInstallerArguments(false, false)).toEqual(['/S']);
  });

  it('finds the registered per-user installation and its uninstaller', async () => {
    const registration = {
      version: '1.2.3',
      installLocation: 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\@puddle-codedesktop',
      uninstallString:
        '"C:\\Users\\Zoë\\AppData\\Local\\Programs\\@puddle-codedesktop\\Uninstall Puddle.exe" /currentuser',
    };
    await expect(
      findInstalledDesktopApp({
        platform: 'win32',
        readRegistry: () => Promise.resolve(registration),
      }),
    ).resolves.toEqual({
      appPath: 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\@puddle-codedesktop\\Puddle.exe',
      version: '1.2.3',
      uninstallString: registration.uninstallString,
    });
    await expect(
      findInstalledDesktopApp({ platform: 'win32', readRegistry: () => Promise.resolve(null) }),
    ).resolves.toBeNull();
    expect(windowsInstalledApp({ version: '1.2.3', installLocation: null })).toBeNull();
    expect(parseUninstallString(registration.uninstallString)).toEqual({
      file: 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\@puddle-codedesktop\\Uninstall Puddle.exe',
      args: ['/currentuser'],
    });
    expect(parseUninstallString('cmd /c del everything')).toBeNull();
  });

  it('refuses removal without a registered uninstaller', async () => {
    await expect(
      uninstallWindowsDesktop({ appPath: 'C:\\x\\Puddle.exe', version: '1.2.3' }),
    ).rejects.toThrow(/uninstaller is not registered/);
  });

  // The real uninstaller relaunches itself from %TEMP%: removal waits for the registration.
  it.runIf(process.platform === 'win32')(
    'waits for the registration to disappear after the uninstaller exits',
    async () => {
      let reads = 0;
      const registration = { version: '1.2.3', installLocation: 'C:\\x', uninstallString: '' };
      await uninstallWindowsDesktop(
        {
          appPath: 'C:\\x\\Puddle.exe',
          version: '1.2.3',
          // node.exe --version ignores the silent flag that follows it.
          uninstallString: `"${process.execPath}" --version`,
        },
        {
          pollMs: 10,
          readRegistry: () => Promise.resolve(++reads < 3 ? registration : null),
        },
      );
      expect(reads).toBe(3);
    },
  );
});

describe('pruneDesktopUpdateCache', () => {
  it('removes every staged version except the kept one, and tolerates no cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'puddle-prune-'));
    try {
      const cacheDir = join(dir, 'cache', 'desktop');
      for (const version of ['0.0.12', '0.0.13', '0.0.14']) {
        await mkdir(join(cacheDir, version), { recursive: true });
        await writeFile(join(cacheDir, version, 'asset'), 'x');
      }
      await pruneDesktopUpdateCache(['0.0.14'], { cacheDir });
      await expect(stat(join(cacheDir, '0.0.12'))).rejects.toThrow();
      await expect(stat(join(cacheDir, '0.0.13'))).rejects.toThrow();
      expect((await stat(join(cacheDir, '0.0.14'))).isDirectory()).toBe(true);

      await pruneDesktopUpdateCache([], { cacheDir }); // the boot sweep keeps nothing
      await expect(stat(join(cacheDir, '0.0.14'))).rejects.toThrow();

      // A machine that has never staged an update has no cache dir at all.
      await expect(
        pruneDesktopUpdateCache([], { cacheDir: join(dir, 'absent') }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The mac path needs ditto(1), so it only runs where it will in production.
describe.runIf(process.platform === 'darwin')('mac zip staging + swap', () => {
  it('unpacks the .app with ditto and the helper swaps the bundle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'puddle-update-mac-'));
    try {
      // A fake release zip: <root>/Puddle.app/Contents/Info.plist, zipped the
      // way electron-builder ships it (the bundle at the archive root).
      const src = join(dir, 'src');
      await mkdir(join(src, 'Puddle.app', 'Contents'), { recursive: true });
      await writeFile(join(src, 'Puddle.app', 'Contents', 'Info.plist'), 'new-bundle');
      const zip = join(dir, 'Puddle-9.9.9-arm64-mac.zip');
      await promisify(execFile)('/usr/bin/ditto', ['-c', '-k', src, zip]);
      const bytes = await readFile(zip);

      const update: DesktopUpdate = {
        version: '9.9.9',
        asset: { name: basename(zip), url: 'https://a/zip' },
        sumsUrl: 'https://a/sums',
      };
      const staged = await stageDesktopUpdate(update, {
        cacheDir: join(dir, 'cache'),
        fetchFn: (input) =>
          Promise.resolve(
            String(input).endsWith('/sums')
              ? new Response(
                  `${createHash('sha256').update(bytes).digest('hex')}  ${basename(zip)}\n`,
                )
              : new Response(bytes),
          ),
      });
      expect(staged.kind).toBe('mac-app');
      expect(staged.stagedPath.endsWith('Puddle.app')).toBe(true);

      // Worst case: the staged bundle somehow carries quarantine (translocated
      // first install, hand-downloaded zip) — the swap must strip it.
      await promisify(execFile)('/usr/bin/xattr', [
        '-w',
        'com.apple.quarantine',
        '0081;00000000;test;',
        staged.stagedPath,
      ]);

      const target = join(dir, 'Applications', 'Puddle.app');
      await mkdir(join(target, 'Contents'), { recursive: true });
      await writeFile(join(target, 'Contents', 'Info.plist'), 'old-bundle');
      await applyDesktopUpdate(staged, { targetPath: target, detach: false, relaunch: false });
      expect(await readFile(join(target, 'Contents', 'Info.plist'), 'utf8')).toBe('new-bundle');
      await expect(stat(`${target}.old`)).rejects.toThrow(); // no leftovers
      await expect(stat(staged.dir)).rejects.toThrow();
      await expect(
        promisify(execFile)('/usr/bin/xattr', ['-p', 'com.apple.quarantine', target]),
      ).rejects.toThrow(); // quarantine stripped by the helper
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('installs a staged bundle when the Applications target does not exist yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'puddle-install-mac-'));
    try {
      const stagedDir = join(dir, 'staged');
      const stagedPath = join(stagedDir, 'extract', 'Puddle.app');
      await mkdir(join(stagedPath, 'Contents'), { recursive: true });
      await writeFile(join(stagedPath, 'Contents', 'Info.plist'), 'fresh-bundle');

      const target = join(dir, 'new-home', 'Applications', 'Puddle.app');
      await applyDesktopUpdate(
        { version: '9.9.9', kind: 'mac-app', stagedPath, dir: stagedDir },
        { targetPath: target, detach: false, relaunch: false },
      );
      expect(await readFile(join(target, 'Contents', 'Info.plist'), 'utf8')).toBe('fresh-bundle');
      await expect(stat(`${target}.old`)).rejects.toThrow();
      await expect(stat(stagedDir)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
