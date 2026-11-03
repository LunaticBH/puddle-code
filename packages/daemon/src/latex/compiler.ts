import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, basename, dirname, extname, join } from 'node:path';
import { getEnv } from '@puddle/shared/node/platform';
import { ApiError } from '../http/errors.js';
import { commandTemplate, expandCommandTemplate } from '../compilation/command-template.js';
import { withEnvironment } from '../compilation/environment.js';
import { boundedLatexOutput, LatexBuildFailure, parseLatexDiagnostics } from './diagnostics.js';
import {
  LatexCommandError,
  runLatexCommand,
  type LatexCommand,
  type LatexCommandResult,
  type LatexCommandRunner,
} from './process.js';
import { selectDirectEngine, type ResolvedLatexSource } from './source.js';
import { LATEX_ENGINES, type LatexEngine, type LatexToolchain } from './toolchain.js';

const MAX_ENGINE_PASSES = 5;

export interface LatexBuildResult {
  compiler: string;
  pdfPath: string;
  synctexPath: string | null;
  dependencies: string[];
}

interface CompileOptions {
  source: ResolvedLatexSource;
  buildDir: string;
  toolchain: LatexToolchain;
  runner?: LatexCommandRunner;
  timeoutMs?: number;
  command?: string;
}

/** The currently selected primary command, expressed with managed run placeholders. */
export function defaultLatexCommand(
  source: Pick<ResolvedLatexSource, 'engine' | 'content'>,
  toolchain: LatexToolchain,
): string | null {
  if (toolchain.paths.latexmk) {
    return commandTemplate(toolchain.paths.latexmk, [
      latexmkMode(source.engine),
      '-norc',
      '-interaction=nonstopmode',
      '-halt-on-error',
      '-file-line-error',
      '-synctex=1',
      '-recorder',
      '-no-shell-escape',
      '-outdir={{output_dir}}',
      '{{source}}',
    ]);
  }
  if (toolchain.paths.tectonic && source.engine === undefined) {
    return commandTemplate(toolchain.paths.tectonic, [
      '--outdir',
      '{{output_dir}}',
      '--synctex',
      '--keep-logs',
      '--keep-intermediates',
      '--untrusted',
      '--makefile-rules',
      '{{output_dir}}/{{job_name}}.d',
      '{{source}}',
    ]);
  }
  const installed = LATEX_ENGINES.filter(
    (engine): engine is LatexEngine => toolchain.paths[engine] !== undefined,
  );
  const engine = selectDirectEngine(source, installed);
  const executable = engine ? toolchain.paths[engine] : undefined;
  if (!executable) return null;
  return commandTemplate(executable, [
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-file-line-error',
    '-no-shell-escape',
    '-synctex=1',
    '-recorder',
    '-output-directory={{output_dir}}',
    '{{source}}',
  ]);
}

