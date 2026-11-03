import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import {
  compilationFileTargetSchema,
  type CompilationDiagnostic,
  type CompilationFileTarget,
  type LatexSynctexRequest,
  type LatexSynctexResponse,
} from '@puddle/shared';
import { renameWithRetrySync } from '@puddle/shared/node/platform';
import type { RepoStore } from '../db/stores/repos.js';
import type { SessionStore } from '../db/stores/sessions.js';
import type { CompilationProvider, CompilationProviderResult } from '../compilation/provider.js';
import { expandCommandTemplate, parseCommandTemplate } from '../compilation/command-template.js';
import { withEnvironment } from '../compilation/environment.js';
import { sameHostPath } from '../host-path.js';
import { KeyedMutex } from '../git/mutex.js';
import { ApiError } from '../http/errors.js';
import {
  containedPath,
  NO_SESSION,
  resolveFsRoot,
} from '../http/routes/worktrees/worktree-shared.js';
import { compileLatex, defaultLatexCommand } from './compiler.js';
import { LatexBuildFailure, type LatexSourceDiagnostic } from './diagnostics.js';
import { discoverLatexToolchain } from './discovery.js';
import { LatexCommandError, runLatexCommand, type LatexCommandRunner } from './process.js';
import { resolveLatexSource } from './source.js';
import { capabilitiesOf, type LatexToolchain } from './toolchain.js';

const MANIFEST_VERSION = 1;

interface LatexManifest {
  version: number;
  source: CompilationFileTarget;
  pdf: CompilationFileTarget & { root: string };
  sourceAbsolute: string;
  sourceRoot: string;
  synctexPath: string | null;
}

export interface LatexProviderDeps {
  sessions: SessionStore;
  repos: RepoStore;
  discover?: () => LatexToolchain;
  runner?: LatexCommandRunner;
  timeoutMs?: number;
}

/** Host-side LaTeX compilation and inverse SyncTeX lookup. */
export class LatexProvider implements CompilationProvider {
  readonly id = 'latex';
  readonly displayName = 'LaTeX';
  readonly extensions = ['tex'] as const;
  readonly inputExtensions = ['tex', 'bib', 'sty', 'cls', 'bst'] as const;
  readonly eager = true;
  private readonly mutex = new KeyedMutex();

  constructor(private readonly deps: LatexProviderDeps) {}

  capability(): { available: boolean; executor: string | null } {
    const capabilities = capabilitiesOf(this.toolchain());
    return { available: capabilities.available, executor: capabilities.preferred };
  }

  commandConfiguration(request: CompilationFileTarget) {
    const root = resolveFsRoot(this.deps, request.session, request.root);
    const requested = containedPath(root, request.path);
    if (!existsSync(requested) || !statSync(requested).isFile()) {
      throw ApiError.notFound('compilation source', request.path);
    }
    const source = resolveLatexSource(root, request.path);
    const command = defaultLatexCommand(source, this.toolchain());
    return {
      filePath: safeRealpath(requested),
      ...this.languageConfiguration(),
      defaults: { on_demand: command, eager: command },
    };
  }

  languageConfiguration() {
    const command = defaultLatexCommand({ content: '' }, this.toolchain());
    return {
      fileType: 'tex',
      variables: [
        {
          placeholder: '{{source}}',
          description: 'Absolute path of the resolved root TeX document',
        },
        {
          placeholder: '{{output_dir}}',
          description: 'Managed directory for this run below the source root’s local .puddle',
        },
        { placeholder: '{{job_name}}', description: 'Output basename without the .tex suffix' },
      ],
      defaults: { on_demand: command, eager: command },
    };
  }

  validateCommand(_request: CompilationFileTarget | null, command: string): void {
    parseCommandTemplate(command);
    expandCommandTemplate(command, {
      source: '/source/main.tex',
      output_dir: '/source/.puddle/latex/build/runs/run',
      job_name: 'main',
    });
    if (!command.includes('{{output_dir}}')) {
      throw ApiError.badRequest(
        'invalid_compilation_command',
        'A LaTeX command must use {{output_dir}} so generated files stay inside local .puddle',
      );
    }
  }

  watchInputs(request: CompilationFileTarget): string[] {
    const root = resolveFsRoot(this.deps, request.session, request.root);
    const source = resolveLatexSource(root, request.path);
    return [...new Set([source.requestedAbsolute, source.absolute])];
  }

