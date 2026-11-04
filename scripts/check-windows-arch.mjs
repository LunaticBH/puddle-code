#!/usr/bin/env node
/**
 * Rejects a Windows release tree holding a PE file (.exe, .dll, .node) built
 * for another architecture than the one named: one x64 binary in an arm64
 * tree would run emulated, or fail to load into a native process. IL-only
 * AnyCPU images pass for both. Run against electron-builder's unpacked app in
 * the release workflow; the archive builders check their own stages.
 *
 *   node scripts/check-windows-arch.mjs <directory> <x64|arm64> [--except <relative/path>]...
 */
import { resolve } from 'node:path';
import { assertWindowsTreeArch } from './lib/node-runtime.mjs';

const [dir, arch, ...rest] = process.argv.slice(2);
if (dir === undefined || arch === undefined) {
  console.error('usage: check-windows-arch.mjs <directory> <x64|arm64> [--except <path>]...');
  process.exit(2);
}
const except = rest.flatMap((value, i) => (rest[i - 1] === '--except' ? [value] : []));
try {
  const checked = assertWindowsTreeArch(resolve(dir), arch, { except });
  if (checked === 0) throw new Error(`no PE files below ${dir}`);
  console.log(`check-windows-arch: ${checked} PE files below ${dir} are ${arch}`);
} catch (e) {
  console.error(`check-windows-arch: ${e.message}`);
  process.exit(1);
}