/** Compile one already-resolved main document entirely inside `buildDir`. */
export async function compileLatex(options: CompileOptions): Promise<LatexBuildResult> {
  const runner = options.runner ?? runLatexCommand;
  const jobName = basename(options.source.absolute, extname(options.source.absolute));
  const pdfPath = join(options.buildDir, `${jobName}.pdf`);
  const synctexPath = join(options.buildDir, `${jobName}.synctex.gz`);
  const makefileRulesPath = join(options.buildDir, `${jobName}.d`);
  const logPath = join(options.buildDir, 'build.log');
  for (const stale of [
    pdfPath,
    synctexPath,
    join(options.buildDir, `${jobName}.fls`),
    makefileRulesPath,
  ]) {
    if (existsSync(stale)) unlinkSync(stale);
  }
  const sourceDirectory = dirname(options.source.absolute);
  const inherited = (name: string) => getEnv(process.env, name) ?? '';
  const env = withEnvironment({
    PATH: options.toolchain.searchPath,
    // A belt-and-braces fallback for TeX distributions that ignore an engine's
    // explicit output-directory option for a niche auxiliary file.
    TEXMFOUTPUT: options.buildDir,
    TEXINPUTS: `${sourceDirectory}//${delimiter}${inherited('TEXINPUTS')}`,
    BIBINPUTS: `${sourceDirectory}${delimiter}${inherited('BIBINPUTS')}`,
    BSTINPUTS: `${sourceDirectory}${delimiter}${inherited('BSTINPUTS')}`,
  });
  writeFileSync(logPath, `Puddle LaTeX build: ${new Date().toISOString()}\n`);

  const run = async (file: string, args: string[], cwd: string): Promise<LatexCommandResult> => {
    const command: LatexCommand = {
      file,
      args,
      cwd,
      env,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    };
    appendLog(logPath, `\n$ ${JSON.stringify([file, ...args])}\n`);
    try {
      const result = await runner(command);
      appendResult(logPath, result);
      return result;
    } catch (error) {
      if (error instanceof LatexCommandError && error.result) appendResult(logPath, error.result);
      const detail = error instanceof Error ? error.message : String(error);
      appendLog(logPath, `\n${detail}\n`);
      const captured =
        error instanceof LatexCommandError && error.result
          ? `${error.result.stdout}\n${error.result.stderr}\n${detail}`
          : detail;
      const output = boundedLatexOutput(captured);
      const diagnostics = parseLatexDiagnostics(
        output,
        options.source.absolute,
        dirname(options.source.absolute),
      );
      const first = diagnostics[0];
      const message = first
        ? `${basename(first.absolutePath)}:${first.line}: ${first.message}`
        : detail;
      throw new LatexBuildFailure(message, output, diagnostics);
    }
  };

  let compiler: string;
  if (options.command) {
    const custom = expandCommandTemplate(options.command, {
      source: options.source.absolute,
      output_dir: options.buildDir,
      job_name: jobName,
    });
    compiler = basename(custom.file);
    await run(custom.file, custom.args, dirname(options.source.absolute));
  } else if (options.toolchain.paths.latexmk) {
    compiler = 'latexmk';
    const mode = latexmkMode(options.source.engine);
    await run(
      options.toolchain.paths.latexmk,
      [
        mode,
        '-norc',
        '-interaction=nonstopmode',
        '-halt-on-error',
        '-file-line-error',
        '-synctex=1',
        '-recorder',
        '-no-shell-escape',
        `-outdir=${options.buildDir}`,
        options.source.absolute,
      ],
      dirname(options.source.absolute),
    );
  } else if (options.toolchain.paths.tectonic && options.source.engine === undefined) {
    compiler = 'tectonic';
    await run(
      options.toolchain.paths.tectonic,
      [
        '--outdir',
        options.buildDir,
        '--synctex',
        '--keep-logs',
        '--keep-intermediates',
        '--untrusted',
        '--makefile-rules',
        makefileRulesPath,
        options.source.absolute,
      ],
      dirname(options.source.absolute),
    );
  } else {
    const installed = LATEX_ENGINES.filter(
      (engine): engine is LatexEngine => options.toolchain.paths[engine] !== undefined,
    );
    const engine = selectDirectEngine(options.source, installed);
    if (!engine) {
      if (options.source.engine) {
        throw new ApiError(
          424,
          'latex_engine_not_installed',
          `${options.source.engine} is requested by the TeX source but is not installed on the daemon host`,
        );
      }
      throw new ApiError(
        424,
        'latex_not_installed',
        'No supported LaTeX compiler is installed on the daemon host',
      );
    }
    compiler = engine;
    const executable = options.toolchain.paths[engine];
    if (!executable) throw new Error(`discovered ${engine} without an executable path`);
    await directBuild({
      source: options.source,
      buildDir: options.buildDir,
      jobName,
      engine: executable,
      toolchain: options.toolchain,
      run,
    });
  }

  if (!existsSync(pdfPath)) {
    throw new ApiError(422, 'latex_no_pdf', 'The LaTeX command completed without producing a PDF', {
      log_root: options.buildDir,
      log_path: 'build.log',
    });
  }
  return {
    compiler,
    pdfPath,
    synctexPath: existsSync(synctexPath) ? synctexPath : null,
    dependencies: [
      ...new Set([
        ...flsDependencies(join(options.buildDir, `${jobName}.fls`)),
        ...makefileDependencies(makefileRulesPath),
      ]),
    ],
  };
}

