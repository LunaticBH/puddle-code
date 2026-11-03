import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compilationCapabilitiesResponseSchema, type Session } from '@puddle/shared';
import { CodeProvider, createCodeProviders } from '../../src/code/provider.js';
import { findCodeExecutable } from '../../src/code/discovery.js';
import { CODE_RECIPES } from '../../src/code/recipes.js';
import { CompilationService } from '../../src/compilation/service.js';
import { runCompilationCommand } from '../../src/compilation/process.js';
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
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('code providers', () => {
  it('advertises valid capabilities and rejects eager execution without running code', async () => {
    const root = directory();
    writeFileSync(join(root, 'hello.py'), 'print(1)');
    const service = new CompilationService(createCodeProviders({ ...deps, discover: () => null }));
    try {
      const capabilities = compilationCapabilitiesResponseSchema.parse(service.capabilities());
      expect(capabilities.providers).toHaveLength(CODE_RECIPES.length);
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
  it('finds compiler alternatives while ignoring non-executable files', () => {
    const bin = directory();
    writeFileSync(join(bin, 'cc'), 'not executable');
    writeFileSync(join(bin, 'clang'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'clang'), 0o700);
    expect(findCodeExecutable(['cc', 'clang', 'gcc'], [bin])).toBe(join(bin, 'clang'));
    expect(findCodeExecutable(['python3'], [bin])).toBeNull();
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
