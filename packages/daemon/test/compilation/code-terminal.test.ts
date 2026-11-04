import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compilationRunResponseSchema } from '@puddle/shared';
import { CodeProvider, createCodeProviders } from '../../src/code/provider.js';
import { createCodeTerminalLauncher } from '../../src/code/terminal.js';
import { CODE_RECIPES } from '../../src/code/recipes.js';
import { CompilationService } from '../../src/compilation/service.js';
import { commandTemplate } from '../../src/compilation/command-template.js';
import { NO_SESSION } from '../../src/http/routes/worktrees/worktree-shared.js';
import { fixture, waitFor, type Fixture } from '../helpers/daemon-fixtures.js';

const windows = process.platform === 'win32';

/**
 * Shell input that prints `<first>-<second>` without its own echo containing
 * that text. On Windows the session shell is PowerShell.
 */
function shellPrint(first: string, second: string): string {
  return windows
    ? `Write-Output ('${first}-' + '${second}')\r`
    : `printf '${first}-%s\\n' ${second}\r`;
}

/**
 * The fake compiler's product. POSIX writes an sh script. Windows runs only
 * a real `.exe`, so the compiler links Node there: started without arguments
 * on a terminal, Node loads NODE_REPL_EXTERNAL_MODULE (set by `setup`) in
 * place of its REPL, which is the same prompt-and-reply programme.
 */
const BUILD_BINARY = windows
  ? 'fs.linkSync(process.execPath, process.argv[3]);'
  : `fs.writeFileSync(process.argv[3], '#!/bin/sh\\nprintf "BINARY_READY\\\\n"\\nread value\\nprintf "BINARY_REPLY:%s\\\\n" "$value"\\n', {mode:0o700});`;

const fixtures: Fixture[] = [];
const services: CompilationService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  for (const f of fixtures.splice(0)) {
    f.service.beginShutdown();
    f.onboarding.dispose();
    f.ptys.killAll();
    await waitFor(() => f.stores.sessions.list().every((s) => !f.ptys.has(s.id, 'agent')));
    f.logs.closeAll();
  }
  vi.unstubAllEnvs();
});

function setup() {
  const f = fixture();
  fixtures.push(f);
  if (!windows) vi.stubEnv('SHELL', '/bin/bash');
  vi.stubEnv('HOME', f.paths.home);
  if (windows) {
    const binary = join(f.paths.home, 'binary.cjs');
    writeFileSync(
      binary,
      "console.log('BINARY_READY'); require('node:readline').createInterface({ input: process.stdin })" +
        ".once('line', (value) => { console.log('BINARY_REPLY:' + value); process.exit(0); });",
    );
    vi.stubEnv('NODE_REPL_EXTERNAL_MODULE', binary);
  }
  // CI colours Node's inspected booleans inside a PTY. Exercise that path even
  // when the developer's terminal disables colours, and compare rendered text.
  vi.stubEnv('FORCE_COLOR', '1');
  const deps = {
    ...f.stores,
    discover: () => process.execPath,
    launchTerminal: createCodeTerminalLauncher({ ...f.stores, service: f.service, ptys: f.ptys }),
  };
  const options = {
    mode: 'on_demand',
    command: null,
    projectId: f.ids.project,
    profileId: f.ids.profile,
  } as const;
  return { f, deps, options };
}

