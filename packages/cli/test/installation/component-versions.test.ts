import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatComponentVersions,
  installedComponentVersions,
  recordDesktopInstallation,
  releasedProtocol,
} from '../../src/lib/installation/component-versions';

describe('installed component versions', () => {
  it('reads exact daemon metadata and legacy macOS desktop protocol history offline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'puddle-component-versions-'));
    const home = join(root, '.puddle');
    const daemon = join(home, 'bin', 'versions', '9.8.7');
    const desktop = join(root, 'Applications', 'Puddle.app');
    mkdirSync(daemon, { recursive: true });
    mkdirSync(join(home, 'bin'), { recursive: true });
    mkdirSync(desktop, { recursive: true });
    writeFileSync(join(daemon, 'PROTOCOL'), '99.2\n');
    symlinkSync('versions/9.8.7', join(home, 'bin', 'current'));

    const components = await installedComponentVersions({
      home,
      platform: 'darwin',
      findDesktop: () => Promise.resolve({ appPath: desktop, version: '0.0.43' }),
    });

    expect(components[1]).toEqual({
      component: 'daemon',
      installed: true,
      version: '9.8.7',
      protocol: { major: 99, minor: 2 },
    });
    expect(components[2]).toEqual({
      component: 'desktop',
      installed: true,
      version: '0.0.43',
      protocol: { major: 16, minor: 0 },
    });
  });

  it('uses a packaged desktop self-record wherever an AppImage lives', async () => {
    const root = mkdtempSync(join(tmpdir(), 'puddle-component-versions-'));
    const home = join(root, '.puddle');
    const appImage = join(root, 'tools', 'Puddle.AppImage');
    mkdirSync(join(root, 'tools'), { recursive: true });
    writeFileSync(appImage, 'appimage');
    recordDesktopInstallation(
      {
        path: appImage,
        version: '4.5.6',
        protocol: { major: 17, minor: 3 },
      },
      join(home, 'desktop-install.json'),
    );

    const components = await installedComponentVersions({ home, platform: 'linux' });
    expect(components[2]).toEqual({
      component: 'desktop',
      installed: true,
      version: '4.5.6',
      protocol: { major: 17, minor: 3 },
    });
  });

  it('retains the published release ledger and renders absent components honestly', () => {
    expect(releasedProtocol('0.0.1')).toEqual({ major: 5, minor: 1 });
    expect(releasedProtocol('0.0.44')).toEqual({ major: 16, minor: 0 });
    expect(
      formatComponentVersions([
        {
          component: 'cli',
          installed: true,
          version: '0.0.44',
          protocol: { major: 16, minor: 1 },
        },
        { component: 'daemon', installed: false },
        { component: 'desktop', installed: true },
      ]),
    ).toBe(
      [
        'cli     0.0.44 (protocol 16.1)',
        'daemon  not installed',
        'desktop unknown version (protocol unknown)',
      ].join('\n'),
    );
  });
});

it('displays connector metadata as a suffix without changing the daemon compatibility protocol', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-connector-version-'));
  const directory = join(home, 'bin', 'versions', '9.8.7');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'PROTOCOL'), '21.3\n');
  writeFileSync(join(directory, 'CONNECTOR_PROTOCOL'), '4\n');
  symlinkSync('versions/9.8.7', join(home, 'bin', 'current'));
  const components = await installedComponentVersions({ home, platform: 'linux' });
  expect(components[1]).toMatchObject({ protocol: { major: 21, minor: 3 }, connectorProtocol: 4 });
  expect(formatComponentVersions(components)).toContain('daemon  9.8.7 (protocol 21.3c4)');
  writeFileSync(join(directory, 'CONNECTOR_PROTOCOL'), 'bad\n');
  expect(
    formatComponentVersions(await installedComponentVersions({ home, platform: 'linux' })),
  ).toContain('daemon  9.8.7 (protocol 21.3)');
});
