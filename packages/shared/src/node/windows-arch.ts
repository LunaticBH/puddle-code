import { execFile } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import { getEnv, system32Path, type Environment } from './environment.js';

/**
 * Windows architectures (docs/windows.md, decision 5). A release asset's
 * architecture is the OPERATING SYSTEM's, never the process's: Windows 11 on
 * Arm runs an x64 Node or Electron under emulation, and that process must
 * still choose the native arm64 build.
 */
export type WindowsArch = 'x64' | 'arm64';

/** A PE image's COFF machine, with IL-only .NET images that run natively anywhere as `anycpu`. */
export type PeMachine = WindowsArch | 'x86' | 'anycpu';

export interface PeImage {
  /** Null for a machine type Puddle never ships (ARM64EC, 32-bit Arm, Itanium…). */
  machine: PeMachine | null;
  /** The image carries an Authenticode certificate table (valid or not). */
  signed: boolean;
}

const MACHINES: Readonly<Record<number, PeMachine>> = {
  0x8664: 'x64',
  0xaa64: 'arm64',
  0x14c: 'x86',
};
/** COMIMAGE_FLAGS_ILONLY, _32BITREQUIRED and _32BITPREFERRED in the CLR header. */
const IL_ONLY = 0x1;
const REQUIRES_32_BIT = 0x2;
const PREFERS_32_BIT = 0x20000;
/** The data directories that matter here: the certificate table and the CLR header. */
const SECURITY_DIRECTORY = 4;
const CLR_DIRECTORY = 14;

/**
 * The machine type and signature presence of a PE file, read through the DOS
 * header's `e_lfanew`, or null when `file` is unreadable or not a PE image.
 */
export function peImage(file: string): PeImage | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const read = (position: number, length: number): Buffer | null => {
      const buffer = Buffer.alloc(length);
      try {
        return readSync(fd, buffer, 0, length, position) === length ? buffer : null;
      } catch {
        return null; // a directory, or a file that cannot be read
      }
    };
    const dos = read(0, 0x40);
    if (dos === null || dos.toString('latin1', 0, 2) !== 'MZ') return null;
    const header = dos.readUInt32LE(0x3c);
    // Signature, the 20-byte COFF header and the optional header's magic.
    const coff = read(header, 4 + 20 + 2);
    if (coff === null || coff.toString('latin1', 0, 4) !== 'PE\0\0') return null;
    const rawMachine = coff.readUInt16LE(4);
    const sections = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    const optionalStart = header + 24;
    const optional = read(optionalStart, optionalSize);
    if (optional === null || optionalSize < 2) return null;
    const magic = optional.readUInt16LE(0);
    // PE32 and PE32+ differ in where the data directories start; an optional
    // header that ends before them (NumberOfRvaAndSizes included) is malformed.
    const directories = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
    if (directories < 0 || optionalSize < directories) return null;
    const count = optional.readUInt32LE(directories - 4);
    const directory = (index: number): { address: number; size: number } | null => {
      const at = directories + index * 8;
      if (index >= count || at + 8 > optional.length) return null;
      return { address: optional.readUInt32LE(at), size: optional.readUInt32LE(at + 4) };
    };
    const security = directory(SECURITY_DIRECTORY);
    const signed = security !== null && security.address !== 0 && security.size !== 0;
    let machine = MACHINES[rawMachine] ?? null;
    const clr = directory(CLR_DIRECTORY);
    if (machine === 'x86' && clr !== null && clr.address !== 0) {
      const flags = clrFlags(read, optionalStart + optionalSize, sections, clr.address);
      if (
        flags !== null &&
        (flags & IL_ONLY) !== 0 &&
        (flags & (REQUIRES_32_BIT | PREFERS_32_BIT)) === 0
      ) {
        machine = 'anycpu';
      }
    }
    return { machine, signed };
  } finally {
    closeSync(fd);
  }
}

