import { open } from 'node:fs/promises';

/**
 * The PE subsystem of a Windows image (docs/windows.md, decision 8): what
 * tells a GUI programme, which Puddle never ends when it stops a process
 * tree, from a console one. Import through `@puddle/shared/node/platform`.
 */

/** IMAGE_SUBSYSTEM_WINDOWS_GUI and IMAGE_SUBSYSTEM_WINDOWS_CE_GUI. */
const GUI_SUBSYSTEMS: ReadonlySet<number> = new Set([2, 9]);

/** Whether a PE subsystem is a GUI one; false for console, native and unknown images. */
export function isGuiSubsystem(subsystem: number | null): boolean {
  return subsystem !== null && GUI_SUBSYSTEMS.has(subsystem);
}

/**
 * The subsystem field of the PE image at `file` (2 for a GUI programme, 3
 * for a console one), read through the DOS header's `e_lfanew`: the
 * optional header's Subsystem sits 68 bytes in, for PE32 and PE32+ alike.
 * Null when the file cannot be read or is no PE image.
 */
export async function readPeSubsystem(file: string): Promise<number | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const read = async (position: number, length: number): Promise<Buffer | null> => {
      const buffer = Buffer.alloc(length);
      try {
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        return bytesRead === length ? buffer : null;
      } catch {
        return null; // a directory, or a file that cannot be read
      }
    };
    const dos = await read(0, 0x40);
    if (dos === null || dos.toString('latin1', 0, 2) !== 'MZ') return null;
    const header = dos.readUInt32LE(0x3c);
    // Signature, the 20-byte COFF header, then the optional header up to Subsystem.
    const pe = await read(header, 4 + 20 + 70);
    if (pe === null || pe.toString('latin1', 0, 4) !== 'PE\0\0') return null;
    if (pe.readUInt16LE(20) < 70) return null; // an optional header too short to hold it
    const magic = pe.readUInt16LE(24);
    if (magic !== 0x10b && magic !== 0x20b) return null;
    return pe.readUInt16LE(24 + 68);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** How many images' subsystems are remembered before the cache starts again. */
const CACHE_LIMIT = 1024;
const cache = new Map<string, Promise<number | null>>();

/**
 * readPeSubsystem, remembered per path (case-insensitively, as Windows
 * compares paths) for this process's life: a programme's image does not
 * change while it runs. An unreadable image is not remembered.
 */
export function peSubsystem(file: string): Promise<number | null> {
  const key = file.toLowerCase();
  const known = cache.get(key);
  if (known) return known;
  if (cache.size >= CACHE_LIMIT) cache.clear();
  const read = readPeSubsystem(file);
  cache.set(key, read);
  void read.then((subsystem) => {
    if (subsystem === null && cache.get(key) === read) cache.delete(key);
  });
  return read;
}
