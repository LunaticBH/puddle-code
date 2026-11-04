import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  quoteCmdArgument,
  resolveSpawn,
  UnsafeCmdArgumentError,
  type ResolvedSpawn,
} from '../src/node/platform.js';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-spawn-'));
  temporary.push(dir);
  return dir;
}

/** npm cmd-shim 6/7 output, as `npm install -g` writes it (CRLF). */
const NPM_SHIM = (target: string, flags = '') =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${flags} "%dp0%\\${target}" %*`,
    '',
  ].join('\r\n');

/** pnpm (@zkochan/cmd-shim) output, NODE_PATH included. */
const PNPM_SHIM = (target: string, nodePath: string) =>
  [
    '@SETLOCAL',
    '@IF NOT DEFINED NODE_PATH (',
    `  @SET "NODE_PATH=${nodePath}"`,
    ') ELSE (',
    `  @SET "NODE_PATH=${nodePath};%NODE_PATH%"`,
    ')',
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ') ELSE (',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${target}" %*`,
    ')',
    '',
  ].join('\r\n');

/** The older npm form, which Yarn 1's global bin also writes. */
const LEGACY_SHIM = (target: string) =>
  [
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
    ') ELSE (',
    '  @SETLOCAL',
    '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
    `  node  "%~dp0\\${target}" %*`,
    ')',
  ].join('\r\n');

/** A directory holding a stand-in node.exe, for PATH-based fallbacks. */
function nodeOnPath(): string {
  const dir = directory();
  writeFileSync(join(dir, 'node.exe'), '');
  return dir;
}

describe('resolveSpawn on POSIX', () => {
  it('is the identity, whatever the file', () => {
    const args = ['a b', '%PATH%', '"quoted"', 'line\nbreak'];
    expect(resolveSpawn('tool.cmd', args, { platform: 'linux' })).toEqual({
      file: 'tool.cmd',
      args,
    });
    expect(resolveSpawn('/usr/bin/env', [], { platform: 'darwin' })).toEqual({
      file: '/usr/bin/env',
      args: [],
    });
  });
});

