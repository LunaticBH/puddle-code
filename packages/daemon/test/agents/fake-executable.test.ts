import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findExecutable, resolveSpawn, setEnv } from '@puddle/shared/node/platform';
import { clearBinaryCache, resolveBinary } from '../../src/agents/binary.js';
import { writeFakeExecutable } from '../helpers/fake-executable.js';

const temporary: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
  clearBinaryCache();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('writeFakeExecutable', () => {
  it('writes a command that resolves by name and runs through resolveSpawn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-fake-bin-'));
    temporary.push(dir);
    const launcher = writeFakeExecutable(
      dir,
      'fake-agent',
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    );
    const path = [dir, dirname(process.execPath)].join(delimiter);
    expect(findExecutable('fake-agent', { path })).toBe(launcher);

    const env = { ...process.env };
    setEnv(env, 'PATH', path);
    const spawn = resolveSpawn('fake-agent', ['one', 'two words', '100%'], { env });
    if (process.platform === 'win32') {
      // The npm shim is unwrapped, so even `%` never reaches cmd.exe.
      expect(spawn.file.toLowerCase().endsWith('node.exe')).toBe(true);
      expect(spawn.args[0]).toBe(join(dir, 'fake-agent.mjs'));
    } else {
      expect(spawn).toEqual({ file: 'fake-agent', args: ['one', 'two words', '100%'] });
    }
    const result = spawnSync(spawn.file, spawn.args, { env, encoding: 'utf8', windowsHide: true });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(['one', 'two words', '100%']);

    // The daemon's agent lookup sees the same launcher.
    process.env.PATH = path;
    expect(resolveBinary('fake-agent')).toBe(launcher);
  });
});
