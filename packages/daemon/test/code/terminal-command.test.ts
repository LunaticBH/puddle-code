import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteEnv, system32Path, UnsafeCmdArgumentError } from '@puddle/shared/node/platform';
import {
  RUN_WRAPPER,
  terminalCommandArgs,
  terminalCommandSpawn,
  type RunWrapperPlan,
} from '../../src/sessions/terminal-command.js';
import { writeFakeExecutable } from '../helpers/fake-executable.js';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-run-wrapper-'));
  temporary.push(dir);
  return dir;
}

function planOf(args: string[]): RunWrapperPlan {
  expect(args.slice(0, 2)).toEqual(['-e', RUN_WRAPPER]);
  return JSON.parse(Buffer.from(args[2]!, 'base64').toString('utf8')) as RunWrapperPlan;
}

/** Runs the wrapper on pipes, as a PTY would on a console, and collects its output. */
function runWrapper(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const node = (source: string) => ({ file: process.execPath, args: ['-e', source] });

describe('one-shot terminal commands', () => {
  it('keeps the POSIX sh wrapper byte for byte', () => {
    const command = {
      cwd: '/repo',
      commands: [
        { file: '/usr/bin/cc', args: ['main file.c', '-o', '/run/programme'] },
        { file: '/run/programme', args: [] },
      ],
    };
    const spawned = terminalCommandSpawn(command, '/bin/bash', ['--rcfile', '/h/rc'], 'linux');
    expect(spawned).toEqual({
      file: '/bin/sh',
      args: terminalCommandArgs(command, '/bin/bash', ['--rcfile', '/h/rc']),
    });
    expect(spawned.args).toEqual([
      '-c',
      [
        String.raw`trap ':' INT`,
        String.raw`printf '%s\n' ''\''/usr/bin/cc'\'' '\''main file.c'\'' '\''-o'\'' '\''/run/programme'\'' && '\''/run/programme'\'''`,
        String.raw`/usr/bin/env -- '/usr/bin/cc' 'main file.c' '-o' '/run/programme' &&`,
        String.raw`/usr/bin/env -- '/run/programme'`,
        String.raw`_puddle_exit_status=$?`,
        String.raw`printf "\n[Process exited with status %s]\n" "$_puddle_exit_status"`,
        String.raw`trap - INT`,
        String.raw`exec '/bin/bash' '--rcfile' '/h/rc'`,
      ].join('\n'),
    ]);
  });

  it('runs Windows commands through the inline Node wrapper with a JSON plan', () => {
    const spawned = terminalCommandSpawn(
      {
        cwd: 'C:\\repo',
        env: { PATH: 'C:\\tools' },
        commands: [{ file: 'C:\\tools\\gcc.exe', args: ['C:\\repo\\main file.c', 'say "hi"'] }],
      },
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      [],
      'win32',
    );
    expect(spawned.file).toBe(process.execPath);
    // node-pty quotes the script as one argument only without these characters.
    expect(RUN_WRAPPER).not.toMatch(/["\\\n]/);
    expect(planOf(spawned.args)).toEqual({
      banner: 'C:\\tools\\gcc.exe "C:\\repo\\main file.c" "say \\"hi\\""',
      env: { PATH: 'C:\\tools' },
      commands: [{ file: 'C:\\tools\\gcc.exe', args: ['C:\\repo\\main file.c', 'say "hi"'] }],
      shell: { file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: [] },
    });
  });

  it('unwraps npm shims for Windows and refuses arguments cmd.exe cannot carry', () => {
    const bin = directory();
    writeFileSync(join(bin, 'node.exe'), '');
    writeFileSync(
      join(bin, 'tsx.cmd'),
      '@"%~dp0\\node.exe"  "%~dp0\\node_modules\\tsx\\dist\\cli.mjs" %*\r\n',
    );
    writeFileSync(join(bin, 'build.bat'), '@echo off\r\n');
    const shell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const run = (file: string, args: string[]) =>
      terminalCommandSpawn({ cwd: bin, commands: [{ file, args }] }, shell, [], 'win32');
    expect(planOf(run(join(bin, 'tsx.cmd'), ['100%']).args).commands).toEqual([
      {
        file: join(bin, 'node.exe'),
        args: [join(bin, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '100%'],
      },
    ]);
    expect(planOf(run(join(bin, 'build.bat'), ['main.c']).args).commands[0]).toMatchObject({
      args: ['/d', '/s', '/c', `""${join(bin, 'build.bat')}" main.c"`],
      verbatim: true,
    });
    expect(() => run(join(bin, 'build.bat'), ['100%'])).toThrow(UnsafeCmdArgumentError);
  });

  it('prints the command, stops at the first failure and exits with the shell status', async () => {
    const plan: RunWrapperPlan = {
      banner: 'first && second',
      env: { PUDDLE_WRAPPER_PROBE: 'override' },
      commands: [
        node('console.log("RAN", process.env.PUDDLE_WRAPPER_PROBE); process.exit(3)'),
        node('console.log("NEVER")'),
      ],
      shell: node('console.log("SHELL"); process.exit(7)'),
    };
    const result = await runWrapper(
      process.execPath,
      ['-e', RUN_WRAPPER, Buffer.from(JSON.stringify(plan)).toString('base64')],
      { ...process.env, PUDDLE_WRAPPER_PROBE: 'inherited' },
    );
    expect(result.stdout.replaceAll('\r\n', '\n')).toBe(
      'first && second\nRAN override\n\n[Process exited with status 3]\nSHELL\n',
    );
    expect(result.status).toBe(7);
  });

  it('reports a programme that cannot start as env(1) would', async () => {
    const plan: RunWrapperPlan = {
      banner: 'missing',
      env: {},
      commands: [{ file: join(directory(), 'missing.exe'), args: [] }],
      shell: node('process.exit(0)'),
    };
    const result = await runWrapper(process.execPath, [
      '-e',
      RUN_WRAPPER,
      Buffer.from(JSON.stringify(plan)).toString('base64'),
    ]);
    expect(result.stdout).toContain('[Process exited with status 127]');
    expect(result.stderr).toContain('missing.exe');
    expect(result.status).toBe(0);
  });

  it('never spawns a file that is not an absolute path, reporting it as env(1) would', async () => {
    const cwd = directory();
    // The daemon resolves explicit relative paths itself, so a plan only ever
    // carries one that bypassed it. Spawned, it would run relative to the cwd.
    const relativeNode = relative(cwd, process.execPath);
    expect(isAbsolute(relativeNode)).toBe(false);
    const plan: RunWrapperPlan = {
      banner: 'relative',
      env: {},
      commands: [{ file: relativeNode, args: ['-e', 'console.log("PLANTED")'] }],
      shell: node('process.exit(0)'),
    };
    const result = await runWrapper(
      process.execPath,
      ['-e', RUN_WRAPPER, Buffer.from(JSON.stringify(plan)).toString('base64')],
      process.env,
      cwd,
    );
    expect(result.stdout).not.toContain('PLANTED');
    expect(result.stdout).toContain('[Process exited with status 127]');
    expect(result.stderr).toContain(`spawn ${relativeNode} ENOENT`);
    expect(result.status).toBe(0);
  });

  it('hands the Windows wrapper a relative path as the file in the command’s directory', () => {
    const cwd = directory();
    mkdirSync(join(cwd, 'tools'));
    writeFileSync(join(cwd, 'tools', 'build.exe'), '');
    const spawned = terminalCommandSpawn(
      { cwd, env: { PATH: directory() }, commands: [{ file: './tools/build', args: ['x'] }] },
      process.execPath,
      [],
      'win32',
    );
    const plan = planOf(spawned.args);
    expect(plan.commands).toEqual([{ file: join(cwd, 'tools', 'build.exe'), args: ['x'] }]);
    // The banner shows the command as the user wrote it.
    expect(plan.banner).toBe('./tools/build x');
  });

  it.runIf(process.platform === 'win32')(
    'runs an explicit .\\ path from the working directory end to end on Windows',
    async () => {
      const cwd = directory();
      mkdirSync(join(cwd, 'tools'));
      copyFileSync(system32Path('hostname.exe'), join(cwd, 'tools', 'probe.exe'));
      const spawned = terminalCommandSpawn(
        { cwd, commands: [{ file: '.\\tools\\probe.exe', args: [] }] },
        process.execPath,
        ['-e', 'process.exit(0)'],
      );
      const result = await runWrapper(spawned.file, spawned.args, process.env, cwd);
      expect(result.stdout.toLowerCase()).toContain(hostname().toLowerCase());
      expect(result.stdout).toContain('[Process exited with status 0]');
    },
  );

  it.runIf(process.platform === 'win32')(
    'never runs a programme planted in the working directory on Windows',
    async () => {
      const cwd = directory();
      // Any executable will do; hostname.exe prints this machine's name.
      copyFileSync(system32Path('hostname.exe'), join(cwd, 'puddle-planted.exe'));
      const spawned = terminalCommandSpawn(
        { cwd, commands: [{ file: 'puddle-planted', args: [] }] },
        process.execPath,
        ['-e', 'process.exit(0)'],
      );
      // A plain user environment: Claude Code's own shells set this, hiding the lookup.
      const env = { ...process.env };
      deleteEnv(env, 'NoDefaultCurrentDirectoryInExePath', 'win32');
      const result = await runWrapper(spawned.file, spawned.args, env, cwd);
      expect(result.stdout.toLowerCase()).not.toContain(hostname().toLowerCase());
      expect(result.stdout).toContain('[Process exited with status 127]');
      expect(result.stderr).toContain('spawn puddle-planted ENOENT');
    },
  );

  it.runIf(process.platform === 'win32')(
    'runs an npm-installed command by name end to end on Windows',
    async () => {
      const bin = directory();
      writeFakeExecutable(
        bin,
        'fake-tool',
        'console.log("TOOL", JSON.stringify(process.argv.slice(2)));',
      );
      const path = [bin, dirname(process.execPath)].join(delimiter);
      const spawned = terminalCommandSpawn(
        { cwd: bin, env: { PATH: path }, commands: [{ file: 'fake-tool', args: ['a b', '100%'] }] },
        process.execPath,
        ['-e', 'process.exit(0)'],
      );
      const result = await runWrapper(spawned.file, spawned.args);
      expect(result.stdout).toContain('TOOL ["a b","100%"]');
      expect(result.stdout).toContain('[Process exited with status 0]');
      expect(result.status).toBe(0);
    },
  );
});
