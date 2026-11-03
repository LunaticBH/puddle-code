import { MATH_LAYOUT_CSS } from '../markdown/math';
import { renderMathInDocument } from '../markdown/math-dom';
import { parsePreviewSrcset, resolvePreviewAsset, serialisePreviewSrcset } from '../preview-kind';
import { appendHtmlPreviewScrollBridge } from './html-preview-scroll';
import { appendHtmlPreviewFindBridge } from './html-preview-find';
import { annotateHtmlSourceLocations } from './html-source-locations';
import { fetchPreviewAsset } from '../preview-assets';

/** (element selector, URL attribute) pairs whose worktree references get inlined. */
const HTML_ASSET_ATTRS: ReadonlyArray<readonly [string, string]> = [
  ['img', 'src'],
  ['script', 'src'],
  ['link[rel~="stylesheet" i]', 'href'],
  ['link[rel~="icon" i]', 'href'],
  ['source', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
];

/** Responsive image candidates need every worktree URL rewritten separately. */
const HTML_SRCSET_SELECTORS = ['img[srcset]', 'source[srcset]'] as const;

/** Assets above this stay unresolved — data URIs live in memory as the document. */
const MAX_INLINE_ASSET_BYTES = 20 * 1024 * 1024;

/**
 * Rewrite the document's worktree asset references (relative or /-absolute;
 * img/script/stylesheet/icon/media) to data URIs fetched through the authed
 * API, and typeset its maths. Nested references — url(…) inside stylesheets,
 * imports inside scripts — are not chased.
 */
export async function inlineWorktreeAssets(
  session: string,
  docPath: string,
  text: string,
  cache: Map<string, Promise<string | null>>,
  baseFontSize?: number,
  root?: string,
  bridgeChannel?: string,
  findChannel?: string,
): Promise<string> {
  const parsed = new DOMParser().parseFromString(annotateHtmlSourceLocations(text), 'text/html');
  // The preview follows the editor font size, as a ZERO-specificity default
  // (`:where`), prepended so any stylesheet the document carries wins.
  if (baseFontSize !== undefined) {
    const base = parsed.createElement('style');
    base.textContent = `:where(html) { font-size: ${baseFontSize}px; }`;
    const head = parsed.head ?? parsed.documentElement;
    head.insertBefore(base, head.firstChild);
  }
  if (renderMathInDocument(parsed)) await inlineKatexStyles(parsed);
  const jobs: Array<Promise<void>> = [];
  for (const [selector, attr] of HTML_ASSET_ATTRS) {
    for (const el of parsed.querySelectorAll(selector)) {
      const resolved = resolvePreviewAsset(docPath, el.getAttribute(attr) ?? '');
      if (!resolved) continue;
      el.removeAttribute(attr); // never let the iframe chase the raw reference
      jobs.push(
        fetchDataUri(session, resolved, cache, root).then((uri) => {
          if (uri) el.setAttribute(attr, uri);
        }),
      );
    }
  }
  for (const selector of HTML_SRCSET_SELECTORS) {
    for (const el of parsed.querySelectorAll(selector)) {
      const candidates = parsePreviewSrcset(el.getAttribute('srcset') ?? '');
      const paths = candidates.map(({ ref }) => resolvePreviewAsset(docPath, ref));
      if (!paths.some((resolved) => resolved !== null)) continue;
      el.removeAttribute('srcset');
      jobs.push(
        Promise.all(
          candidates.map(async (candidate, index) => {
            const resolved = paths[index];
            if (!resolved) return candidate;
            const ref = await fetchDataUri(session, resolved, cache, root);
            return ref ? { ...candidate, ref } : null;
          }),
        ).then((rewritten) => {
          const available = rewritten.filter((candidate) => candidate !== null);
          if (available.length > 0) {
            el.setAttribute('srcset', serialisePreviewSrcset(available));
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (bridgeChannel) appendHtmlPreviewScrollBridge(parsed, bridgeChannel);
  if (findChannel) appendHtmlPreviewFindBridge(parsed, findChannel);
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

/**
 * Give a document that turned out to hold maths the KaTeX stylesheet, fonts
 * baked in (`plugins/katex-css.ts`) — the iframe's null origin cannot fetch
 * them from here. Loaded on demand: a document without maths never pays for
 * the ~400 KB of embedded faces.
 */
async function inlineKatexStyles(doc: Document): Promise<void> {
  const { default: css } = await import('virtual:katex-inline-css');
  const style = doc.createElement('style');
  style.textContent = `${css}\n${MATH_LAYOUT_CSS}`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

function fetchDataUri(
  session: string,
  path: string,
  cache: Map<string, Promise<string | null>>,
  root?: string,
): Promise<string | null> {
  const hit = cache.get(path);
  if (hit) return hit;
  const job = fetchPreviewAsset(session, path, root)
    .then(async (blob) => {
      if (blob.size > MAX_INLINE_ASSET_BYTES) return null;
      return `data:${inlineMime(path, blob.type)};base64,${base64Of(await blob.arrayBuffer())}`;
    })
    .catch(() => null); // a missing asset just stays blank, like a browser
  cache.set(path, job);
  return job;
}

/**
 * The MIME a data URI must carry for the browser to honour the asset: the
 * media endpoint falls back to octet-stream for types it does not know
 * (css/js), under which a stylesheet or script data URI would be ignored.
 */
function inlineMime(path: string, fromServer: string): string {
  const ext = (path.split('/').pop() ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'css') return 'text/css';
  if (ext === 'js' || ext === 'mjs') return 'text/javascript';
  return fromServer !== '' && fromServer !== 'application/octet-stream'
    ? fromServer
    : 'application/octet-stream';
}

function base64Of(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000; // String.fromCharCode arg-count limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
