import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Shared by the standalone CLI and daemon distributions. */
export const NODE_RUNTIME_VERSION = '22.21.1';
const fail = (message) => {
  throw new Error(message);
};

/** The staged runtime's path: Windows archives ship bin\node.exe. */
export function nodeBinary(stage, platform = process.platform) {
  return platform === 'win32' ? join(stage, 'bin', 'node.exe') : join(stage, 'bin', 'node');
}

/**
 * The archive builders' own tar. On Windows this is System32's bsdtar by
 * absolute path: Git Bash's GNU tar would read `C:\...` as host:path.
 */
export function archiveTool(platform = process.platform) {
  if (platform !== 'win32') return 'tar';
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

/** Fetch and cache the pinned runtime; ship only bin/node. */
export async function stageNodeRuntime(repoRoot, stage, target, log = console.log) {
  const cacheDir = join(repoRoot, 'node_modules', '.cache', 'puddle-node-runtime');
  if (target.startsWith('win32-')) return stageWindowsNodeRuntime(cacheDir, stage, target, log);
  const distName = `node-v${NODE_RUNTIME_VERSION}-${target}`;
  const cachedNode = join(cacheDir, distName, 'bin', 'node');

  if (!existsSync(cachedNode)) {
    mkdirSync(cacheDir, { recursive: true });
    const base = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}`;
    const tarName = `${distName}.tar.gz`;
    const tarPath = join(cacheDir, tarName);
    log(`downloading ${base}/${tarName}`);
    const res = await fetch(`${base}/${tarName}`);
    if (!res.ok || res.body === null) fail(`node download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tarPath));

    const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
    const expected = sums
      .split('\n')
      .find((line) => line.endsWith(`  ${tarName}`))
      ?.split(/\s+/)[0];
    if (expected === undefined) fail(`SHASUMS256.txt has no entry for ${tarName}`);
    const actual = createHash('sha256').update(readFileSync(tarPath)).digest('hex');
    if (actual !== expected) fail(`checksum mismatch for ${tarName}`);

    execFileSync('tar', ['-xzf', tarPath, '-C', cacheDir, `${distName}/bin/node`]);
    rmSync(tarPath);
  }

  mkdirSync(join(stage, 'bin'), { recursive: true });
  cpSync(cachedNode, join(stage, 'bin', 'node'));
  chmodSync(join(stage, 'bin', 'node'), 0o755);
  log(`staged node v${NODE_RUNTIME_VERSION} (${(statSync(cachedNode).size / 1e6).toFixed(0)} MB)`);
}

/**
 * Node publishes Windows builds as `node-v<V>-win-<arch>.zip` (win-x64 and
 * win-arm64 alike) with node.exe at the top of the archive. Only node.exe
 * ships, copied byte-for-byte so its Authenticode signature stays valid; its
 * PE machine type must be the requested architecture.
 */