/** The CLR header's Flags, found by mapping its RVA through the section table. */
function clrFlags(
  read: (position: number, length: number) => Buffer | null,
  sectionTable: number,
  sections: number,
  rva: number,
): number | null {
  for (let i = 0; i < sections; i++) {
    const section = read(sectionTable + i * 40, 40);
    if (section === null) return null;
    const virtualSize = section.readUInt32LE(8);
    const virtualAddress = section.readUInt32LE(12);
    const rawSize = section.readUInt32LE(16);
    const rawPointer = section.readUInt32LE(20);
    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, rawSize)) {
      // IMAGE_COR20_HEADER: cb, runtime version, metadata directory, then Flags.
      const flags = read(rawPointer + (rva - virtualAddress) + 16, 4);
      return flags === null ? null : flags.readUInt32LE(0);
    }
  }
  return null;
}

/** The COFF machine of a PE file (x64, arm64, x86 or IL-only `anycpu`), or null. */
export function peMachine(file: string): PeMachine | null {
  return peImage(file)?.machine ?? null;
}

/** Whether an architecture name is one Puddle publishes Windows builds for. */
export function isWindowsArch(value: string): value is WindowsArch {
  return value === 'x64' || value === 'arm64';
}

/** `AMD64` → x64 and `ARM64` → arm64; anything else stays as lower-case text a caller can refuse. */
export function windowsArchFromProcessor(value: string): string {
  const normalised = value.trim().toUpperCase();
  if (normalised === 'AMD64' || normalised === 'X64') return 'x64';
  if (normalised === 'ARM64') return 'arm64';
  return normalised.toLowerCase();
}

export interface WindowsHostArchOptions {
  /** The running process's architecture (defaults to `process.arch`). */
  arch?: string;
  platform?: NodeJS.Platform;
  env?: Environment;
  /**
   * Reads the system's PROCESSOR_ARCHITECTURE (resolving to `reg.exe query`'s
   * output by default); injectable so tests never depend on the host. Results
   * are memoised per query function.
   */
  query?: (env: Environment) => Promise<string>;
}

const REGISTRY_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

/** `reg.exe query` of the machine-wide PROCESSOR_ARCHITECTURE, a native System32 tool. */
function queryRegistry(env: Environment): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      system32Path('reg.exe', env),
      ['query', REGISTRY_KEY, '/v', 'PROCESSOR_ARCHITECTURE'],
      { windowsHide: true, timeout: 10_000, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

const memo = new WeakMap<(env: Environment) => Promise<string>, Promise<string>>();

/**
 * This Windows machine's architecture, whatever the running process is.
 *
 * An arm64 process can only be on arm64 Windows, so it answers at once.
 * Otherwise the registry's machine-wide PROCESSOR_ARCHITECTURE answers once
 * per process: x64 emulation on Arm redirects no registry key and WOW64 never
 * redirects HKLM\SYSTEM, so an emulated x64 or a 32-bit process still reads
 * the true value. `os.machine()` cannot answer this (libuv asks
 * GetSystemInfo, which reports the emulated architecture), nor can
 * GetNativeSystemInfo (AMD64 for x64 on Arm) or .NET's OSArchitecture before
 * .NET 7. If reg.exe fails, the process environment
 * (PROCESSOR_ARCHITEW6432, then PROCESSOR_ARCHITECTURE) is the fallback,
 * which an emulated x64 process reports as AMD64.
 *
 * Returns `x64` or `arm64`, or another lower-case architecture name for the
 * caller to refuse. On POSIX it is the process architecture.
 */
export function windowsHostArch(opts: WindowsHostArchOptions = {}): Promise<string> {
  const arch = opts.arch ?? process.arch;
  if ((opts.platform ?? process.platform) !== 'win32' || arch === 'arm64') {
    return Promise.resolve(arch);
  }
  const env = opts.env ?? process.env;
  const query = opts.query ?? queryRegistry;
  let answer = memo.get(query);
  if (answer === undefined) {
    answer = query(env)
      .then((output) => {
        const value = /PROCESSOR_ARCHITECTURE\s+REG_(?:EXPAND_)?SZ\s+(\S+)/i.exec(output)?.[1];
        if (value === undefined) throw new Error('reg.exe printed no PROCESSOR_ARCHITECTURE');
        return windowsArchFromProcessor(value);
      })
      .catch(() => {
        const fallback =
          getEnv(env, 'PROCESSOR_ARCHITEW6432', 'win32') ??
          getEnv(env, 'PROCESSOR_ARCHITECTURE', 'win32');
        return fallback === undefined || fallback === ''
          ? arch
          : windowsArchFromProcessor(fallback);
      });
    memo.set(query, answer);
  }
  return answer;
}
