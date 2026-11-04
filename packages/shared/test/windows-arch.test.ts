import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  isWindowsArch,
  peImage,
  peMachine,
  windowsArchFromProcessor,
  windowsHostArch,
} from '../src/node/platform.js';

const temp = mkdtempSync(join(tmpdir(), 'puddle-windows-arch-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

interface SyntheticPe {
  machine: number;
  /** 0x10b (PE32) or 0x20b (PE32+). */
  magic?: number;
  signed?: boolean;
  /** CLR header flags; absent for a native image. */
  clrFlags?: number;
}

/**
 * The smallest PE image these readers look at: DOS header, COFF header,
 * optional header with its data directories, one section holding the CLR
 * header, and a certificate table when signed.
 */
function syntheticPe({ machine, magic = 0x20b, signed = false, clrFlags }: SyntheticPe): Buffer {
  const image = Buffer.alloc(0x800);
  image.write('MZ', 0, 'latin1');
  const header = 0x80;
  image.writeUInt32LE(header, 0x3c);
  image.write('PE\0\0', header, 'latin1');
  const directories = magic === 0x20b ? 112 : 96;
  const optionalSize = directories + 16 * 8;
  image.writeUInt16LE(machine, header + 4);
  image.writeUInt16LE(1, header + 6); // one section
  image.writeUInt16LE(optionalSize, header + 20);
  const optional = header + 24;
  image.writeUInt16LE(magic, optional);
  image.writeUInt32LE(16, optional + directories - 4);
  if (signed) {
    image.writeUInt32LE(0x600, optional + directories + 4 * 8); // a file offset, not an RVA
    image.writeUInt32LE(8, optional + directories + 4 * 8 + 4);
  }
  if (clrFlags !== undefined) {
    image.writeUInt32LE(0x2008, optional + directories + 14 * 8);
    image.writeUInt32LE(72, optional + directories + 14 * 8 + 4);
  }
  const section = optional + optionalSize;
  image.write('.text', section, 'latin1');
  image.writeUInt32LE(0x1000, section + 8); // virtual size
  image.writeUInt32LE(0x2000, section + 12); // virtual address
  image.writeUInt32LE(0x200, section + 16); // raw size
  image.writeUInt32LE(0x400, section + 20); // raw pointer
  if (clrFlags !== undefined) {
    image.writeUInt32LE(72, 0x408);
    image.writeUInt32LE(clrFlags, 0x408 + 16);
  }
  return image;
}

let counter = 0;
function file(contents: Buffer | string): string {
  const path = join(temp, `image-${counter++}.exe`);
  writeFileSync(path, contents);
  return path;
}

describe('peMachine', () => {
  it('reads the COFF machine through e_lfanew', () => {
    expect(peMachine(file(syntheticPe({ machine: 0x8664 })))).toBe('x64');
    expect(peMachine(file(syntheticPe({ machine: 0xaa64 })))).toBe('arm64');
    expect(peMachine(file(syntheticPe({ machine: 0x14c, magic: 0x10b })))).toBe('x86');
    // ARM64EC and 32-bit Arm are architectures Puddle never ships.
    expect(peMachine(file(syntheticPe({ machine: 0xa641 })))).toBeNull();
    expect(peMachine(file(syntheticPe({ machine: 0x1c4 })))).toBeNull();
  });

  it('treats an IL-only image without a 32-bit requirement as AnyCPU', () => {
    expect(peMachine(file(syntheticPe({ machine: 0x14c, magic: 0x10b, clrFlags: 0x1 })))).toBe(
      'anycpu',
    );
    // 32BITREQUIRED and 32BITPREFERRED both keep the image x86.
    expect(peMachine(file(syntheticPe({ machine: 0x14c, magic: 0x10b, clrFlags: 0x3 })))).toBe(
      'x86',
    );
    expect(peMachine(file(syntheticPe({ machine: 0x14c, magic: 0x10b, clrFlags: 0x20001 })))).toBe(
      'x86',
    );
    // Mixed-mode (not IL-only) assemblies are native code.
    expect(peMachine(file(syntheticPe({ machine: 0x14c, magic: 0x10b, clrFlags: 0 })))).toBe('x86');
  });

  it('reports whether a certificate table is present', () => {
    expect(peImage(file(syntheticPe({ machine: 0x8664, signed: true })))).toEqual({
      machine: 'x64',
      signed: true,
    });
    expect(peImage(file(syntheticPe({ machine: 0xaa64 })))).toEqual({
      machine: 'arm64',
      signed: false,
    });
  });

  it('returns null for anything that is not a PE image', () => {
    expect(peMachine(file('#!/bin/sh\necho not a PE file\n'))).toBeNull();
    expect(peMachine(file(syntheticPe({ machine: 0x8664 }).subarray(0, 0x90)))).toBeNull();
    const dosOnly = syntheticPe({ machine: 0x8664 });
    dosOnly.write('NE', 0x80, 'latin1');
    expect(peMachine(file(dosOnly))).toBeNull();
    expect(peMachine(join(temp, 'missing.exe'))).toBeNull();
    expect(peImage(temp)).toBeNull(); // a directory
  });

  it('returns null for an optional header too short to hold its data directories', () => {
    // SizeOfOptionalHeader ends before NumberOfRvaAndSizes (offset 108 or 92).
    for (const [magic, sizes] of [
      [0x20b, [2, 108, 111]],
      [0x10b, [2, 92, 95]],
    ] as const) {
      for (const size of sizes) {
        const image = syntheticPe({ machine: 0x8664, magic });
        image.writeUInt16LE(size, 0x80 + 20);
        expect(peImage(file(image))).toBeNull();
      }
    }
    // Just long enough for the count but no directory: a machine, unsigned.
    const bare = syntheticPe({ machine: 0x8664 });
    bare.writeUInt16LE(112, 0x80 + 20);
    expect(peImage(file(bare))).toEqual({ machine: 'x64', signed: false });
  });

  it.runIf(process.platform === 'win32')(
    'reads the running node.exe as its own architecture',
    () => {
      expect(peMachine(process.execPath)).toBe(process.arch);
    },
  );
});

describe('windowsHostArch', () => {
  const registry = (value: string) =>
    `\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment\r\n    PROCESSOR_ARCHITECTURE    REG_SZ    ${value}\r\n\r\n`;

  it('answers an arm64 process without asking the registry', async () => {
    let asked = 0;
    const query = () => {
      asked++;
      return Promise.resolve(registry('AMD64'));
    };
    await expect(windowsHostArch({ platform: 'win32', arch: 'arm64', query })).resolves.toBe(
      'arm64',
    );
    expect(asked).toBe(0);
  });

  it('takes the machine-wide value over the (possibly emulated) process', async () => {
    await expect(
      windowsHostArch({
        platform: 'win32',
        arch: 'x64',
        env: { PROCESSOR_ARCHITECTURE: 'AMD64' },
        query: () => Promise.resolve(registry('ARM64')),
      }),
    ).resolves.toBe('arm64');
    await expect(
      windowsHostArch({
        platform: 'win32',
        arch: 'x64',
        query: () => Promise.resolve(registry('AMD64')),
      }),
    ).resolves.toBe('x64');
    // A 32-bit process on x64 Windows.
    await expect(
      windowsHostArch({
        platform: 'win32',
        arch: 'ia32',
        env: { PROCESSOR_ARCHITECTURE: 'x86', PROCESSOR_ARCHITEW6432: 'AMD64' },
        query: () => Promise.resolve(registry('AMD64')),
      }),
    ).resolves.toBe('x64');
    await expect(
      windowsHostArch({
        platform: 'win32',
        arch: 'x64',
        query: () => Promise.resolve(registry('IA64')),
      }),
    ).resolves.toBe('ia64');
  });

  it('falls back to the environment when reg.exe fails', async () => {
    await expect(
      windowsHostArch({
        platform: 'win32',
        arch: 'ia32',
        env: { PROCESSOR_ARCHITECTURE: 'x86', processor_architew6432: 'ARM64' },
        query: () => Promise.reject(new Error('blocked by policy')),
      }),
    ).resolves.toBe('arm64');
    await expect(
      windowsHostArch({
        platform: 'win32',
        arch: 'x64',
        env: { PROCESSOR_ARCHITECTURE: 'AMD64' },
        query: () => Promise.resolve('ERROR: The system was unable to find the specified value'),
      }),
    ).resolves.toBe('x64');
    await expect(
      windowsHostArch({
        platform: 'win32',
        arch: 'x64',
        env: {},
        query: () => Promise.reject(new Error('blocked by policy')),
      }),
    ).resolves.toBe('x64');
  });

  it('asks once per process', async () => {
    let asked = 0;
    const query = () => {
      asked++;
      return Promise.resolve(registry('ARM64'));
    };
    const options = { platform: 'win32' as const, arch: 'x64', query };
    await expect(windowsHostArch(options)).resolves.toBe('arm64');
    await expect(windowsHostArch(options)).resolves.toBe('arm64');
    expect(asked).toBe(1);
  });

  it('is the process architecture on POSIX', async () => {
    const query = () => Promise.reject(new Error('never asked'));
    await expect(windowsHostArch({ platform: 'linux', arch: 'x64', query })).resolves.toBe('x64');
    await expect(windowsHostArch({ platform: 'darwin', arch: 'arm64', query })).resolves.toBe(
      'arm64',
    );
  });

  it('maps processor names and recognises published architectures', () => {
    expect(windowsArchFromProcessor('AMD64')).toBe('x64');
    expect(windowsArchFromProcessor('arm64 ')).toBe('arm64');
    expect(windowsArchFromProcessor('x86')).toBe('x86');
    expect(isWindowsArch('x64')).toBe(true);
    expect(isWindowsArch('arm64')).toBe(true);
    expect(isWindowsArch('ia32')).toBe(false);
  });

  it.runIf(process.platform === 'win32')('reads this machine from the registry', async () => {
    const arch = await windowsHostArch();
    expect(isWindowsArch(arch)).toBe(true);
    // An arm64 process is native; an x64 one may be native or emulated.
    if (process.arch === 'arm64') expect(arch).toBe('arm64');
  });
});
