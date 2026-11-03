import { cssTokenReader, type ThemeName } from '../../../../lib/appearance/theme';

export const MERMAID_SELECTOR = '[data-puddle-mermaid]';

let nextDiagramId = 0;
let renderQueue: Promise<void> = Promise.resolve();

/**
 * Mermaid keeps process-wide configuration and render state. Serialise jobs so
 * two mounted previews cannot reset that state underneath one another.
 */
export function renderMermaidDiagrams(
  root: HTMLElement,
  theme: ThemeName,
  signal?: AbortSignal,
  compact = false,
): Promise<void> {
  const job = renderQueue.then(() => renderDiagrams(root, theme, signal, compact));
  renderQueue = job.catch(() => undefined);
  return job;
}

async function renderDiagrams(
  root: HTMLElement,
  theme: ThemeName,
  signal?: AbortSignal,
  compact = false,
): Promise<void> {
  if (signal?.aborted) return;
  const diagrams = [...root.querySelectorAll<HTMLElement>(MERMAID_SELECTOR)];
  if (diagrams.length === 0) return;

  let mermaid: (typeof import('mermaid'))['default'];
  try {
    ({ default: mermaid } = await import('mermaid'));
  } catch {
    if (!signal?.aborted) {
      for (const diagram of diagrams) showError(diagram, 'Mermaid could not be loaded');
    }
    return;
  }
  if (signal?.aborted) return;

  try {
    const read = cssTokenReader();
    const fontSize = getComputedStyle(root).fontSize;
    const spacing = Number.parseFloat(fontSize);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'base',
      htmlLabels: false,
      fontFamily: read('--font-sans'),
      // A terminal diagram has only its source rows available. Reduce empty
      // layout space before scaling, so its labels remain as large as possible.
      ...(compact && Number.isFinite(spacing)
        ? {
            flowchart: {
              nodeSpacing: spacing,
              rankSpacing: spacing * 2,
              padding: spacing / 2,
              subGraphTitleMargin: { top: spacing / 2, bottom: spacing },
            },
            sequence: { diagramMarginY: spacing / 2, messageMargin: spacing, actorMargin: spacing },
          }
        : {}),
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'maxEdges',
        'suppressErrorRendering',
        'theme',
        'themeCSS',
        'themeVariables',
        'fontFamily',
      ],
      themeVariables: {
        darkMode: theme === 'dark',
        background: read('--bg-base'),
        primaryColor: read('--bg-elevated'),
        primaryTextColor: read('--text-primary'),
        primaryBorderColor: read('--border'),
        secondaryColor: read('--bg-surface'),
        secondaryTextColor: read('--text-primary'),
        secondaryBorderColor: read('--border'),
        tertiaryColor: read('--bg-base'),
        tertiaryTextColor: read('--text-secondary'),
        tertiaryBorderColor: read('--border'),
        lineColor: read('--text-muted'),
        textColor: read('--text-primary'),
        fontFamily: read('--font-sans'),
        fontSize,
      },
    });
  } catch (error) {
    if (!signal?.aborted) {
      for (const diagram of diagrams) showError(diagram, errorMessage(error));
    }
    return;
  }

  for (const diagram of diagrams) {
    // Typing can queue another preview render faster than Mermaid can finish
    // the current parse. Drop obsolete queued work instead of making the live
    // diagram wait behind every intermediate buffer value.
    if (signal?.aborted || !diagram.isConnected) return;
    const source = diagram.textContent ?? '';
    const id = `puddle-mermaid-${nextDiagramId++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      // A buffer edit or unmount may have replaced this exact placeholder
      // while Mermaid was parsing it. Never write a stale diagram back.
      if (signal?.aborted || !diagram.isConnected) continue;
      diagram.innerHTML = svg;
      diagram.removeAttribute('data-puddle-mermaid');
    } catch (error) {
      document.getElementById(id)?.remove();
      if (!signal?.aborted && diagram.isConnected) showError(diagram, errorMessage(error));
    }
  }
}

function showError(diagram: HTMLElement, detail: string): void {
  if (diagram.querySelector('.mermaid-error')) return;
  const message = document.createElement('p');
  message.className = 'mermaid-error';
  message.textContent = 'Unable to render Mermaid diagram.';
  message.title = detail;
  diagram.prepend(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