describe('resolveSpawn on Windows', () => {
  const windows = (file: string, args: string[], env: Record<string, string>): ResolvedSpawn =>
    resolveSpawn(file, args, { platform: 'win32', env });

  it('spawns executables directly, resolved through PATHEXT', () => {
    const bin = directory();
    writeFileSync(join(bin, 'tool.exe'), '');
    const env = { Path: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(windows('tool', ['x'], env)).toEqual({ file: join(bin, 'tool.exe'), args: ['x'] });
    // Unresolvable names are passed through for spawn to report.
    expect(windows('missing', [], env)).toEqual({ file: 'missing', args: [] });
  });

  it('unwraps an npm cmd-shim into node and its script', () => {
    const bin = directory();
    writeFileSync(join(bin, 'agent.cmd'), NPM_SHIM('node_modules\\agent\\cli.js'));
    const nodeDir = nodeOnPath();
    const env = { PATH: `${bin};${nodeDir}` };
    expect(windows('agent', ['--flag', 'a b'], env)).toEqual({
      file: join(nodeDir, 'node.exe'),
      args: [join(bin, 'node_modules', 'agent', 'cli.js'), '--flag', 'a b'],
    });
    // A node.exe beside the shim wins, as the shim's own IF EXIST would choose.
    writeFileSync(join(bin, 'node.exe'), '');
    expect(windows('agent', [], env).file).toBe(join(bin, 'node.exe'));
  });

  it('runs a shim through strict cmd.exe quoting when its node is a batch file', () => {
    // npm's %APPDATA%\npm layout (no node.exe beside the shim) behind a
    // version manager's node.cmd that comes before node.exe on PATH.
    const bin = directory();
    writeFileSync(join(bin, 'agent.cmd'), NPM_SHIM('node_modules\\agent\\cli.js'));
    const shims = directory();
    writeFileSync(join(shims, 'node.cmd'), '@"C:\\nodejs\\node.exe" %*\r\n');
    const nodeDir = nodeOnPath();
    const env = {
      PATH: `${bin};${shims};${nodeDir}`,
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    };
    expect(windows('agent', ['fix x'], env)).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', `""${join(bin, 'agent.cmd')}" "fix x""`],
      windowsVerbatimArguments: true,
    });
    // An argument that would break out of node.cmd's implicit cmd.exe is refused.
    expect(() => windows('agent', ['fix "x & calc"'], env)).toThrow(UnsafeCmdArgumentError);
    expect(() => windows('agent', ['%USERNAME%'], env)).toThrow(UnsafeCmdArgumentError);
  });

  it('looks up the shim’s node without .JS, as the shim’s SET PATHEXT does', () => {
    const bin = directory();
    writeFileSync(join(bin, 'agent.cmd'), NPM_SHIM('node_modules\\agent\\cli.js'));
    const scripts = directory();
    writeFileSync(join(scripts, 'node.js'), '');
    const nodeDir = nodeOnPath();
    const env = { PATH: `${bin};${scripts};${nodeDir}`, PATHEXT: '.COM;.EXE;.BAT;.CMD;.JS' };
    expect(windows('agent', ['x'], env)).toEqual({
      file: join(nodeDir, 'node.exe'),
      args: [join(bin, 'node_modules', 'agent', 'cli.js'), 'x'],
    });
  });

  it('keeps shebang flags and arguments cmd.exe could not carry', () => {
    const bin = directory();
    writeFileSync(join(bin, 'node.exe'), '');
    writeFileSync(join(bin, 'tool.cmd'), NPM_SHIM('node_modules\\tool\\bin.mjs', '--no-warnings'));
    const args = ['100%', 'bang!', 'say "hi"', 'two\nlines'];
    expect(windows(join(bin, 'tool.cmd'), args, {})).toEqual({
      file: join(bin, 'node.exe'),
      args: ['--no-warnings', join(bin, 'node_modules', 'tool', 'bin.mjs'), ...args],
    });
  });

  it('unwraps a pnpm shim and carries its NODE_PATH', () => {
    const bin = directory();
    writeFileSync(
      join(bin, 'tool.CMD'),
      PNPM_SHIM('..\\tool\\bin\\tool.js', 'C:\\store\\a;C:\\store\\b'),
    );
    const nodeDir = nodeOnPath();
    const fresh = windows(join(bin, 'tool.CMD'), [], { PATH: nodeDir });
    expect(fresh).toEqual({
      file: join(nodeDir, 'node.exe'),
      args: [resolve(bin, '..', 'tool', 'bin', 'tool.js')],
      env: { NODE_PATH: 'C:\\store\\a;C:\\store\\b' },
    });
    const inherited = windows(join(bin, 'tool.CMD'), [], { PATH: nodeDir, node_path: 'C:\\mine' });
    expect(inherited.env).toEqual({ NODE_PATH: 'C:\\store\\a;C:\\store\\b;C:\\mine' });
  });

  it('unwraps the legacy npm and Yarn form', () => {
    const bin = directory();
    writeFileSync(join(bin, 'yarnish.cmd'), LEGACY_SHIM('node_modules\\pkg\\cli.js'));
    writeFileSync(join(bin, 'node.exe'), '');
    expect(windows(join(bin, 'yarnish.cmd'), ['x'], {})).toEqual({
      file: join(bin, 'node.exe'),
      args: [join(bin, 'node_modules', 'pkg', 'cli.js'), 'x'],
    });
  });

  it('runs shims for other interpreters, and edited shims, through cmd.exe', () => {
    const bin = directory();
    writeFileSync(join(bin, 'node.exe'), '');
    const sh = NPM_SHIM('x.sh').replace('_prog=%dp0%\\node.exe', '_prog=%dp0%\\sh.exe');
    const edited = NPM_SHIM('x.js').replace(':start', ':start\r\nSET SECRET=1');
    const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' };
    for (const [name, text] of [
      ['sh.cmd', sh],
      ['edited.cmd', edited],
      ['plain.bat', '@echo off\r\necho hi %*\r\n'],
    ] as const) {
      writeFileSync(join(bin, name), text);
      const spawn = windows(join(bin, name), ['a'], env);
      expect(spawn.file, name).toBe('C:\\Windows\\System32\\cmd.exe');
      expect(spawn.windowsVerbatimArguments).toBe(true);
      expect(spawn.args).toEqual(['/d', '/s', '/c', `""${join(bin, name)}" a"`]);
    }
  });

  it('refuses arguments cmd.exe cannot carry, naming the position', () => {
    const bin = directory();
    writeFileSync(join(bin, 'plain.bat'), '@echo off\r\n');
    for (const [arg, reason] of [
      ['%PATH%', "'%'"],
      ['wow!', "'!'"],
      ['say "hi"', `'"'`],
      ['a\nb', 'U+000A'],
      ['a\rb', 'U+000D'],
      ['a\0b', 'U+0000'],
      ['bell\x07', 'U+0007'],
    ] as const) {
      let error: unknown;
      try {
        windows(join(bin, 'plain.bat'), ['fine', arg], {});
      } catch (err) {
        error = err;
      }
      expect(error, JSON.stringify(arg)).toBeInstanceOf(UnsafeCmdArgumentError);
      expect((error as UnsafeCmdArgumentError).position).toBe(1);
      expect((error as UnsafeCmdArgumentError).code).toBe('unsafe_cmd_argument');
      expect((error as Error).message).toContain('Argument 2');
      expect((error as Error).message).toContain(reason);
    }
    const odd = directory();
    mkdirSync(join(odd, '100%'));
    writeFileSync(join(odd, '100%', 'x.bat'), '@echo off\r\n');
    expect(() => windows(join(odd, '100%', 'x.bat'), [], {})).toThrow(/batch file path/);
  });
});

