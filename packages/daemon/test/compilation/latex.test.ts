import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RepoStore } from '../../src/db/stores/repos.js';
import type { SessionStore } from '../../src/db/stores/sessions.js';
import { clearLatexDiscoveryCache, discoverLatexToolchain } from '../../src/latex/discovery.js';
import { parseLatexDiagnostics } from '../../src/latex/diagnostics.js';
import { LatexCommandError, type LatexCommandRunner } from '../../src/latex/process.js';
import { LatexProvider } from '../../src/latex/provider.js';
import { resolveLatexSource, selectDirectEngine, texDirectives } from '../../src/latex/source.js';
import type { LatexToolchain } from '../../src/latex/toolchain.js';
import { NO_SESSION } from '../../src/http/routes/worktrees/worktree-shared.js';
import { ensureHome, resolvePaths } from '../../src/paths.js';

const emptyStores = {
  sessions: {} as SessionStore,
  repos: {} as RepoStore,
};

afterEach(() => clearLatexDiscoveryCache());

describe('LaTeX tool discovery', () => {
  it('finds executables on PATH and caches the result briefly', () => {
    const bin = mkdtempSync(join(tmpdir(), 'puddle-tex-bin-'));
    const latexmk = join(bin, 'latexmk');
    writeFileSync(latexmk, '#!/bin/sh\nexit 0\n');
    chmodSync(latexmk, 0o755);
    let now = 100;
    const options = {
      env: { PATH: bin },
      home: mkdtempSync(join(tmpdir(), 'puddle-tex-home-')),
      platform: 'linux' as const,
      now: () => now,
    };
    expect(discoverLatexToolchain(options).paths.latexmk).toBe(latexmk);
    chmodSync(latexmk, 0o644);
    now += 1;
    expect(discoverLatexToolchain(options).paths.latexmk).toBe(latexmk);
    now += 31_000;
    expect(discoverLatexToolchain(options).paths.latexmk).toBeUndefined();
  });
});

describe('TeX source resolution', () => {
  it('honours safe root/program directives and rejects root escapes', () => {
    const root = mkdtempSync(join(tmpdir(), 'puddle-tex-source-'));
    mkdirSync(join(root, 'chapters'));
    writeFileSync(join(root, 'main.tex'), '% !TEX program = LuaLaTeX\n\\documentclass{article}\n');
    writeFileSync(join(root, 'chapters', 'one.tex'), '% !TEX root = ../main.tex\nhello\n');
    expect(resolveLatexSource(root, 'chapters/one.tex')).toMatchObject({
      relative: 'main.tex',
      engine: 'lualatex',
    });

    writeFileSync(join(root, 'chapters', 'bad.tex'), '% !TEX root = ../../outside.tex\n');
    expect(() => resolveLatexSource(root, 'chapters/bad.tex')).toThrow(/escapes/);
  });

  it('normalises common program spellings and chooses a Unicode engine for fontspec', () => {
    expect(texDirectives('% !TeX program = Xe-LaTeX').program).toBe('xelatex');
    expect(
      selectDirectEngine(
        {
          requestedAbsolute: '/tmp/main.tex',
          absolute: '/tmp/main.tex',
          relative: 'main.tex',
          content: '\\usepackage{fontspec}',
        },
        ['pdflatex', 'xelatex'],
      ),
    ).toBe('xelatex');
  });
});

describe('LaTeX diagnostics', () => {
  it('normalises file-line errors and the classic TeX line form', () => {
    const root = join(tmpdir(), 'project with spaces');
    const source = join(root, 'main.tex');
    expect(
      parseLatexDiagnostics(
        [
          `${join(root, 'chapters', 'one.tex')}:17: Undefined control sequence.`,
          '! Missing $ inserted.',
          'l.23 text_underscore',
        ].join('\n'),
        source,
        root,
      ),
    ).toEqual([
      {
        absolutePath: join(root, 'chapters', 'one.tex'),
        severity: 'error',
        message: 'Undefined control sequence.',
        line: 17,
      },
      {
        absolutePath: source,
        severity: 'error',
        message: 'Missing $ inserted. — text_underscore',
        line: 23,
      },
    ]);
  });
});

