import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CompilationService, type CompilationEvent } from '../../src/compilation/service.js';
import type { CompilationProvider } from '../../src/compilation/provider.js';
import { ApiError } from '../../src/http/errors.js';

const commandSupport = {
  languageConfiguration: () => ({
    fileType: 'demo',
    variables: [],
    defaults: { on_demand: 'examplec input.demo', eager: 'examplec input.demo' },
  }),
  commandConfiguration: (source: { path: string }) => ({
    filePath: `/source/${source.path}`,
    fileType: 'demo',
    variables: [],
    defaults: { on_demand: 'examplec input.demo', eager: 'examplec input.demo' },
  }),
  validateCommand: () => undefined,
};

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('CompilationService', () => {
  it('selects a provider by extension for on-demand runs', async () => {
    const provider: CompilationProvider = {
      id: 'example',
      displayName: 'Example',
      extensions: ['demo'],
      inputExtensions: ['demo'],
      eager: true,
      capability: () => ({ available: true, executor: 'examplec' }),
      ...commandSupport,
      watchInputs: () => [],
      run: async (source) => ({
        executor: 'examplec',
        source,
        artifacts: [
          {
            role: 'preview',
            media_type: 'text/plain',
            file: { ...source, path: `${source.path}.out` },
          },
        ],
        dependencies: [],
      }),
    };
    const service = new CompilationService([provider]);
    const source = { session: '00000000-0000-0000-0000-000000000000', path: 'input.demo' };
    await expect(service.run({ source })).resolves.toMatchObject({
      provider: 'example',
      executor: 'examplec',
      revision: 1,
      artifacts: [{ file: { path: 'input.demo.out' } }],
    });
    await expect(
      service.run({ source: { ...source, path: 'input.unknown' } }),
    ).rejects.toMatchObject({
      code: 'compiler_not_supported',
    });
    service.dispose();
  });

  it('debounces eager dependency changes, emits completion, and cleans up', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'puddle-compile-watch-'));
    const sourcePath = join(directory, 'input.demo');
    writeFileSync(sourcePath, 'one\n');
    let runs = 0;
    const provider: CompilationProvider = {
      id: 'example',
      displayName: 'Example',
      extensions: ['demo'],
      inputExtensions: ['demo'],
      eager: true,
      capability: () => ({ available: true, executor: 'examplec' }),
      ...commandSupport,
      watchInputs: () => [sourcePath],
      run: async (source) => {
        runs += 1;
        return {
          executor: 'examplec',
          source,
          artifacts: [],
          dependencies: [sourcePath],
        };
      },
    };
    const service = new CompilationService([provider]);
    const events: CompilationEvent[] = [];
    service.subscribe((event) => events.push(event));
    const source = {
      session: '00000000-0000-0000-0000-000000000000',
      path: 'input.demo',
    };
    await service.setMode({ source, mode: 'eager' });
    expect(runs).toBe(1);

    // Atomic replacement is what many editors/agents use; watching the parent
    // directory (plus the stat fallback) must see it as a source change.
    const replacement = join(directory, 'replacement.tmp');
    writeFileSync(replacement, 'two\n');
    renameSync(replacement, sourcePath);
    await waitFor(() => runs === 2);
    expect(
      events.some((event) => event.type === 'completed' && event.status.mode === 'eager'),
    ).toBe(true);

    await service.setMode({ source, mode: 'on_demand' });
    const stoppedAt = runs;
    writeFileSync(sourcePath, 'four\n');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(runs).toBe(stoppedAt);
    expect(service.status({ source }).mode).toBe('on_demand');
    service.dispose();
  });

  it('coalesces changes during a build into one dirty rerun', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'puddle-compile-coalesce-'));
    const sourcePath = join(directory, 'input.demo');
    writeFileSync(sourcePath, 'one\n');
    let runs = 0;
    let release: (() => void) | undefined;
    const provider: CompilationProvider = {
      id: 'example',
      displayName: 'Example',
      extensions: ['demo'],
      inputExtensions: ['demo'],
      eager: true,
      capability: () => ({ available: true, executor: 'examplec' }),
      ...commandSupport,
      watchInputs: () => [sourcePath],
      run: async (source) => {
        runs += 1;
        if (runs === 2) await new Promise<void>((resolve) => (release = resolve));
        return { executor: 'examplec', source, artifacts: [], dependencies: [sourcePath] };
      },
    };
    const service = new CompilationService([provider]);
    const source = {
      session: '00000000-0000-0000-0000-000000000000',
      path: 'input.demo',
    };
    await service.setMode({ source, mode: 'eager' });
    writeFileSync(sourcePath, 'two\n');
    await waitFor(() => runs === 2);
    writeFileSync(sourcePath, 'three\n');
    writeFileSync(sourcePath, 'four-and-longer\n');
    // Let both fs.watch and polling callbacks reach the in-flight run.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    release?.();
    await waitFor(() => runs === 3);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(runs).toBe(3);
    service.dispose();
  });

  it('keeps initial inputs watched after a failed eager build', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'puddle-compile-retry-'));
    const sourcePath = join(directory, 'input.demo');
    writeFileSync(sourcePath, 'broken\n');
    let fixed = false;
    let runs = 0;
    const provider: CompilationProvider = {
      id: 'example',
      displayName: 'Example',
      extensions: ['demo'],
      inputExtensions: ['demo'],
      eager: true,
      capability: () => ({ available: true, executor: 'examplec' }),
      ...commandSupport,
      watchInputs: () => [sourcePath],
      run: async (source) => {
        runs += 1;
        if (!fixed) {
          throw new ApiError(422, 'compile_failed', 'source is broken', {
            output: 'input.demo:1: broken expression',
            diagnostics: [
              {
                source,
                severity: 'error',
                message: 'broken expression',
                line: 1,
              },
            ],
          });
        }
        return { executor: 'examplec', source, artifacts: [], dependencies: [sourcePath] };
      },
    };
    const service = new CompilationService([provider]);
    const source = {
      session: '00000000-0000-0000-0000-000000000000',
      path: 'input.demo',
    };
    await expect(service.setMode({ source, mode: 'eager' })).rejects.toThrow('source is broken');
    expect(service.status({ source })).toMatchObject({
      mode: 'eager',
      state: 'failed',
      error: {
        message: 'source is broken',
        output: 'input.demo:1: broken expression',
        diagnostics: [{ source, line: 1, message: 'broken expression' }],
      },
    });
    fixed = true;
    writeFileSync(sourcePath, 'fixed and valid\n');
    await waitFor(() => runs === 2);
    await waitFor(() => service.status({ source }).state === 'succeeded');
    service.dispose();
  });
});
