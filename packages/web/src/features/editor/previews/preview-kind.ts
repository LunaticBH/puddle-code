/**
 * Which text files offer a rendered preview beside their Monaco source
 * (SPEC §8): markdown (rendered inline, theme-styled) and HTML (a sandboxed
 * iframe). Pure and DOM-free — the tab strip branches on it eagerly, so it
 * must stay outside the lazy editor chunk, like media-kind.ts.
 */

export type PreviewKind = 'markdown' | 'html' | 'notebook';

const BY_EXT: Record<string, PreviewKind> = {
  ipynb: 'notebook',
  md: 'markdown',
  markdown: 'markdown',
  mdown: 'markdown',
  html: 'html',
  htm: 'html',
};

/** The preview kind for a path, or null when only the source view applies. */
export function previewKind(path: string): PreviewKind | null {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null; // no extension, or a leading-dot dotfile
  return BY_EXT[base.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Resolve an asset reference inside a previewed document against the worktree:
 * relative (`img.png`, `./img.png`, `../shots/a.png`) resolves against the
 * document's directory; absolute (`/assets/logo.svg`) against the worktree
 * ROOT — a previewed document's universe is its worktree, never the host
 * filesystem. Yields a worktree-relative path the media endpoint accepts.
 * Returns null for anything else: URLs (http, data, blob, mailto, …) and
 * protocol-relative `//host/…` refs are left for the browser, fragments have
 * no file, and references escaping the worktree root are refused.
 */
export function resolvePreviewAsset(docPath: string, ref: string): string | null {
  if (
    ref === '' ||
    ref.startsWith('#') ||
    ref.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:/i.test(ref)
  ) {
    return null;
  }
  const clean = ref.split('#')[0]!.split('?')[0]!;
  if (clean === '' || clean === '/') return null;
  const dir = clean.startsWith('/') ? [] : docPath.split('/').slice(0, -1);
  const out = [...dir];
  for (const part of decodeURI(clean).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null; // escapes the worktree root
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.length > 0 ? out.join('/') : null;
}

export type PreviewSrcsetCandidate = {
  ref: string;
  descriptor: string;
};

/**
 * Parse the URL + optional descriptor candidates in an HTML `srcset`. This
 * follows the browser's whitespace-delimited URL shape rather than splitting
 * blindly on commas, because data URLs contain a comma of their own.
 */
export function parsePreviewSrcset(srcset: string): PreviewSrcsetCandidate[] {
  const candidates: PreviewSrcsetCandidate[] = [];
  let cursor = 0;
  const whitespace = (char: string) => /[\t\n\f\r ]/.test(char);

  while (cursor < srcset.length) {
    while (cursor < srcset.length && (whitespace(srcset[cursor]!) || srcset[cursor] === ',')) {
      cursor += 1;
    }
    if (cursor >= srcset.length) break;

    const refStart = cursor;
    while (cursor < srcset.length && !whitespace(srcset[cursor]!)) cursor += 1;
    let ref = srcset.slice(refStart, cursor);

    // A candidate without a descriptor carries its separator on the URL token
    // (`one.png, two.png 2x`). Commas inside a data URL are not trailing.
    if (ref.endsWith(',')) {
      ref = ref.replace(/,+$/, '');
      if (ref !== '') candidates.push({ ref, descriptor: '' });
      continue;
    }

    while (cursor < srcset.length && whitespace(srcset[cursor]!)) cursor += 1;
    const descriptorStart = cursor;
    while (cursor < srcset.length && srcset[cursor] !== ',') cursor += 1;
    const descriptor = srcset.slice(descriptorStart, cursor).trim();
    if (cursor < srcset.length) cursor += 1;
    if (ref !== '') candidates.push({ ref, descriptor });
  }

  return candidates;
}

/** Serialise candidates after their repository references have been rewritten. */
export function serialisePreviewSrcset(candidates: PreviewSrcsetCandidate[]): string {
  return candidates
    .map(({ ref, descriptor }) => `${ref}${descriptor === '' ? '' : ` ${descriptor}`}`)
    .join(', ');
}
