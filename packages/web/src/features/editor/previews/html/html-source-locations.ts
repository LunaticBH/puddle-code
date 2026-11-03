import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import {
  countSourceLines,
  SOURCE_END_LINE_ATTRIBUTE,
  SOURCE_LINE_ATTRIBUTE,
  SOURCE_LINE_COUNT_ATTRIBUTE,
} from '../source-anchor-map';

type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlElement = DefaultTreeAdapterTypes.Element;
type HtmlTemplate = DefaultTreeAdapterTypes.Template;

function isElement(node: HtmlNode): node is HtmlElement {
  return 'attrs' in node && 'tagName' in node;
}

function isTemplate(node: HtmlNode): node is HtmlTemplate {
  return isElement(node) && node.nodeName === 'template';
}

function replaceAttribute(element: HtmlElement, name: string, value?: string): void {
  element.attrs = element.attrs.filter((attribute) => attribute.name !== name);
  if (value !== undefined) element.attrs.push({ name, value });
}

function annotate(node: HtmlNode): void {
  if (isElement(node)) {
    // Reserved attributes are derived from this parse, never trusted from the
    // authored document. Parser-created html/head/body elements have no source
    // location and remain deliberately unmapped.
    replaceAttribute(node, SOURCE_LINE_ATTRIBUTE);
    replaceAttribute(node, SOURCE_END_LINE_ATTRIBUTE);
    const location = node.sourceCodeLocation;
    if (location) {
      replaceAttribute(node, SOURCE_LINE_ATTRIBUTE, String(location.startLine));
      replaceAttribute(node, SOURCE_END_LINE_ATTRIBUTE, String(location.endLine));
    }
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes) annotate(child);
  }
  if (isTemplate(node)) annotate(node.content);
}

/**
 * Parse authored HTML with parse5's source locations, attach those locations
 * to authored elements, then serialise for the existing DOM asset pipeline.
 * This is intentionally a focused parser pass rather than a rehype/unified
 * document stack.
 */
export function annotateHtmlSourceLocations(text: string): string {
  const document = parse(text, { sourceCodeLocationInfo: true });
  annotate(document);
  const html = document.childNodes.find(
    (node): node is HtmlElement => isElement(node) && node.tagName === 'html',
  );
  if (html) {
    replaceAttribute(html, SOURCE_LINE_COUNT_ATTRIBUTE, String(countSourceLines(text)));
  }
  return serialize(document);
}