describe('quoteCmdArgument', () => {
  it.each([
    ['plain', 'plain'],
    ['C:\\dir\\file.txt', 'C:\\dir\\file.txt'],
    ['--flag=value', '"--flag=value"'],
    ['a b', '"a b"'],
    ['', '""'],
    ['tab\there', '"tab\there"'],
    ['a&b|c<d>e^f(g)', '"a&b|c<d>e^f(g)"'],
    ['semi;comma,', '"semi;comma,"'],
    ['C:\\dir\\', '"C:\\dir\\\\"'],
    ['C:\\with space\\\\', '"C:\\with space\\\\\\\\"'],
    ['unicodé', '"unicodé"'],
    ['*?@#$+-./:_', '*?@#$+-./:_'],
  ])('%j becomes %j', (arg, quoted) => {
    expect(quoteCmdArgument(arg)).toBe(quoted);
  });
});

describe.skipIf(process.platform !== 'win32')('resolveSpawn through the real cmd.exe', () => {
  it('delivers every accepted argument unchanged to a program behind %*', () => {
    const dir = directory();
    writeFileSync(join(dir, 'echo.cjs'), 'console.log(JSON.stringify(process.argv.slice(2)))');
    // Not a recognised shim (it sets a variable), so this runs through cmd.exe.
    writeFileSync(
      join(dir, 'forward.cmd'),
      `@echo off\r\nset PUDDLE_TEST=1\r\n"${process.execPath}" "%~dp0echo.cjs" %*\r\n`,
    );
    const args = [
      'plain',
      'a b',
      'tab\there',
      'amp&pipe|lt<gt>',
      'caret^',
      'paren()',
      'C:\\dir\\',
      'C:\\dir with space\\',
      '',
      'semi;comma,eq=',
      'unicodé ✓',
      'back\\slash\\in\\middle',
      '*?wild',
      '@at',
    ];
    const spawn = resolveSpawn(join(dir, 'forward.cmd'), args);
    expect(spawn.windowsVerbatimArguments).toBe(true);
    const result = spawnSync(spawn.file, spawn.args, {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });
});