async function directBuild(options: {
  source: ResolvedLatexSource;
  buildDir: string;
  jobName: string;
  engine: string;
  toolchain: LatexToolchain;
  run: (file: string, args: string[], cwd: string) => Promise<LatexCommandResult>;
}): Promise<void> {
  const engineArgs = [
    '-interaction=nonstopmode',
    '-halt-on-error',
    '-file-line-error',
    '-no-shell-escape',
    '-synctex=1',
    '-recorder',
    `-output-directory=${options.buildDir}`,
    options.source.absolute,
  ];
  let previousState: string | null = null;
  let bibliographyRun = false;
  for (let pass = 1; pass <= MAX_ENGINE_PASSES; pass += 1) {
    const result = await options.run(options.engine, engineArgs, dirname(options.source.absolute));
    if (!bibliographyRun) {
      bibliographyRun = await runBibliography(options);
      if (bibliographyRun) {
        previousState = null;
        continue;
      }
    }
    const state = auxiliaryState(options.buildDir, options.jobName);
    const rerunRequested =
      /rerun (?:latex|to get cross-references right)|label\(s\) may have changed/i.test(
        `${result.stdout}\n${result.stderr}`,
      );
    if (pass >= 2 && state === previousState && !rerunRequested) break;
    previousState = state;
  }
}

async function runBibliography(options: {
  buildDir: string;
  jobName: string;
  toolchain: LatexToolchain;
  run: (file: string, args: string[], cwd: string) => Promise<LatexCommandResult>;
}): Promise<boolean> {
  if (
    existsSync(join(options.buildDir, `${options.jobName}.bcf`)) &&
    options.toolchain.paths.biber
  ) {
    await options.run(options.toolchain.paths.biber, [options.jobName], options.buildDir);
    return true;
  }
  const aux = join(options.buildDir, `${options.jobName}.aux`);
  if (
    existsSync(aux) &&
    /\\bibdata\s*\{/.test(readFileSync(aux, 'utf8')) &&
    options.toolchain.paths.bibtex
  ) {
    await options.run(options.toolchain.paths.bibtex, [options.jobName], options.buildDir);
    return true;
  }
  return false;
}

function auxiliaryState(buildDir: string, jobName: string): string {
  const hash = createHash('sha256');
  for (const extension of ['aux', 'toc', 'out', 'bbl']) {
    const path = join(buildDir, `${jobName}.${extension}`);
    if (existsSync(path)) hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function latexmkMode(engine?: LatexEngine): '-pdf' | '-pdfxe' | '-pdflua' {
  if (engine === 'xelatex') return '-pdfxe';
  if (engine === 'lualatex') return '-pdflua';
  return '-pdf';
}

function appendResult(path: string, result: LatexCommandResult): void {
  appendLog(path, result.stdout);
  appendLog(path, result.stderr);
}

function appendLog(path: string, content: string): void {
  writeFileSync(path, content, { flag: 'a' });
}

function flsDependencies(path: string): string[] {
  if (!existsSync(path)) return [];
  const dependencies = new Set<string>();
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('INPUT ')) continue;
    const input = line.slice('INPUT '.length).trim();
    if (input) dependencies.add(input);
  }
  return [...dependencies];
}

/** Parse Tectonic's `--makefile-rules` dependency file without losing escaped paths. */
function makefileDependencies(path: string): string[] {
  if (!existsSync(path)) return [];
  const dependencies = new Set<string>();
  const logicalLines = readFileSync(path, 'utf8')
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/);
  for (const line of logicalLines) {
    const colon = ruleColon(line);
    if (colon < 0) continue;
    for (const dependency of makefileWords(line.slice(colon + 1))) {
      if (dependency) dependencies.add(dependency);
    }
  }
  return [...dependencies];
}

/** The rule separator is an unescaped colon followed by whitespace/end, not a drive colon. */
function ruleColon(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== ':' || isEscaped(line, index)) continue;
    const next = line[index + 1];
    if (next === undefined || /\s/.test(next)) return index;
  }
  return -1;
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function makefileWords(value: string): string[] {
  const words: string[] = [];
  let word = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === '#' && !isEscaped(value, index)) break;
    if (char === '\\') {
      const next = value[index + 1];
      if (
        next !== undefined &&
        (/\s/.test(next) || next === '\\' || next === '#' || next === ':')
      ) {
        word += next;
        index += 1;
      } else {
        // Preserve a platform-native separator such as `C:\\project`.
        word += char;
      }
      continue;
    }
    if (/\s/.test(char)) {
      if (word) words.push(word);
      word = '';
      continue;
    }
    word += char;
  }
  if (word) words.push(word);
  return words;
}