describe('LatexProvider', () => {
  it('describes and executes a managed custom command for a rooted source', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'puddle-tex-custom-'));
    writeFileSync(join(sourceRoot, 'paper.tex'), '\\documentclass{article}\n');
    const seen: string[][] = [];
    const provider = new LatexProvider({
      ...emptyStores,
      discover: () => ({ paths: { latexmk: '/fake/latexmk' }, searchPath: '/fake' }),
      runner: async (command) => {
        seen.push([command.file, ...command.args]);
        const output = command.args.find((arg) => arg.startsWith('--output='))?.slice(9);
        if (!output) throw new Error('custom command did not receive its managed output');
        writeFileSync(join(output, 'paper.pdf'), '%PDF-custom');
        return { exitCode: 0, stdout: 'custom build\n', stderr: '' };
      },
    });
    const source = { session: NO_SESSION, root: sourceRoot, path: 'paper.tex' };
    expect(provider.commandConfiguration(source)).toMatchObject({
      filePath: realpathSync(join(sourceRoot, 'paper.tex')),
      fileType: 'tex',
      defaults: {
        on_demand: expect.stringContaining('/fake/latexmk'),
        eager: expect.stringContaining('/fake/latexmk'),
      },
    });
    expect(() => provider.validateCommand(source, 'custom-tex {{source}}')).toThrow(/output_dir/);
    provider.validateCommand(source, 'custom-tex --output={{output_dir}} {{source}}');
    const result = await provider.run(source, {
      command: 'custom-tex --output={{output_dir}} {{source}}',
    });
    expect(result.executor).toBe('custom-tex');
    expect(seen[0]?.[0]).toBe('custom-tex');
    expect(seen[0]?.at(-1)).toBe(join(sourceRoot, 'paper.tex'));
    expect(seen[0]?.[1]).toContain(join(sourceRoot, '.puddle', 'latex'));
  });

  it('compiles a magic-root document under its local .puddle and inverse-searches it', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'puddle-tex-project-'));
    mkdirSync(join(sourceRoot, 'sections'));
    writeFileSync(
      join(sourceRoot, 'main.tex'),
      '\\documentclass{article}\n\\input{sections/intro}\n',
    );
    writeFileSync(join(sourceRoot, 'sections', 'intro.tex'), '% !TEX root = ../main.tex\nHello\n');
    const paths = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-tex-state-')));
    ensureHome(paths);
    const tools: LatexToolchain = {
      paths: { latexmk: '/fake/latexmk', lualatex: '/fake/lualatex', synctex: '/fake/synctex' },
      searchPath: '/fake',
    };
    const commands: string[][] = [];
    const commandCwds: string[] = [];
    let synctexInput = join(sourceRoot, 'sections', 'intro.tex');
    let failBuild = false;
    const runner: LatexCommandRunner = async (command) => {
      commands.push([command.file, ...command.args]);
      commandCwds.push(command.cwd);
      if (basename(command.file) === 'synctex') {
        return {
          exitCode: 0,
          stdout: `SyncTeX result begin\nInput:${synctexInput}\nLine:7\nColumn:3\nSyncTeX result end\n`,
          stderr: '',
        };
      }
      if (failBuild) {
        throw new LatexCommandError('deliberate broken build', command, {
          exitCode: 1,
          stdout: `${join(sourceRoot, 'sections', 'intro.tex')}:2: Undefined control sequence.\n`,
          stderr: '',
        });
      }
      const outArg = command.args.find((arg) => arg.startsWith('-outdir='));
      if (!outArg) throw new Error('latexmk test command has no output directory');
      const outDir = outArg.slice('-outdir='.length);
      writeFileSync(join(outDir, 'main.pdf'), '%PDF-fake');
      writeFileSync(join(outDir, 'main.synctex.gz'), 'fake');
      writeFileSync(join(outDir, 'generated.sty'), 'managed build input');
      writeFileSync(
        join(outDir, 'main.fls'),
        `INPUT ${join(sourceRoot, 'main.tex')}\nINPUT ${join(sourceRoot, 'sections', 'intro.tex')}\nINPUT ${join(outDir, 'generated.sty')}\nINPUT /usr/share/texmf/article.cls\n`,
      );
      return { exitCode: 0, stdout: 'built\n', stderr: '' };
    };
    const provider = new LatexProvider({
      ...emptyStores,
      discover: () => tools,
      runner,
    });

    const built = await provider.run({
      session: NO_SESSION,
      root: sourceRoot,
      path: 'sections/intro.tex',
    });
    expect(built).toMatchObject({
      executor: 'latexmk',
      source: { path: 'main.tex', root: sourceRoot },
      artifacts: [{ role: 'preview', media_type: 'application/pdf', file: { path: 'main.pdf' } }],
      navigation: { kind: 'synctex' },
    });
    const pdf = built.artifacts[0]?.file;
    expect(pdf?.root?.startsWith(join(sourceRoot, '.puddle', 'latex'))).toBe(true);
    expect(basename(pdf?.root ?? '')).toBe('current');
    expect(built.dependencies.sort()).toEqual(
      [join(sourceRoot, 'main.tex'), join(sourceRoot, 'sections', 'intro.tex')].sort(),
    );
    if (!pdf?.root) throw new Error('compiled PDF has no root');
    expect(existsSync(join(pdf.root, 'build.log'))).toBe(true);
    expect(existsSync(join(pdf.root, 'manifest.json'))).toBe(true);
    expect(existsSync(join(paths.home, 'latex'))).toBe(false);
    expect(existsSync(join(sourceRoot, 'main.pdf'))).toBe(false);
    expect(commands[0]).toContain('-no-shell-escape');
    expect(commands[0]).toContain('-recorder');
    expect(commands[0]).toContain('-norc');
    expect(commandCwds[0]).toBe(sourceRoot);

    const target = await provider.inverseSearch({
      ...pdf,
      root: pdf.root,
      page: 1,
      x: 72.5,
      y: 144,
    });
    expect(target).toEqual({
      session: NO_SESSION,
      root: sourceRoot,
      path: 'sections/intro.tex',
      line: 7,
      column: 3,
    });
    expect(commands.at(-1)?.slice(0, 3)).toEqual(['/fake/synctex', 'edit', '-o']);

    const manifestPath = join(pdf.root, 'manifest.json');
    const manifestText = readFileSync(manifestPath, 'utf8');
    const forgedManifest = JSON.parse(manifestText) as Record<string, unknown>;
    forgedManifest['sourceRoot'] = dirname(sourceRoot);
    writeFileSync(manifestPath, `${JSON.stringify(forgedManifest)}\n`);
    await expect(
      provider.inverseSearch({ ...pdf, root: pdf.root, page: 1, x: 1, y: 1 }),
    ).rejects.toMatchObject({ code: 'invalid_latex_output' });
    writeFileSync(manifestPath, manifestText);

    const outside = join(mkdtempSync(join(tmpdir(), 'puddle-synctex-outside-')), 'outside.tex');
    writeFileSync(outside, 'outside\n');
    synctexInput = outside;
    await expect(
      provider.inverseSearch({ ...pdf, root: pdf.root, page: 1, x: 1, y: 1 }),
    ).rejects.toMatchObject({ code: 'synctex_source_outside_root' });

    const lastGoodPdf = readFileSync(join(pdf.root, pdf.path));
    failBuild = true;
    await expect(
      provider.run({ session: NO_SESSION, root: sourceRoot, path: 'main.tex' }),
    ).rejects.toMatchObject({
      code: 'latex_compile_failed',
      details: {
        output: expect.stringContaining('Undefined control sequence'),
        diagnostics: [
          {
            source: {
              session: NO_SESSION,
              root: sourceRoot,
              path: 'sections/intro.tex',
            },
            severity: 'error',
            message: 'Undefined control sequence.',
            line: 2,
          },
        ],
      },
    });
    expect(readFileSync(join(pdf.root, pdf.path))).toEqual(lastGoodPdf);
    failBuild = false;
    for (let index = 0; index < 5; index += 1) {
      await provider.run({ session: NO_SESSION, root: sourceRoot, path: 'main.tex' });
    }
    expect(readdirSync(join(dirname(pdf.root), 'runs'))).toHaveLength(5);
  });

  it('prefers Tectonic when latexmk is absent', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'puddle-tectonic-project-'));
    mkdirSync(join(sourceRoot, 'sections with spaces'));
    writeFileSync(join(sourceRoot, 'paper.tex'), '\\documentclass{article}\n');
    writeFileSync(join(sourceRoot, 'sections with spaces', 'result.tex'), 'result\n');
    writeFileSync(join(sourceRoot, 'references.bib'), '@misc{puddle, title={Puddle}}\n');
    const runner: LatexCommandRunner = async (command) => {
      const out = command.args[command.args.indexOf('--outdir') + 1];
      if (!out) throw new Error('missing outdir');
      const rules = command.args[command.args.indexOf('--makefile-rules') + 1];
      if (!rules) throw new Error('missing makefile rules path');
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'paper.pdf'), '%PDF-fake');
      writeFileSync(join(out, 'generated.sty'), 'managed input\n');
      const escaped = (path: string) => path.replaceAll('\\', '\\\\').replaceAll(' ', '\\ ');
      writeFileSync(
        rules,
        `${escaped(join(out, 'paper.pdf'))}: ${escaped(join(sourceRoot, 'paper.tex'))} ${escaped(join(sourceRoot, 'sections with spaces', 'result.tex'))} \\\n ${escaped(join(sourceRoot, 'references.bib'))} ${escaped(join(out, 'generated.sty'))} /usr/share/texmf/article.cls\n`,
      );
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const provider = new LatexProvider({
      ...emptyStores,
      discover: () => ({ paths: { tectonic: '/fake/tectonic' }, searchPath: '/fake' }),
      runner,
    });
    const built = await provider.run({ session: NO_SESSION, root: sourceRoot, path: 'paper.tex' });
    expect(built.executor).toBe('tectonic');
    expect(built.dependencies.sort()).toEqual(
      [
        join(sourceRoot, 'paper.tex'),
        join(sourceRoot, 'sections with spaces', 'result.tex'),
        join(sourceRoot, 'references.bib'),
      ].sort(),
    );
    const pdf = built.artifacts[0]?.file;
    if (!pdf?.root) throw new Error('compiled PDF has no root');
    expect(readFileSync(join(pdf.root, 'build.log'), 'utf8')).toContain('--untrusted');
  });

  it('falls back to a requested engine with bounded bibliography reruns', async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), 'puddle-engine-project-'));
    writeFileSync(
      join(sourceRoot, 'paper.tex'),
      '% !TEX program = lualatex\n\\documentclass{article}\n',
    );
    const commands: string[] = [];
    const runner: LatexCommandRunner = async (command) => {
      commands.push(basename(command.file));
      if (basename(command.file) === 'biber') {
        writeFileSync(join(command.cwd, 'paper.bbl'), 'bibliography');
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      const outArg = command.args.find((arg) => arg.startsWith('-output-directory='));
      if (!outArg) throw new Error('engine test command has no output directory');
      const outDir = outArg.slice('-output-directory='.length);
      writeFileSync(join(outDir, 'paper.pdf'), '%PDF-fake');
      writeFileSync(join(outDir, 'paper.synctex.gz'), 'fake');
      writeFileSync(join(outDir, 'paper.bcf'), 'bibliography-control');
      writeFileSync(join(outDir, 'paper.aux'), 'stable-auxiliary-state');
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const provider = new LatexProvider({
      ...emptyStores,
      discover: () => ({
        paths: {
          tectonic: '/fake/tectonic',
          lualatex: '/fake/lualatex',
          biber: '/fake/biber',
          synctex: '/fake/synctex',
        },
        searchPath: '/fake',
      }),
      runner,
    });
    const built = await provider.run({ session: NO_SESSION, root: sourceRoot, path: 'paper.tex' });
    expect(built.executor).toBe('lualatex');
    expect(commands.filter((command) => command === 'biber')).toHaveLength(1);
    expect(commands.filter((command) => command === 'lualatex')).toHaveLength(3);
  });
});