describe('programme terminals', () => {
  it('launches a real interactive PTY, preserves literal paths and leaves a shell without replaying on resume', async () => {
    const { f, deps } = setup();
    const root = join(f.repoPath, 'source files');
    mkdirSync(root);
    const path = "main ' $(touch unwanted).js";
    writeFileSync(
      join(root, path),
      `
      console.log('PROGRAMME_READY', process.stdin.isTTY, process.stdout.isTTY, process.cwd());
      const rl = require('node:readline').createInterface({input:process.stdin, output:process.stdout});
      rl.question('Name: ', value => { console.log('REPLY:' + value); rl.close(); });
    `,
    );
    const service = new CompilationService(createCodeProviders(deps));
    services.push(service);
    const result = compilationRunResponseSchema.parse(
      await service.run({
        source: { session: NO_SESSION, root, path },
        project_id: f.ids.project,
      }),
    );
    const terminal = result.terminal!;
    expect(result.artifacts).toEqual([]);
    expect(terminal).toMatchObject({
      kind: 'terminal',
      project_id: f.ids.project,
      cwd: 'source files',
    });
    const output = () => stripVTControlCharacters(f.logs.readTail(terminal.id, 'agent'));
    await waitFor(() => output().includes('PROGRAMME_READY true true'));
    expect(output()).toContain(root);
    f.ptys.write(terminal.id, 'agent', 'reader\r');
    await waitFor(() => output().includes('REPLY:reader'));
    await waitFor(() => output().includes('Process exited with status 0'));
    f.ptys.write(terminal.id, 'agent', shellPrint('SHELL', 'READY'));
    await waitFor(() => output().includes('SHELL-READY'));
    expect(existsSync(join(root, 'unwanted'))).toBe(false);
    await f.service.kill(terminal.id);
    await f.service.resume(terminal.id);
    f.ptys.write(terminal.id, 'agent', shellPrint('RESUMED', 'SHELL'));
    await waitFor(() => output().includes('RESUMED-SHELL'));
    expect(output().match(/PROGRAMME_READY true true/g)).toHaveLength(1);
  });

  it('returns to a shell after Ctrl+C interrupts a long-running programme', async () => {
    const { f, deps, options } = setup();
    writeFileSync(
      join(f.repoPath, 'server.js'),
      "console.log('SERVER_READY'); setInterval(() => {}, 1000);",
    );
    const provider = new CodeProvider(
      CODE_RECIPES.find((r) => r.id === 'javascript')!,
      deps,
    );
    const result = await provider.run(
      { session: NO_SESSION, root: f.repoPath, path: 'server.js' },
      options,
    );
    const id = result.terminal!.id;
    const output = () => f.logs.readTail(id, 'agent');
    await waitFor(() => output().includes('SERVER_READY'));
    f.ptys.write(id, 'agent', '\x03');
    await waitFor(() => output().includes('Process exited with status 130'));
    f.ptys.write(id, 'agent', shellPrint('INTERRUPTED', 'SHELL'));
    await waitFor(() => output().includes('INTERRUPTED-SHELL'));
  });

  it.each(['c', 'cpp', 'rust'])(
    'compiles %s in the terminal and runs only the freshly successful binary',
    async (language) => {
      const { f, deps, options } = setup();
      const compiler = join(f.repoPath, 'compiler.js');
      writeFileSync(
        compiler,
        `
      const fs = require('node:fs');
      console.log('COMPILER_TTY', process.stdin.isTTY, process.stdout.isTTY);
      if (fs.readFileSync(process.argv[2], 'utf8') === 'fail') {
        console.error('BUILD_FAILED'); process.exit(2);
      }
      ${BUILD_BINARY}
    `,
      );
      const entry = CODE_RECIPES.find((r) => r.id === language)!;
      const source = { session: NO_SESSION, root: f.repoPath, path: `main.${entry.extensions[0]}` };
      writeFileSync(join(f.repoPath, source.path), 'ok');
      const provider = new CodeProvider(entry, deps);
      const command = commandTemplate(process.execPath, [compiler, '{{source}}', '{{binary}}']);
      const first = await provider.run(source, { ...options, command });
      const id = first.terminal!.id;
      const output = () => stripVTControlCharacters(f.logs.readTail(id, 'agent'));
      await waitFor(() => output().includes('BINARY_READY'));
      expect(output()).toContain('COMPILER_TTY true true');
      f.ptys.write(id, 'agent', 'test\r');
      await waitFor(() => output().includes('BINARY_REPLY:test'));
      writeFileSync(join(f.repoPath, source.path), 'fail');
      const second = await provider.run(source, { ...options, command });
      const failedOutput = () =>
        stripVTControlCharacters(f.logs.readTail(second.terminal!.id, 'agent'));
      await waitFor(() => failedOutput().includes('Process exited with status 2'));
      expect(failedOutput()).toContain('COMPILER_TTY true true');
      expect(failedOutput()).toContain('BUILD_FAILED');
      expect(failedOutput()).not.toContain('BINARY_READY');
      expect(second.terminal!.id).not.toBe(id);
    },
  );

  it('advertises terminal execution for every programming language, excluding notebook artefacts', () => {
    const { deps } = setup();
    const providers = createCodeProviders(deps);
    for (const provider of providers) expect(provider.terminal).toBe(!provider.recipe.notebook);
  });

  it('keeps active run directories while retaining only five completed runs', async () => {
    const { f, deps, options } = setup();
    writeFileSync(join(f.repoPath, 'main.js'), '');
    const completions: Array<() => void> = [];
    const alias = join(f.paths.home, 'repo-alias');
    // A junction needs no privilege on Windows and resolves like a symlink.
    symlinkSync(f.repoPath, alias, 'junction');
    const directories: string[] = [];
    const terminal = await f.service.create({ kind: 'terminal', project_id: f.ids.project });
    const provider = new CodeProvider(
      CODE_RECIPES.find((r) => r.id === 'javascript')!,
      {
        ...deps,
        launchTerminal: async (_source, _options, command) => {
          const directory = command.commands[0]!.args[1]!;
          directories.push(directory);
          writeFileSync(join(directory, 'retained'), 'live');
          return {
            session: terminal,
            exited: new Promise<void>((resolve) => completions.push(resolve)),
          };
        },
      },
    );
    for (let i = 0; i < 7; i++)
      await provider.run(
        { session: NO_SESSION, root: i % 2 ? alias : f.repoPath, path: 'main.js' },
        {
          ...options,
          command: 'node {{source}} {{output_dir}}',
        },
      );
    expect(directories.every((dir) => readFileSync(join(dir, 'retained'), 'utf8') === 'live')).toBe(
      true,
    );
    for (const complete of completions) complete();
    const runs = join(directories[0]!, '..');
    await waitFor(() => readdirSync(runs).length === 5);
  });

  it('rejects mismatched project/profile scope and accepts explicitly browsed external roots', async () => {
    const { f, deps, options } = setup();
    const owner = await f.service.create({ kind: 'terminal', project_id: f.ids.project });
    const root = f.paths.home;
    writeFileSync(join(root, 'outside.js'), "console.log('EXTERNAL_CWD', process.cwd());");
    const provider = new CodeProvider(
      CODE_RECIPES.find((r) => r.id === 'javascript')!,
      deps,
    );
    const source = { session: owner.id, root, path: 'outside.js' };
    await expect(provider.run(source, { ...options, profileId: 'other' })).rejects.toThrow(
      /selected project and profile/,
    );
    const result = await provider.run(source, options);
    await waitFor(() => f.logs.readTail(result.terminal!.id, 'agent').includes('EXTERNAL_CWD'));
    expect(f.logs.readTail(result.terminal!.id, 'agent')).toContain(
      `EXTERNAL_CWD ${realpathSync(root)}`,
    );
    expect(result.terminal!.worktree_path).toBe(owner.worktree_path);
    expect(result.terminal!.cwd).toBeNull();
  });
});