  async run(
    request: CompilationFileTarget,
    options: { command: string | null } = { command: null },
  ): Promise<CompilationProviderResult> {
    const root = resolveFsRoot(this.deps, request.session, request.root);
    const source = resolveLatexSource(root, request.path);
    const identity = safeRealpath(source.absolute);
    const buildKey = createHash('sha256').update(identity).digest('hex').slice(0, 24);
    const buildRoot = join(root, '.puddle', 'latex', buildKey);
    const runsDir = join(buildRoot, 'runs');
    const runDir = join(runsDir, `${Date.now()}-${randomUUID()}`);
    const currentDir = join(buildRoot, 'current');

    return this.mutex.run(buildKey, async () => {
      const toolchain = this.toolchain();
      if (!capabilitiesOf(toolchain).available) {
        throw new ApiError(
          424,
          'latex_not_installed',
          'No supported LaTeX compiler is installed on the daemon host',
        );
      }
      mkdirSync(runDir, { recursive: true, mode: 0o700 });
      try {
        let built: Awaited<ReturnType<typeof compileLatex>>;
        try {
          built = await compileLatex({
            source,
            buildDir: runDir,
            toolchain,
            ...(this.deps.runner ? { runner: this.deps.runner } : {}),
            ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
            ...(options.command !== null ? { command: options.command } : {}),
          });
        } catch (error) {
          if (!(error instanceof LatexBuildFailure)) throw error;
          throw new ApiError(422, 'latex_compile_failed', error.message, {
            source: sourceTargetFor(root, request, source.relative),
            log_root: runDir,
            log_path: 'build.log',
            output: error.output,
            diagnostics: normaliseDiagnostics(root, request, error.diagnostics),
          });
        }
        const sourceTarget = sourceTargetFor(root, request, source.relative);
        mkdirSync(currentDir, { recursive: true, mode: 0o700 });
        const promoted = promoteBuild(currentDir, built.pdfPath, built.synctexPath, runDir);
        const pdf = {
          session: request.session,
          path: basename(promoted.pdfPath),
          root: currentDir,
        };
        const navigable = promoted.synctexPath !== null && toolchain.paths.synctex !== undefined;
        // Manifest last: it always describes a complete stable artifact set.
        writeManifest(currentDir, {
          version: MANIFEST_VERSION,
          source: sourceTarget,
          pdf,
          sourceAbsolute: source.absolute,
          sourceRoot: root,
          synctexPath: promoted.synctexPath,
        });
        return {
          executor: built.compiler,
          source: sourceTarget,
          artifacts: [{ role: 'preview', media_type: 'application/pdf', file: pdf }],
          ...(navigable ? { navigation: { kind: 'synctex' } } : {}),
          dependencies: sourceDependencies(root, source.absolute, built.dependencies),
        };
      } finally {
        pruneRuns(runsDir, 5);
      }
    });
  }

  async inverseSearch(request: LatexSynctexRequest): Promise<LatexSynctexResponse> {
    const { buildDir, sourceRoot } = this.validBuildRoot(request.root);
    const pdfPath = containedPath(buildDir, request.path);
    if (!existsSync(pdfPath) || !statSync(pdfPath).isFile()) {
      throw ApiError.notFound('PDF', request.path);
    }
    const manifest = readManifest(buildDir);
    if (
      manifest.pdf.session !== request.session ||
      manifest.pdf.path !== request.path ||
      !sameHostPath(normalize(manifest.pdf.root), buildDir) ||
      !sameHostPath(normalize(manifest.sourceRoot), sourceRoot) ||
      !validManifestSource(manifest, sourceRoot, basename(dirname(buildDir)))
    ) {
      throw ApiError.badRequest('invalid_latex_output', 'PDF does not match its LaTeX manifest');
    }
    if (!manifest.synctexPath || !existsSync(manifest.synctexPath)) {
      throw ApiError.badRequest('synctex_unavailable', 'This PDF has no SyncTeX index');
    }
    const expectedSynctex = join(buildDir, `${basename(pdfPath, '.pdf')}.synctex.gz`);
    if (!sameHostPath(normalize(manifest.synctexPath), expectedSynctex)) {
      throw ApiError.badRequest('invalid_latex_output', 'SyncTeX index is outside the PDF output');
    }
    const toolchain = this.toolchain();
    const executable = toolchain.paths.synctex;
    if (!executable) {
      throw new ApiError(
        424,
        'synctex_not_installed',
        'synctex is not installed on the daemon host',
      );
    }

    let output: string;
    try {
      const result = await (this.deps.runner ?? runLatexCommand)({
        file: executable,
        args: ['edit', '-o', `${request.page}:${request.x}:${request.y}:${pdfPath}`],
        cwd: buildDir,
        env: withEnvironment({ PATH: toolchain.searchPath }),
        ...(this.deps.timeoutMs !== undefined ? { timeoutMs: this.deps.timeoutMs } : {}),
      });
      output = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      const message = error instanceof LatexCommandError ? error.message : String(error);
      throw new ApiError(422, 'synctex_failed', message);
    }

    const match = parseSynctexResult(output, dirname(manifest.sourceAbsolute));
    if (!match || !existsSync(match.input) || !statSync(match.input).isFile()) {
      throw ApiError.notFound('SyncTeX source', request.path);
    }
    const rel = relative(manifest.sourceRoot, match.input);
    const insideRoot = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    if (!insideRoot) {
      throw ApiError.badRequest(
        'synctex_source_outside_root',
        'SyncTeX resolved a source outside the compiled file root',
      );
    }
    return {
      session: manifest.source.session,
      path: rel.split('\\').join('/'),
      ...(manifest.source.root ? { root: manifest.source.root } : {}),
      line: match.line,
      ...(match.column !== undefined ? { column: match.column } : {}),
    };
  }

