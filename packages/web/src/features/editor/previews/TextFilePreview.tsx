import 'katex/dist/katex.min.css';
import type { PreviewKind } from './preview-kind';
import type { TextPreviewProps } from './preview-controls';
import { MarkdownPreview } from './markdown/MarkdownPreview';
import { NotebookPreview } from '../notebooks/NotebookPreview';
import { HtmlPreview } from './html/HtmlPreview';

export function TextFilePreview({ kind, ...props }: TextPreviewProps & { kind: PreviewKind }) {
  if (kind === 'notebook') return <NotebookPreview {...props} />;
  return kind === 'markdown' ? <MarkdownPreview {...props} /> : <HtmlPreview {...props} />;
}
