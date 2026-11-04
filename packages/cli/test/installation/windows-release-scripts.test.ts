import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertWindowsTreeArch, peMachine } from '../../../../scripts/lib/node-runtime.mjs';
import * as windowsSign from '../../../../scripts/lib/windows-sign.mjs';
import { readAuthenticodeSignatures } from '../../src/lib/installation/desktop-update.js';

type Run = (
  script: string,
  env: Record<string, string | undefined>,
  log: (line: string) => void,
) => Promise<void>;
const { SIGN_SCRIPT, signWindowsTree, windowsSigningMode } = windowsSign as {
  SIGN_SCRIPT: string;
  signWindowsTree: (
    root: string,
    log?: (message: string) => void,
    options?: { scripts?: boolean; env?: Record<string, string | undefined>; run?: Run },
  ) => Promise<boolean>;
  windowsSigningMode: (env?: Record<string, string | undefined>) => string;
};

const temp = mkdtempSync(join(tmpdir(), 'puddle-windows-release-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

/** A PE header with the given COFF machine, optionally an IL-only CLR image. */
function pe(machine: number, clrFlags?: number): Buffer {
  const image = Buffer.alloc(0x800);
  image.write('MZ', 0, 'latin1');
  image.writeUInt32LE(0x80, 0x3c);
  image.write('PE\0\0', 0x80, 'latin1');
  image.writeUInt16LE(machine, 0x84);
  image.writeUInt16LE(1, 0x86);
  image.writeUInt16LE(96 + 16 * 8, 0x80 + 20);
  const optional = 0x98;
  image.writeUInt16LE(0x10b, optional);
  image.writeUInt32LE(16, optional + 92);
  const section = optional + 96 + 16 * 8;
  image.writeUInt32LE(0x1000, section + 8);
  image.writeUInt32LE(0x2000, section + 12);
  image.writeUInt32LE(0x200, section + 16);
  image.writeUInt32LE(0x400, section + 20);
  if (clrFlags !== undefined) {
    image.writeUInt32LE(0x2008, optional + 96 + 14 * 8);
    image.writeUInt32LE(72, optional + 96 + 14 * 8 + 4);
    image.writeUInt32LE(clrFlags, 0x408 + 16);
  }
  return image;
}

function tree(name: string, files: Record<string, Buffer | string>): string {
  const root = join(temp, name);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return root;
}

describe('Windows release tree architecture', () => {
  it('reads PE machine types as the shared helper does', () => {
    const file = (name: string, contents: Buffer | string) => {
      writeFileSync(join(temp, name), contents);
      return join(temp, name);
    };
    expect(peMachine(file('a.exe', pe(0x8664)))).toBe('x64');
    expect(peMachine(file('b.exe', pe(0xaa64)))).toBe('arm64');
    expect(peMachine(file('c.exe', pe(0x14c)))).toBe('x86');
    expect(peMachine(file('d.exe', pe(0x14c, 0x1)))).toBe('anycpu');
    expect(peMachine(file('e.exe', pe(0x14c, 0x3)))).toBe('x86');
    expect(peMachine(file('f.exe', pe(0xa641)))).toBe('machine 0xa641');
    expect(peMachine(file('g.exe', 'MZ but nothing else'))).toBeNull();
    expect(peMachine(join(temp, 'missing.exe'))).toBeNull();
  });

  it('accepts a native tree with AnyCPU helpers and names every stray binary', () => {
    const arm64 = tree('arm64', {
      'bin/node.exe': pe(0xaa64),
      'daemon/node_modules/node-pty/prebuilds/win32-arm64/conpty/conpty.dll': pe(0xaa64),
      'daemon/node_modules/node-pty/prebuilds/win32-arm64/pty.node': pe(0xaa64),
      'dist/ssh-askpass.exe': pe(0x14c, 0x1),
      'daemon/puddled.mjs': 'export {};',
    });
    expect(assertWindowsTreeArch(arm64, 'arm64')).toBe(4);
    expect(() => assertWindowsTreeArch(arm64, 'x64')).toThrow(/bin\/node\.exe \(arm64\)/);

    const mixed = tree('mixed', {
      'bin/node.exe': pe(0xaa64),
      'daemon/node_modules/better-sqlite3/build/Release/better_sqlite3.node': pe(0x8664),
      'resources/elevate.exe': pe(0x14c),
      'BROKEN.DLL': 'not a PE image',
    });
    let message = '';
    try {
      assertWindowsTreeArch(mixed, 'arm64');
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('better_sqlite3.node (x64)');
    expect(message).toContain('resources/elevate.exe (x86)');
    expect(message).toContain('BROKEN.DLL (not a PE image)');
    expect(message).not.toContain('node.exe');
    expect(() =>
      assertWindowsTreeArch(mixed, 'arm64', {
        except: [
          'daemon/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
          'resources/elevate.exe',
          'BROKEN.DLL',
        ],
      }),
    ).not.toThrow();
    expect(() => assertWindowsTreeArch(mixed, 'ia32')).toThrow('unknown Windows architecture');
  });
});

describe('Windows Authenticode signing of release trees', () => {
  const never: Run = () => Promise.reject(new Error('not run'));

  it('selects a mode, and none leaves the tree alone', async () => {
    expect(windowsSigningMode({})).toBe('none');
    expect(windowsSigningMode({ PUDDLE_WINDOWS_SIGNING: '' })).toBe('none');
    expect(windowsSigningMode({ PUDDLE_WINDOWS_SIGNING: 'none' })).toBe('none');
    expect(windowsSigningMode({ PUDDLE_WINDOWS_SIGNING: 'certificate' })).toBe('certificate');
    expect(windowsSigningMode({ PUDDLE_WINDOWS_SIGNING: 'azure' })).toBe('azure');
    expect(() => windowsSigningMode({ PUDDLE_WINDOWS_SIGNING: 'yes' })).toThrow(
      'must be certificate, azure or none',
    );
    await expect(
      signWindowsTree(temp, () => {}, { env: { WIN_CSC_LINK: 'ignored' }, run: never }),
    ).resolves.toBe(false);
  });

  it('refuses a selected mode without its configuration', async () => {
    await expect(
      signWindowsTree(temp, () => {}, {
        env: { PUDDLE_WINDOWS_SIGNING: 'certificate', WIN_CSC_LINK: '' },
        run: never,
      }),
    ).rejects.toThrow('certificate signing needs WIN_CSC_LINK');
    await expect(
      signWindowsTree(temp, () => {}, {
        env: { PUDDLE_WINDOWS_SIGNING: 'azure', AZURE_SIGNING_ENDPOINT: 'https://e' },
        run: never,
      }),
    ).rejects.toThrow('azure signing needs AZURE_SIGNING_ACCOUNT, AZURE_SIGNING_PROFILE');
  });

  it('hands the root, scope and secrets to PowerShell through the environment', async () => {
    const calls: Array<{ script: string; env: Record<string, string | undefined> }> = [];
    const run: Run = (script, env) => {
      calls.push({ script, env });
      return Promise.resolve();
    };
    await expect(
      signWindowsTree('C:\\stage', () => {}, {
        scripts: true,
        env: { PUDDLE_WINDOWS_SIGNING: 'certificate', WIN_CSC_LINK: 'cGZ4', SystemRoot: 'C:\\W' },
        run,
      }),
    ).resolves.toBe(true);
    await signWindowsTree('C:\\stage', () => {}, {
      env: {
        PUDDLE_WINDOWS_SIGNING: 'azure',
        AZURE_SIGNING_ENDPOINT: 'https://weu.codesigning.azure.net',
        AZURE_SIGNING_ACCOUNT: 'account',
        AZURE_SIGNING_PROFILE: 'profile',
        PUDDLE_TIMESTAMP_URL: 'http://timestamp.example',
      },
      run,
    });
    expect(calls.map(({ env }) => env)).toEqual([
      expect.objectContaining({
        PUDDLE_WINDOWS_SIGNING: 'certificate',
        PUDDLE_SIGN_ROOT: 'C:\\stage',
        PUDDLE_SIGN_SCRIPTS: '1',
        PUDDLE_TIMESTAMP_URL: 'http://timestamp.digicert.com',
        WIN_CSC_LINK: 'cGZ4',
        SystemRoot: 'C:\\W',
      }),
      expect.objectContaining({
        PUDDLE_WINDOWS_SIGNING: 'azure',
        PUDDLE_SIGN_SCRIPTS: '0',
        PUDDLE_TIMESTAMP_URL: 'http://timestamp.example',
      }),
    ]);
    expect(calls[0]!.script).toBe(SIGN_SCRIPT);
    // Nothing secret or path-like is ever spliced into the script itself.
    expect(SIGN_SCRIPT).not.toContain('C:\\stage');
    expect(SIGN_SCRIPT).toContain("Status -ne 'Valid'");
    expect(SIGN_SCRIPT).toContain('TimeStamperCertificate');
    expect(SIGN_SCRIPT).toContain('Invoke-TrustedSigning');
  });

  it.runIf(process.platform === 'win32')(
    'signs only files without a valid signature and fails when a signature does not verify',
    async () => {
      const root = tree('signing', {
        'bin/unsigned.dll': pe(0x8664),
        'cli/install-cli.ps1': 'Write-Output 1\r\n',
        'cli/index.js': 'export {};',
      });
      copyFileSync(process.execPath, join(root, 'bin', 'node.exe'));
      const nodeHash = createHash('sha256')
        .update(readFileSync(join(root, 'bin', 'node.exe')))
        .digest('hex');
      const tools = join(temp, 'tools');
      const scratch = join(temp, 'scratch');
      mkdirSync(tools, { recursive: true });
      mkdirSync(scratch, { recursive: true });
      // A signtool that signs nothing: verification must then refuse the tree.
      const signtool = join(tools, 'signtool.cmd');
      writeFileSync(signtool, '@echo %*>>"%~dp0arguments.txt"\r\n@exit /b 0\r\n');
      const logged: string[] = [];
      await expect(
        signWindowsTree(root, (line) => logged.push(line), {
          scripts: true,
          env: {
            ...process.env,
            PUDDLE_WINDOWS_SIGNING: 'certificate',
            WIN_CSC_LINK: Buffer.from('not really a PFX').toString('base64'),
            WIN_CSC_KEY_PASSWORD: 'dry-run',
            SIGNTOOL_PATH: signtool,
            TEMP: scratch,
            TMP: scratch,
          },
        }),
      ).rejects.toThrow(
        /^Authenticode signing failed: not validly signed and timestamped: .*unsigned\.dll \(NotSigned\)/,
      );
      expect(logged).toContainEqual(
        expect.stringMatching(/^windows-sign: [23] of 3 files need a signature \(certificate\)$/),
      );
      const signed = readFileSync(join(tools, 'arguments.txt'), 'utf8');
      expect(signed).toContain('sign /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com /f');
      expect(signed).toContain('/p dry-run');
      expect(signed).toContain(join(root, 'bin', 'unsigned.dll'));
      expect(signed).toContain(join(root, 'cli', 'install-cli.ps1'));
      expect(signed).not.toContain('index.js');
      const [node] = await readAuthenticodeSignatures([join(root, 'bin', 'node.exe')]);
      if (node!.status === 'Valid') expect(signed).not.toContain('node.exe');
      expect(
        createHash('sha256')
          .update(readFileSync(join(root, 'bin', 'node.exe')))
          .digest('hex'),
      ).toBe(nodeHash);
      // The decoded certificate never outlives the run.
      expect(readdirSync(scratch).filter((name) => name.endsWith('.pfx'))).toEqual([]);
    },
    120_000,
  );
});