  private toolchain(): LatexToolchain {
    return (this.deps.discover ?? discoverLatexToolchain)();
  }

  private validBuildRoot(rawRoot: string): { buildDir: string; sourceRoot: string } {
    const root = normalize(rawRoot);
    if (!isAbsolute(root)) {
      throw ApiError.badRequest('invalid_latex_output', 'LaTeX output root must be absolute');
    }
    const buildRoot = dirname(root);
    const latexRoot = dirname(buildRoot);
    const puddleRoot = dirname(latexRoot);
    const sourceRoot = dirname(puddleRoot);
    const buildKey = basename(buildRoot);
    if (
      basename(root) !== 'current' ||
      !/^[0-9a-f]{24}$/.test(buildKey) ||
      basename(latexRoot) !== 'latex' ||
      basename(puddleRoot) !== '.puddle'
    ) {
      throw ApiError.badRequest('invalid_latex_output', 'PDF is not a Puddle LaTeX output');
    }
    return {
      buildDir: containedPath(join(sourceRoot, '.puddle', 'latex'), join(buildKey, 'current')),
      sourceRoot,
    };
  }
}

function validManifestSource(
  manifest: LatexManifest,
  sourceRoot: string,
  buildKey: string,
): boolean {
  if (!existsSync(manifest.sourceAbsolute) || !statSync(manifest.sourceAbsolute).isFile()) {
    return false;
  }
  let sourceFromTarget: string;
  try {
    sourceFromTarget = containedPath(sourceRoot, manifest.source.path);
  } catch {
    return false;
  }
  const expectedKey = createHash('sha256')
    .update(safeRealpath(manifest.sourceAbsolute))
    .digest('hex')
    .slice(0, 24);
  return (
    sameHostPath(normalize(sourceFromTarget), normalize(manifest.sourceAbsolute)) &&
    expectedKey === buildKey
  );
}

function promoteBuild(
  currentDir: string,
  pdfSource: string,
  synctexSource: string | null,
  runDir: string,
): { pdfPath: string; synctexPath: string | null } {
  const suffix = `.next-${randomUUID()}`;
  const pdfPath = join(currentDir, basename(pdfSource));
  const pdfNext = `${pdfPath}${suffix}`;
  const logPath = join(currentDir, 'build.log');
  const logNext = `${logPath}${suffix}`;
  const synctexPath = synctexSource ? join(currentDir, basename(synctexSource)) : null;
  const synctexNext = synctexPath ? `${synctexPath}${suffix}` : null;
  const staged = [pdfNext, logNext, ...(synctexNext ? [synctexNext] : [])];
  try {
    copyFileSync(pdfSource, pdfNext);
    copyFileSync(join(runDir, 'build.log'), logNext);
    if (synctexSource && synctexNext) copyFileSync(synctexSource, synctexNext);
    // A viewer streaming the previous PDF briefly blocks its replacement on Windows.
    renameWithRetrySync(pdfNext, pdfPath);
    renameWithRetrySync(logNext, logPath);
    if (synctexPath && synctexNext) renameWithRetrySync(synctexNext, synctexPath);
    else removeIfPresent(join(currentDir, `${basename(pdfSource, '.pdf')}.synctex.gz`));
    return { pdfPath, synctexPath };
  } finally {
    for (const path of staged) removeIfPresent(path);
  }
}

