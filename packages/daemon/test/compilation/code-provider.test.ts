import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compilationCapabilitiesResponseSchema, type Session } from '@puddle/shared';
import { isPidAlive, system32Path } from '@puddle/shared/node/platform';
import { CodeProvider, createCodeProviders } from '../../src/code/provider.js';
import { codeSearchDirectories, findCodeExecutable } from '../../src/code/discovery.js';
import {
  CODE_RECIPES,
  hostRecipes,
  managedBinaryName,
  recipeExecutables,
} from '../../src/code/recipes.js';
import { CompilationService } from '../../src/compilation/service.js';
import { compilationSpawn, runCompilationCommand } from '../../src/compilation/process.js';
import { commandTemplate } from '../../src/compilation/command-template.js';
import type { CodeTerminalLauncher } from '../../src/code/terminal.js';
import type { RepoStore } from '../../src/db/stores/repos.js';
import type { SessionStore } from '../../src/db/stores/sessions.js';
import { NO_SESSION } from '../../src/http/routes/worktrees/worktree-shared.js';

const roots: string[] = [];
const deps = { sessions: {} as SessionStore, repos: {} as RepoStore };
function directory() {
  const root = mkdtempSync(join(tmpdir(), 'puddle code '));
  roots.push(root);
  return root;
}
function recipe(id: string) {
  return CODE_RECIPES.find((recipe) => recipe.id === id)!;
}
const options = { mode: 'on_demand', command: null } as const;
afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Windows keeps a working directory busy until a stopped command has gone,
    // which the tree's stop completes shortly after the command's promise settles.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        if (process.platform !== 'win32' || attempt >= 50) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

