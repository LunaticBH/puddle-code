import { findMath, renderMathHtml, type MathMacros } from './math';

/**
 * LaTeX in an HTML preview (SPEC §8): the same delimiters the markdown preview
 * honours, typeset into the parsed document BEFORE it is serialised into the
 * sandboxed iframe — the null-origin document runs on its own, so it can never
 * be handed a typesetter that reaches back here. The document is a detached
 * `DOMParser` tree: setting innerHTML on it neither runs scripts nor fetches
 * anything.
 */

/** Text that is markup, code, or already maths is left exactly as written. */
const SKIP_INSIDE = 'script, style, pre, code, kbd, samp, textarea, math, svg, .katex';

/** Documents that ship their own typesetter are left for it to render. */
const OWN_TYPESETTER = /\bmathjax\b|\bkatex\b/i;

/**
 * Typeset every maths span in `doc`, in place. Returns whether anything was
 * rendered — the caller only pays for the KaTeX stylesheet when it was.
 */
export function renderMathInDocument(doc: Document): boolean {
  if (bringsOwnMath(doc)) return false;
  const root = doc.body ?? doc.documentElement;
  if (!root) return false;
  return renderMathInElement(root);
}

/** Also used by live widget labels and Output renderers inside their sandbox. */
export function renderMathInElement(root: HTMLElement): boolean {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const candidates: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!/[$\\]/.test(node.data)) continue;
    if (node.parentElement?.closest(SKIP_INSIDE)) continue;
    candidates.push(node);
  }

  // Collected first: replacing a node while the walker is on it loses the rest.
  const macros: MathMacros = {};
  let rendered = false;
  for (const node of candidates) {
    if (typesetTextNode(doc, node, macros)) rendered = true;
  }
  return rendered;
}

function bringsOwnMath(doc: Document): boolean {
  if (doc.querySelector('.katex, math')) return true;
  for (const script of doc.querySelectorAll('script')) {
    if (OWN_TYPESETTER.test(script.getAttribute('src') ?? '')) return true;
    if (OWN_TYPESETTER.test(script.textContent ?? '')) return true;
  }
  return false;
}

/** Split one text node into prose and typeset maths; false if it held none. */
function typesetTextNode(doc: Document, node: Text, macros: MathMacros): boolean {
  const text = node.data;
  if (!findMath(text)) return false;

  const out = doc.createDocumentFragment();
  const holder = doc.createElement('span');
  let at = 0;
  for (let match = findMath(text, 0); match; match = findMath(text, at)) {
    if (match.start > at) out.appendChild(doc.createTextNode(text.slice(at, match.start)));
    holder.innerHTML = renderMathHtml(match.tex, match.display, macros);
    while (holder.firstChild) out.appendChild(holder.firstChild);
    at = match.start + match.length;
  }
  if (at < text.length) out.appendChild(doc.createTextNode(text.slice(at)));
  node.replaceWith(out);
  return true;
}
