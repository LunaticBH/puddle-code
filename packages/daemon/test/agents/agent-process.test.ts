import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentEnv, agentSpawnSpec, execAgent } from '../../src/agents/agent-process.js';
import { writeFakeExecutable } from '../helpers/fake-executable.js';

/** The launcher npm's cmd-shim writes, in the form `resolveSpawn` unwraps. */
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\agent.mjs" %*',
  '',
].join('\r\n');

describe('agent process spawning', () => {
  it('passes the name and options through untouched on POSIX', () => {
    const options = { env: { PATH: '/nowhere' }, timeout: 5 };
    const spec = agentSpawnSpec('claude', ['auth', 'status'], options, 'linux');
    expect(spec).toEqual({ file: 'claude', args: ['auth', 'status'], options });
    expect(spec.options).toBe(options);
  });

  it('refuses a Windows name that is not on PATH instead of searching the cwd', () => {
    expect(() => agentSpawnSpec('puddle-absent-agent', [], { env: { PATH: '' } }, 'win32')).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('unwraps an npm shim into node and its script, with the window hidden, on Windows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-shim-'));
    writeFileSync(join(dir, 'codex.cmd'), NPM_SHIM);
    writeFileSync(join(dir, 'agent.mjs'), '');
    writeFileSync(join(dir, 'node.exe'), ''); // the shim prefers a node beside it
    const spec = agentSpawnSpec('codex', ['login', 'status'], { env: { PATH: dir } }, 'win32');
    expect(spec.file).toBe(join(dir, 'node.exe'));
    expect(spec.args).toEqual([join(dir, 'agent.mjs'), 'login', 'status']);
    expect(spec.options.windowsHide).toBe(true);
    expect(spec.options.windowsVerbatimArguments).toBeUndefined();
  });

  it('runs an installed agent CLI by name and returns its output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-agent-bin-'));
    writeFakeExecutable(
      dir,
      'puddle-fake-cli',
      'process.stdout.write(`v1.2.3 ${process.argv.slice(2).join(",")}`);',
    );
    const PATH = [dir, dirname(process.execPath)].join(delimiter);
    const { stdout } = await execAgent('puddle-fake-cli', ['--version', 'a b'], {
      env: agentEnv({ PATH }),
    });
    expect(stdout).toBe('v1.2.3 --version,a b');
  });

  it('merges overrides into a copied environment without duplicate Windows keys', () => {
    expect(agentEnv({ CODEX_HOME: '/cfg' }, 'linux', { Path: 'p', CODEX_HOME: 'old' })).toEqual({
      Path: 'p',
      CODEX_HOME: '/cfg',
    });
    expect(
      agentEnv({ PATH: 'new', CODEX_HOME: 'c' }, 'win32', { Path: 'old', codex_home: 'x' }),
    ).toEqual({ Path: 'new', codex_home: 'c' });
  });
});
