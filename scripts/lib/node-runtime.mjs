import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
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
 * Node publishes Windows builds as `node-v<V>-win-<arch>.zip` with node.exe at
 * the top of the archive. Only node.exe ships, copied byte-for-byte so its
 * Authenticode signature stays valid.
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

  mkdirSync(join(stage, 'bin'), { recursive: true });
  cpSync(cachedNode, join(stage, 'bin', 'node.exe'));
  log(`staged node v${NODE_RUNTIME_VERSION} (${(statSync(cachedNode).size / 1e6).toFixed(0)} MB)`);
}