describe('code providers', () => {
  it('advertises valid capabilities and rejects eager execution without running code', async () => {
    const root = directory();
    writeFileSync(join(root, 'hello.py'), 'print(1)');
    const service = new CompilationService(createCodeProviders({ ...deps, discover: () => null }));
    try {
      const capabilities = compilationCapabilitiesResponseSchema.parse(service.capabilities());
      expect(capabilities.providers).toHaveLength(hostRecipes().length);
      expect(
        capabilities.providers.every(
          (provider) => !provider.eager && !provider.available && provider.action === 'run',
        ),
      ).toBe(true);
      const request = { source: { session: NO_SESSION, root, path: 'hello.py' } };
      await expect(service.setMode({ ...request, mode: 'eager' })).rejects.toThrow(
        /does not support eager/,
      );
      await expect(service.run(request)).rejects.toThrow(/not available/);
    } finally {
      service.dispose();
    }
  });

  it.each(CODE_RECIPES.filter((entry) => !entry.notebook))(
    'runs $name exclusively in a terminal, including its compiler',
    async (entry) => {
      const root = directory();
      const path = `main ' $(touch unwanted).${entry.extensions[0]}`;
      writeFileSync(join(root, path), 'source');
      const terminal: Session = {
        id: '00000000-0000-0000-0000-000000000001',
        project_id: 'project123',
        account_id: null,
        worktree_path: root,
        base_branch: 'main',
        branch: 'main',
        separate_branch: false,
        kind: 'terminal',
        agent_type: null,
        agent_session_ref: null,
        title: 'Run source',
        status: 'running',
        skip_permissions: false,
        created_at: '2026-10-23T00:00:00.000Z',
        updated_at: '2026-10-23T00:00:00.000Z',
        last_activity_at: null,
      };
      const launchTerminal = vi.fn<CodeTerminalLauncher>(async () => ({
        session: terminal,
        exited: new Promise<void>(() => undefined),
      }));
      const runner = vi.fn();
      const provider = new CodeProvider(entry, {
        ...deps,
        discover: () => '/tools/executor',
        launchTerminal,
        runner,
      });
      const source = { session: NO_SESSION, root, path };
      const result = await provider.run(source, options);
      expect(result.terminal).toBe(terminal);
      expect(result.artifacts).toEqual([]);
      expect(runner).not.toHaveBeenCalled();
      const customArgs = [
        '{{source}}',
        'literal $(touch unwanted)',
        ...(entry.compiled ? ['-o', '{{binary}}'] : []),
      ];
      await provider.run(source, {
        ...options,
        command: commandTemplate('/tools/custom', customArgs),
      });
      expect(launchTerminal.mock.calls[1]![2].commands[0]).toMatchObject({
        file: '/tools/custom',
        args: [
          join(root, path),
          'literal $(touch unwanted)',
          ...(entry.compiled ? ['-o', expect.any(String)] : []),
        ],
      });
      expect(runner).not.toHaveBeenCalled();
      const invocation = launchTerminal.mock.calls[0]![2];
      expect(invocation.cwd).toBe(root);
      expect(invocation.commands[0]!.file).toBe('/tools/executor');
      expect(invocation.commands[0]!.args).toContain(join(root, path));
      expect(invocation.commands).toHaveLength(entry.compiled ? 2 : 1);
      if (entry.compiled) {
        const build = invocation.commands[0]!;
        expect(invocation.commands[1]).toEqual({
          file: build.args[build.args.indexOf('-o') + 1],
          args: [],
        });
        expect(() => provider.validateCommand(source, 'cc {{source}}')).toThrow(/binary/);
      }
      expect(readdirSync(root)).not.toContain('unwanted');
      expect(
        readdirSync(join(root, '.puddle', 'code', entry.id), { recursive: true }).some((name) =>
          String(name).endsWith('output.txt'),
        ),
      ).toBe(false);
      await expect(
        provider.run({ ...source, path: '../escape.' + entry.extensions[0] }, options),
      ).rejects.toThrow(/escapes/);
      expect(() => provider.validateCommand(source, 'node {{source}} && echo nope')).toThrow(
        /without a shell/,
      );
    },
  );

  it.runIf(process.platform === 'win32')(
    'refuses a batch-file command cmd.exe cannot carry before opening a terminal',
    async () => {
      const root = directory();
      writeFileSync(join(root, 'main.js'), '');
      writeFileSync(join(root, 'run.bat'), '@echo off\r\n');
      const launchTerminal = vi.fn<CodeTerminalLauncher>();
      const provider = new CodeProvider(recipe('javascript'), {
        ...deps,
        discover: () => process.execPath,
        launchTerminal,
      });
      await expect(
        provider.run(
          { session: NO_SESSION, root, path: 'main.js' },
          { ...options, command: `${commandTemplate(join(root, 'run.bat'), ['{{source}}'])} 100%` },
        ),
      ).rejects.toMatchObject({ code: 'invalid_compilation_command' });
      expect(launchTerminal).not.toHaveBeenCalled();
    },
  );

  it('fails without a terminal launcher instead of capturing programme output', async () => {
    const root = directory();
    writeFileSync(join(root, 'main.js'), 'console.log(1);');
    const runner = vi.fn();
    const provider = new CodeProvider(recipe('javascript'), {
      ...deps,
      discover: () => process.execPath,
      runner,
    });
    await expect(
      provider.run({ session: NO_SESSION, root, path: 'main.js' }, options),
    ).rejects.toMatchObject({ code: 'terminal_execution_unavailable' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('executes notebooks into a separate result and preserves the original document', async () => {
    const root = directory();
    const original = '{"cells":[]}';
    writeFileSync(join(root, 'analysis.ipynb'), original);
    const provider = new CodeProvider(recipe('notebook'), {
      ...deps,
      discover: () => '/tools/jupyter-nbconvert',
      runner: async (command) => {
        expect(command.args).toContain('--execute');
        expect(command.args).not.toContain('--inplace');
        expect(command.cwd).toBe(root);
        const out = command.args[command.args.indexOf('--output-dir') + 1]!;
        writeFileSync(join(out, 'notebook.ipynb'), '{"cells":[{"outputs":[]}]}');
        return { exitCode: 0, stdout: '', stderr: 'Executed' };
      },
    });
    const result = await provider.run(
      { session: NO_SESSION, root, path: 'analysis.ipynb' },
      options,
    );
    expect(result.artifacts[0]!.media_type).toBe('application/x-ipynb+json');
    expect(readFileSync(join(root, 'analysis.ipynb'), 'utf8')).toBe(original);
    const output = result.artifacts[0]!.file;
    expect(readFileSync(join(output.root!, output.path), 'utf8')).toContain('outputs');
  });
});

describe('code tool discovery and process bounds', () => {
  // Execute bits do not exist on Windows; the PATHEXT rules below replace them.
  it.skipIf(process.platform === 'win32')(
    'finds compiler alternatives while ignoring non-executable files',
    () => {
      const bin = directory();
      writeFileSync(join(bin, 'cc'), 'not executable');
      writeFileSync(join(bin, 'clang'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'clang'), 0o700);
      expect(findCodeExecutable(['cc', 'clang', 'gcc'], [bin])).toBe(join(bin, 'clang'));
      expect(findCodeExecutable(['python3'], [bin])).toBeNull();
    },
  );

  it('completes Windows names through PATHEXT and skips extensionless files', () => {
    const bin = directory();
    // npm installs an extensionless sh script beside each .cmd shim.
    writeFileSync(join(bin, 'cc'), '#!/bin/sh\n');
    writeFileSync(join(bin, 'tsx'), '#!/bin/sh\n');
    writeFileSync(join(bin, 'tsx.cmd'), '@echo off\r\n');
    writeFileSync(join(bin, 'gcc.exe'), '');
    writeFileSync(join(bin, 'powershell.exe'), '');
    const find = (names: readonly string[], dirs: string[]) =>
      findCodeExecutable(names, dirs, 'win32');
    expect(find(['cc', 'gcc'], [bin])).toBe(join(bin, 'gcc.exe'));
    expect(find(['tsx'], [bin])).toBe(join(bin, 'tsx.cmd'));
    expect(find(['python3'], [bin])).toBeNull();
    const powershell = recipeExecutables(recipe('powershell'), 'win32');
    expect(find(powershell, [bin])).toBe(join(bin, 'powershell.exe'));
    // PowerShell 7 wins wherever it is found.
    const pwsh = directory();
    writeFileSync(join(pwsh, 'pwsh.exe'), '');
    expect(find(powershell, [bin, pwsh])).toBe(join(pwsh, 'pwsh.exe'));
  });

  it('runs PowerShell scripts with the Microsoft Store’s PowerShell 7, by its alias', () => {
    const bin = directory();
    writeFileSync(join(bin, 'powershell.exe'), '');
    const aliases = directory();
    const alias = join(aliases, 'pwsh.exe');
    const isAlias = (path: string) => path === alias;
    const powershell = recipeExecutables(recipe('powershell'), 'win32');
    expect(findCodeExecutable(powershell, [bin, aliases], 'win32', isAlias)).toBe(alias);
    // An installed pwsh.exe comes first, and no other alias is ever chosen.
    const installed = directory();
    writeFileSync(join(installed, 'pwsh.exe'), '');
    expect(findCodeExecutable(powershell, [aliases, installed], 'win32', isAlias)).toBe(
      join(installed, 'pwsh.exe'),
    );
    expect(findCodeExecutable(['python'], [aliases], 'win32', () => true)).toBeNull();
    expect(findCodeExecutable(powershell, [bin, aliases], 'win32', () => false)).toBe(
      join(bin, 'powershell.exe'),
    );
    // The folder Windows keeps the user's aliases in is searched.
    const localAppData = directory();
    expect(codeSearchDirectories({ LOCALAPPDATA: localAppData }, directory(), 'win32')).toContain(
      join(localAppData, 'Microsoft', 'WindowsApps'),
    );
  });

  it('offers PowerShell scripts on Windows and POSIX shells elsewhere', () => {
    // The POSIX provider list, in order, is fixed.
    const posix = [
      'python',
      'javascript',
      'typescript',
      'c',
      'cpp',
      'rust',
      'go',
      'ruby',
      'perl',
      'r',
      'shell',
      'zsh',
      'notebook',
    ];
    expect(hostRecipes('linux').map((entry) => entry.id)).toEqual(posix);
    expect(hostRecipes('darwin').map((entry) => entry.id)).toEqual(posix);
    expect(createCodeProviders(deps, 'linux').map((provider) => provider.recipe.id)).toEqual(posix);
    const windows = [...posix.slice(0, 10), 'powershell', 'notebook'];
    expect(hostRecipes('win32').map((entry) => entry.id)).toEqual(windows);
    expect(createCodeProviders(deps, 'win32').map((provider) => provider.recipe.id)).toEqual(
      windows,
    );
    expect(recipeExecutables(recipe('powershell'), 'win32')).toEqual(['pwsh', 'powershell']);
    expect(recipe('powershell')).toMatchObject({
      extensions: ['ps1'],
      args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '{{source}}'],
    });
  });

  // Drive paths are absolute only on a Windows host.
  it.runIf(process.platform === 'win32')(
    'falls back to Windows PowerShell and never searches Git for Windows’ bin',
    () => {
      const home = directory();
      const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
      const dirs = codeSearchDirectories(env, home, 'win32');
      expect(dirs.at(-1)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
      expect(dirs).not.toContain('C:\\Program Files\\Git\\bin');
      expect(findCodeExecutable(['powershell'], dirs, 'win32')?.toLowerCase()).toBe(
        'c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe',
      );
    },
  );

  it('searches the Windows PATH safely, then venv Scripts and installer locations', () => {
    const home = directory();
    const tools = directory();
    const localAppData = directory();
    mkdirSync(join(localAppData, 'Programs', 'Python', 'Python312'), { recursive: true });
    mkdirSync(join(localAppData, 'Programs', 'Python', 'Launcher'), { recursive: true });
    const dirs = codeSearchDirectories(
      {
        // Unexpanded, relative and drive-relative entries resolve against the cwd.
        Path: [`"${tools}"`, '%NVM_HOME%', 'relative\\bin', '\\rooted\\bin', ''].join(';'),
        VIRTUAL_ENV: join(home, '.venv'),
        APPDATA: join(home, 'Roaming'),
        LOCALAPPDATA: localAppData,
      },
      home,
      'win32',
    );
    expect(dirs.slice(0, 2)).toEqual([tools, join(home, '.venv', 'Scripts')]);
    expect(dirs).toEqual(
      expect.arrayContaining([
        join(home, '.cargo', 'bin'),
        join(home, 'Roaming', 'npm'),
        join(localAppData, 'Microsoft', 'WinGet', 'Links'),
        join(localAppData, 'Programs', 'Python', 'Python312'),
        join(localAppData, 'Programs', 'Python', 'Python312', 'Scripts'),
      ]),
    );
    expect(dirs.some((dir) => /%|relative|rooted/.test(dir))).toBe(false);
    expect(dirs.some((dir) => dir.includes('Launcher'))).toBe(false);
    expect(dirs).not.toContain('/usr/bin');
  });

  it('never searches Windows folders another local account could create', () => {
    const home = directory();
    const drive = directory();
    const programData = directory();
    const planted = [
      join(drive, 'Python399'),
      join(drive, 'msys64', 'ucrt64', 'bin'),
      join(drive, 'Strawberry', 'perl', 'bin'),
      join(drive, 'Ruby33-x64', 'bin'),
      join(programData, 'chocolatey', 'bin'),
    ];
    for (const dir of planted) mkdirSync(dir, { recursive: true });
    writeFileSync(join(drive, 'Python399', 'python.exe'), '');
    writeFileSync(join(drive, 'msys64', 'ucrt64', 'bin', 'gcc.exe'), '');
    const env = { SystemDrive: drive, ProgramData: programData };
    const dirs = codeSearchDirectories(env, home, 'win32');
    expect(dirs.filter((dir) => dir.startsWith(drive) || dir.startsWith(programData))).toEqual([]);
    expect(findCodeExecutable(['python'], dirs, 'win32')).toBeNull();
    expect(findCodeExecutable(['gcc'], dirs, 'win32')).toBeNull();
    // An installation the user put on PATH is still found.
    const msys = join(drive, 'msys64', 'ucrt64', 'bin');
    expect(codeSearchDirectories({ ...env, Path: msys }, home, 'win32')[0]).toBe(msys);
  });

  it('chooses Windows executable names and an .exe managed binary on Windows', () => {
    expect(recipeExecutables(recipe('python'), 'win32')).toEqual(['python', 'py', 'python3']);
    expect(recipeExecutables(recipe('c'), 'win32')).not.toContain('cc');
    expect(recipeExecutables(recipe('c'), 'linux')).toEqual(recipe('c').executables);
    expect(recipeExecutables(recipe('go'), 'win32')).toEqual(['go']);
    expect(managedBinaryName('win32')).toBe('programme.exe');
    expect(managedBinaryName('linux')).toBe('programme');
  });

  it('starts commands as a POSIX process group, or hidden with shims unwrapped on Windows', () => {
    const bin = directory();
    writeFileSync(join(bin, 'node.exe'), '');
    writeFileSync(
      join(bin, 'tool.cmd'),
      [
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
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\tool.js" %*',
      ].join('\r\n'),
    );
    const command = { file: join(bin, 'tool.cmd'), args: ['a b'], cwd: bin };
    expect(compilationSpawn(command, 'linux')).toEqual({
      file: command.file,
      args: ['a b'],
      options: { cwd: bin, env: undefined, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    });
    const windows = compilationSpawn(command, 'win32');
    expect(windows).toMatchObject({
      file: join(bin, 'node.exe'),
      args: [join(bin, 'tool.js'), 'a b'],
      options: { windowsHide: true },
    });
    expect(windows.options.detached).toBeUndefined();
  });

  it('runs a Windows command with the user’s working-directory program search', () => {
    // A build script the command starts may call a sibling tool by bare name.
    const env = { Path: 'C:\\Windows', NoDefaultCurrentDirectoryInExePath: 'puddle' };
    const command = { file: process.execPath, args: [], cwd: directory(), env };
    expect(compilationSpawn(command, 'win32').options.env).toEqual({ Path: 'C:\\Windows' });
    expect(compilationSpawn(command, 'linux').options.env).toBe(env);
    const own = { ...command, env: { NoDefaultCurrentDirectoryInExePath: '1' } };
    expect(compilationSpawn(own, 'win32').options.env).toEqual(own.env);
  });

  it('refuses a Windows command missing from PATH instead of searching its working directory', () => {
    const cwd = directory();
    writeFileSync(join(cwd, 'planted.exe'), '');
    const command = { file: 'planted', args: [], cwd, env: { PATH: directory() } };
    expect(() => compilationSpawn(command, 'win32')).toThrow(/spawn planted ENOENT/);
    // POSIX execvp never looks in the working directory: the name stays as given.
    expect(compilationSpawn(command, 'linux').file).toBe('planted');
  });

  it('starts a relative Windows path from the command’s working directory, as on POSIX', () => {
    const cwd = directory();
    mkdirSync(join(cwd, 'tools'));
    writeFileSync(join(cwd, 'tools', 'build.exe'), '');
    // A template such as `./tools/build.sh {{source}}` on POSIX, `.\tools\build.exe` here.
    const command = { file: './tools/build', args: ['main.c'], cwd, env: { PATH: directory() } };
    expect(compilationSpawn(command, 'win32')).toMatchObject({
      file: join(cwd, 'tools', 'build.exe'),
      args: ['main.c'],
      options: { cwd },
    });
    expect(compilationSpawn(command, 'linux').file).toBe('./tools/build');
  });

  it.runIf(process.platform === 'win32')(
    'runs an explicit .\\ path from the command’s working directory end to end',
    async () => {
      const cwd = directory();
      mkdirSync(join(cwd, 'tools'));
      // Any executable will do; hostname.exe prints this machine's name.
      copyFileSync(system32Path('hostname.exe'), join(cwd, 'tools', 'probe.exe'));
      const result = await runCompilationCommand({ file: '.\\tools\\probe.exe', args: [], cwd });
      expect(result.stdout.trim().toLowerCase()).toBe(hostname().toLowerCase());
    },
  );

  it.runIf(process.platform === 'win32')(
    'never runs an executable planted in the command’s working directory',
    async () => {
      const cwd = directory();
      copyFileSync(system32Path('hostname.exe'), join(cwd, 'puddle-planted.exe'));
      // A plain user environment: Claude Code's own shells set this, hiding the lookup.
      const saved = process.env.NoDefaultCurrentDirectoryInExePath;
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      try {
        await expect(
          runCompilationCommand({ file: 'puddle-planted', args: [], cwd, env: process.env }),
        ).rejects.toThrow(/Could not start Compilation command: spawn puddle-planted ENOENT/);
      } finally {
        if (saved !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = saved;
      }
    },
  );

  it('stops the whole process tree when a command times out', async () => {
    const cwd = directory();
    const pidFile = join(cwd, 'grandchild.pid');
    const error = await runCompilationCommand({
      file: process.execPath,
      args: [
        '-e',
        `const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
         require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
         setInterval(() => {}, 1000);`,
      ],
      cwd,
      timeoutMs: 1_500,
    }).catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/exceeded 1500 ms/);
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    await expect.poll(() => isPidAlive(grandchild), { timeout: 10_000 }).toBe(false);
  });

  it('bounds runtime and captured output', async () => {
    const cwd = directory();
    await expect(
      runCompilationCommand({
        file: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/exceeded 50 ms/);
    await expect(
      runCompilationCommand({
        file: process.execPath,
        args: ['-e', 'console.log("x".repeat(10000))'],
        cwd,
        maxOutputBytes: 100,
      }),
    ).rejects.toThrow(/output exceeded/);
  });
});
