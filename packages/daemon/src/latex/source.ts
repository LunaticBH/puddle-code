import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { ApiError } from '../http/errors.js';
import { containedPath } from '../http/routes/worktrees/worktree-shared.js';
import type { LatexEngine } from './toolchain.js';

const MAX_DIRECTIVE_BYTES = 2 * 1024 * 1024;
const DIRECTIVE_LINES = 100;

export interface ResolvedLatexSource {
  requestedAbsolute: string;
  absolute: string;
  relative: string;
  engine?: LatexEngine;
  content: string;
}

/** Resolve a requested TeX file and its optional `% !TEX root` document. */
export function resolveLatexSource(root: string, requestedPath: string): ResolvedLatexSource {
  const requested = validateTexFile(root, requestedPath);
  const requestedContent = readTex(requested);
  const directives = texDirectives(requestedContent);
  let absolute = requested;

  if (directives.root) {
    const candidate = resolve(dirname(requested), directives.root);
    const rel = relative(root, candidate);
    // Pass back through the same lexical confinement as the file API: magic
    // comments must never turn a relative file target into an arbitrary path.
    absolute = validateTexFile(root, rel);
  }

  const content = absolute === requested ? requestedContent : readTex(absolute);
  const rootProgram = absolute === requested ? undefined : texDirectives(content).program;
  const rel = relative(root, absolute);
  return {
    requestedAbsolute: requested,
    absolute,
    relative: rel.split('\\').join('/'),
    ...((directives.program ?? rootProgram) ? { engine: directives.program ?? rootProgram } : {}),
    content,
  };
}

export function texDirectives(content: string): { root?: string; program?: LatexEngine } {
  let root: string | undefined;
  let program: LatexEngine | undefined;
  for (const line of content.split(/\r?\n/, DIRECTIVE_LINES)) {
    const match = /^\s*%\s*!TEX\s+(root|program)\s*=\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    const key = match[1]?.toLowerCase();
    const value = stripQuotes(match[2] ?? '');
    if (key === 'root' && value && !isAbsolute(value) && !value.includes('\0')) root = value;
    if (key === 'program') program = normaliseEngine(value) ?? program;
  }
  return { ...(root ? { root } : {}), ...(program ? { program } : {}) };
}

export function selectDirectEngine(
  source: Pick<ResolvedLatexSource, 'engine' | 'content'>,
  installed: readonly LatexEngine[],
): LatexEngine | null {
  if (source.engine && installed.includes(source.engine)) return source.engine;
  if (source.engine) return null;
  const needsUnicodeEngine =
    /\\(?:usepackage\s*\{[^}]*fontspec|setmainfont|setsansfont|setmonofont)\b/i.test(
      source.content,
    );
  if (needsUnicodeEngine) {
    if (installed.includes('xelatex')) return 'xelatex';
    if (installed.includes('lualatex')) return 'lualatex';
  }
  for (const engine of ['pdflatex', 'xelatex', 'lualatex'] as const) {
    if (installed.includes(engine)) return engine;
  }
  return null;
}

function validateTexFile(root: string, rel: string): string {
  const path = containedPath(root, rel);
  if (extname(path).toLowerCase() !== '.tex') {
    throw ApiError.badRequest('not_a_tex_file', `${rel} is not a .tex file`);
  }
  if (!existsSync(path)) throw ApiError.notFound('file', rel);
  const stat = statSync(path);
  if (!stat.isFile()) throw ApiError.badRequest('not_a_file', `${rel} is not a file`);
  if (stat.size > MAX_DIRECTIVE_BYTES) {
    throw new ApiError(413, 'tex_file_too_large', `${rel} is too large to compile`);
  }
  return path;
}

function readTex(path: string): string {
  return readFileSync(path, 'utf8');
}

function stripQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}

function normaliseEngine(value: string): LatexEngine | null {
  switch (value.toLowerCase().replace(/[\s_-]/g, '')) {
    case 'pdftex':
    case 'pdflatex':
      return 'pdflatex';
    case 'xetex':
    case 'xelatex':
      return 'xelatex';
    case 'luatex':
    case 'lualatex':
      return 'lualatex';
    default:
      return null;
  }
}