async function stageWindowsNodeRuntime(cacheDir, stage, target, log) {
  const distName = `node-v${NODE_RUNTIME_VERSION}-${target.replace(/^win32-/, 'win-')}`;
  const cachedNode = join(cacheDir, distName, 'node.exe');

  if (!existsSync(cachedNode)) {
    mkdirSync(cacheDir, { recursive: true });
    const base = `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}`;
    const zipName = `${distName}.zip`;
    const zipPath = join(cacheDir, zipName);
    log(`downloading ${base}/${zipName}`);
    const res = await fetch(`${base}/${zipName}`);
    if (!res.ok || res.body === null) fail(`node download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));

    const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
    const expected = sums
      .split('\n')
      .find((line) => line.endsWith(`  ${zipName}`))
      ?.split(/\s+/)[0];
    if (expected === undefined) fail(`SHASUMS256.txt has no entry for ${zipName}`);
    const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
    if (actual !== expected) fail(`checksum mismatch for ${zipName}`);

    execFileSync(archiveTool('win32'), ['-xf', zipPath, '-C', cacheDir, `${distName}/node.exe`]);
    rmSync(zipPath);
  }

  const arch = target.replace(/^win32-/, '');
  const machine = peMachine(cachedNode);
  if (machine !== arch) fail(`${distName}/node.exe is ${machine ?? 'not a PE image'}, not ${arch}`);
  mkdirSync(join(stage, 'bin'), { recursive: true });
  cpSync(cachedNode, join(stage, 'bin', 'node.exe'));
  log(`staged node v${NODE_RUNTIME_VERSION} (${(statSync(cachedNode).size / 1e6).toFixed(0)} MB)`);
}

const MACHINES = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'x86' };

/**
 * The COFF machine of a PE file read through `e_lfanew` (x64, arm64, x86, or
 * `anycpu` for an IL-only .NET image without a 32-bit requirement), a
 * `machine 0x…` label for other machine types, or null for a file that is
 * not a PE image. Mirrors peImage in packages/shared/src/node/windows-arch.ts,
 * which these build scripts cannot import before the workspace is built.
 */
export function peMachine(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const read = (position, length) => {
      const buffer = Buffer.alloc(length);
      try {
        return readSync(fd, buffer, 0, length, position) === length ? buffer : null;
      } catch {
        return null;
      }
    };
    const dos = read(0, 0x40);
    if (dos === null || dos.toString('latin1', 0, 2) !== 'MZ') return null;
    const header = dos.readUInt32LE(0x3c);
    const coff = read(header, 26);
    if (coff === null || coff.toString('latin1', 0, 4) !== 'PE\0\0') return null;
    const raw = coff.readUInt16LE(4);
    const machine = MACHINES[raw] ?? `machine 0x${raw.toString(16).padStart(4, '0')}`;
    if (machine !== 'x86') return machine;
    // An IL-only image's CLR header (data directory 14) decides AnyCPU. An
    // optional header too short to hold that directory cannot name one.
    const sections = coff.readUInt16LE(6);
    const optionalSize = coff.readUInt16LE(20);
    if (optionalSize < 96 + 15 * 8) return machine;
    const optional = read(header + 24, optionalSize);
    if (optional === null || optional.readUInt16LE(0) !== 0x10b) return machine;
    if (optional.readUInt32LE(92) <= 14) return machine;
    const rva = optional.readUInt32LE(96 + 14 * 8);
    if (rva === 0) return machine;
    for (let i = 0; i < sections; i++) {
      const section = read(header + 24 + optionalSize + i * 40, 40);
      if (section === null) return machine;
      const virtualAddress = section.readUInt32LE(12);
      const span = Math.max(section.readUInt32LE(8), section.readUInt32LE(16));
      if (rva < virtualAddress || rva >= virtualAddress + span) continue;
      const flags = read(section.readUInt32LE(20) + (rva - virtualAddress) + 16, 4)?.readUInt32LE(
        0,
      );
      // ILONLY without 32BITREQUIRED or 32BITPREFERRED.
      return flags !== undefined && (flags & 0x1) !== 0 && (flags & 0x20002) === 0
        ? 'anycpu'
        : machine;
    }
    return machine;
  } finally {
    closeSync(fd);
  }
}

/**
 * Every .exe, .dll and .node under `dir` must be built for `arch` (IL-only
 * AnyCPU images run natively on both). One stray x64 binary in an arm64 tree
 * would run emulated, or fail to load into a native process. `except` lists
 * `/`-separated paths, relative to `dir`, that may differ (a 32-bit helper
 * that a third-party packager adds).
 */
export function assertWindowsTreeArch(dir, arch, { except = [] } = {}) {
  if (arch !== 'x64' && arch !== 'arm64') fail(`unknown Windows architecture ${arch}`);
  const offenders = [];
  let checked = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(exe|dll|node)$/i.test(entry.name)) continue;
      const name = relative(dir, path).replaceAll('\\', '/');
      if (except.includes(name)) continue;
      checked++;
      const machine = peMachine(path);
      if (machine !== arch && machine !== 'anycpu') {
        offenders.push(`${name} (${machine ?? 'not a PE image'})`);
      }
    }
  };
  walk(dir);
  if (offenders.length > 0) {
    fail(`${dir} is not a win32-${arch} tree:\n  ${offenders.join('\n  ')}`);
  }
  return checked;
}
