import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  imageSubsystem,
  isGuiSubsystem,
  peSubsystem,
  readPeSubsystem,
  system32Path,
  type WindowsProcess,
} from '../src/node/platform.js';

/**
 * PE subsystems (docs/windows.md, decision 8): what tells the GUI programmes
 * a Windows process-tree stop spares. Synthetic images run on any OS; the
 * last block reads Windows' own.
 */

const dir = mkdtempSync(join(tmpdir(), 'puddle-subsystem-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A minimal PE image: DOS header, signature, COFF header and an optional header. */
function image(name: string, subsystem: number, options: { magic?: number; size?: number } = {}) {
  const optionalSize = options.size ?? 240;
  const buffer = Buffer.alloc(0x40 + 24 + Math.max(optionalSize, 72));
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(0x40, 0x3c);
  buffer.write('PE\0\0', 0x40, 'latin1');
  buffer.writeUInt16LE(0x8664, 0x44);
  buffer.writeUInt16LE(optionalSize, 0x40 + 20);
  buffer.writeUInt16LE(options.magic ?? 0x20b, 0x40 + 24);
  buffer.writeUInt16LE(subsystem, 0x40 + 24 + 68);
  const file = join(dir, name);
  writeFileSync(file, buffer);
  return file;
}

describe('readPeSubsystem', () => {
  it('reads the subsystem of PE32+ and PE32 images', async () => {
    expect(await readPeSubsystem(image('gui.exe', 2))).toBe(2);
    expect(await readPeSubsystem(image('console.exe', 3))).toBe(3);
    expect(await readPeSubsystem(image('gui32.exe', 2, { magic: 0x10b, size: 224 }))).toBe(2);
  });

  it('is null for what is no PE image, or cannot be read', async () => {
    const text = join(dir, 'text.exe');
    writeFileSync(text, 'MZ but nothing after it');
    expect(await readPeSubsystem(text)).toBeNull();
    expect(await readPeSubsystem(join(dir, 'missing.exe'))).toBeNull();
    expect(await readPeSubsystem(dir)).toBeNull();
    expect(await readPeSubsystem(image('rom.exe', 2, { magic: 0x107 }))).toBeNull();
    expect(await readPeSubsystem(image('short.exe', 2, { size: 64 }))).toBeNull();
  });
});

describe('peSubsystem', () => {
  it('reads an image rebuilt at the same path again, though its size and mtime are kept', async () => {
    const file = image('rebuilt.exe', 3);
    const mtime = 1_700_000_000; // whole seconds, which every file system keeps exactly
    utimesSync(file, mtime, mtime);
    const before = statSync(file);
    expect(await peSubsystem(file)).toBe(3);
    expect(await peSubsystem(file)).toBe(3);
    // Past the file system's timestamp granularity, rebuilt as a GUI programme.
    await new Promise((resolve) => setTimeout(resolve, 50));
    image('rebuilt.exe', 2);
    utimesSync(file, mtime, mtime);
    expect(statSync(file).size).toBe(before.size);
    expect(statSync(file).mtimeMs).toBe(before.mtimeMs);
    expect(await peSubsystem(file)).toBe(2);
  });

  it('forgets an image it could not read', async () => {
    const file = join(dir, 'later.exe');
    expect(await peSubsystem(file)).toBeNull();
    image('later.exe', 3);
    expect(await peSubsystem(file)).toBe(3);
  });
});

describe('imageSubsystem', () => {
  const entry = (executablePath?: string | null): WindowsProcess => ({
    pid: 10,
    ppid: 1,
    name: 'x.exe',
    command: 'x',
    commandLine: null,
    createdAtMs: 1000,
    ...(executablePath !== undefined ? { executablePath } : {}),
  });

  it('reads the image the process table names, and nothing without one', async () => {
    expect(await imageSubsystem(entry(image('table.exe', 3)))).toBe(3);
    expect(await imageSubsystem(entry(null))).toBeNull();
    expect(await imageSubsystem(entry())).toBeNull();
  });
});

describe('isGuiSubsystem', () => {
  it('counts the Windows and Windows CE GUI subsystems only', () => {
    expect(isGuiSubsystem(2)).toBe(true);
    expect(isGuiSubsystem(9)).toBe(true);
    expect(isGuiSubsystem(3)).toBe(false);
    expect(isGuiSubsystem(1)).toBe(false);
    expect(isGuiSubsystem(null)).toBe(false);
  });
});

describe.runIf(process.platform === 'win32')('Windows images', () => {
  it('tells a GUI programme from a console one', async () => {
    expect(await peSubsystem(system32Path('notepad.exe'))).toBe(2);
    expect(await peSubsystem(system32Path('conhost.exe'))).toBe(2);
    expect(await peSubsystem(system32Path('cmd.exe'))).toBe(3);
    expect(await peSubsystem(process.execPath)).toBe(3);
  });
});