function pruneRuns(
  runsDir: string,
  keep: number,
  platform: NodeJS.Platform = process.platform,
): void {
  let runs: string[];
  try {
    runs = readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return;
  }
  for (const name of runs.slice(keep)) {
    if (platform !== 'win32') {
      rmSync(join(runsDir, name), { recursive: true, force: true });
      continue;
    }
    try {
      rmSync(join(runsDir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // A TeX process stopped after a timeout, or a virus scanner, may still
      // hold a file open. The next build prunes the run instead of failing.
    }
  }
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing temporary/old navigation file.
  }
}

function parseSynctexResult(
  output: string,
  sourceDirectory: string,
): { input: string; line: number; column?: number } | null {
  let input: string | undefined;
  let line: number | undefined;
  let column: number | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.startsWith('Input:') && input === undefined) {
      const value = unquote(rawLine.slice('Input:'.length).trim());
      input = isAbsolute(value) ? normalize(value) : resolve(sourceDirectory, value);
    } else if (rawLine.startsWith('Line:') && line === undefined) {
      const value = Number.parseInt(rawLine.slice('Line:'.length), 10);
      if (Number.isInteger(value) && value > 0) line = value;
    } else if (rawLine.startsWith('Column:') && column === undefined) {
      const value = Number.parseInt(rawLine.slice('Column:'.length), 10);
      if (Number.isInteger(value) && value >= 0) column = value;
    }
  }
  return input && line ? { input, line, ...(column !== undefined ? { column } : {}) } : null;
}

function writeManifest(buildDir: string, manifest: LatexManifest): void {
  const target = join(buildDir, 'manifest.json');
  const temporary = join(buildDir, 'manifest.json.tmp');
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameWithRetrySync(temporary, target);
}

function readManifest(buildDir: string): LatexManifest {
  const path = join(buildDir, 'manifest.json');
  if (!existsSync(path)) throw ApiError.notFound('LaTeX manifest', path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw ApiError.badRequest('invalid_latex_output', 'LaTeX manifest is invalid');
  }
  if (!isRecord(value) || value.version !== MANIFEST_VERSION) {
    throw ApiError.badRequest('invalid_latex_output', 'LaTeX manifest version is unsupported');
  }
  const source = compilationFileTargetSchema.safeParse(value.source);
  const pdf = compilationFileTargetSchema.safeParse(value.pdf);
  if (
    !source.success ||
    !pdf.success ||
    pdf.data.root === undefined ||
    typeof value.sourceAbsolute !== 'string' ||
    typeof value.sourceRoot !== 'string' ||
    (value.synctexPath !== null && typeof value.synctexPath !== 'string')
  ) {
    throw ApiError.badRequest('invalid_latex_output', 'LaTeX manifest is invalid');
  }
  return {
    version: MANIFEST_VERSION,
    source: source.data,
    pdf: { ...pdf.data, root: pdf.data.root },
    sourceAbsolute: value.sourceAbsolute,
    sourceRoot: value.sourceRoot,
    synctexPath: value.synctexPath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function sourceDependencies(root: string, source: string, reported: readonly string[]): string[] {
  const dependencies = new Set<string>([source]);
  const managedRoot = join(root, '.puddle', 'latex');
  for (const input of reported) {
    const path = normalize(isAbsolute(input) ? input : resolve(dirname(source), input));
    const rel = relative(root, path);
    const managedRel = relative(managedRoot, path);
    const inManagedOutput =
      managedRel === '' || (!managedRel.startsWith('..') && !isAbsolute(managedRel));
    if (
      rel === '' ||
      rel.startsWith('..') ||
      isAbsolute(rel) ||
      inManagedOutput ||
      !existsSync(path)
    )
      continue;
    dependencies.add(path);
  }
  return [...dependencies];
}

function sourceTargetFor(
  root: string,
  request: CompilationFileTarget,
  path: string,
): CompilationFileTarget {
  return {
    session: request.session,
    path,
    ...(request.root !== undefined || request.session === NO_SESSION ? { root } : {}),
  };
}

function normaliseDiagnostics(
  root: string,
  request: CompilationFileTarget,
  diagnostics: readonly LatexSourceDiagnostic[],
): CompilationDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    const rel = relative(root, diagnostic.absolutePath);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return [];
    return [
      {
        source: sourceTargetFor(root, request, rel.split('\\').join('/')),
        severity: diagnostic.severity,
        message: diagnostic.message,
        line: diagnostic.line,
        ...(diagnostic.column !== undefined ? { column: diagnostic.column } : {}),
      },
    ];
  });
}
