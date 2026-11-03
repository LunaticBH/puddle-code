import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  notebookWidgetCommSchema,
  type NotebookWidgetState,
  type NotebookWidgetsResponse,
} from '@puddle/shared';
import { WidgetContext } from './context';
import type { WidgetSession } from './session';
import { currentTheme, onThemeChange } from '../../../../lib/appearance/theme';

const subscribeNothing = () => () => {};
const stopped: NotebookWidgetsResponse = { generation: null, revision: 0, events: [] };
const stoppedSnapshot = () => stopped;

export default function NotebookWidget({
  modelId,
  fallback,
}: {
  modelId: string;
  fallback: string;
}) {
  const context = useContext(WidgetContext);
  const session = context?.session;
  const status = useSyncExternalStore(
    session?.subscribe ?? subscribeNothing,
    session?.getSnapshot ?? stoppedSnapshot,
  );
  const live = !!session?.state.state[modelId] && !!status.generation && !status.error;
  const snapshot = live ? session!.state : context?.saved;
  const [extensions, setExtensions] = useState(false);
  if (!snapshot?.state[modelId])
    return (
      <div className="text-xs text-fg-muted">
        {fallback && (
          <pre className="whitespace-pre-wrap font-mono text-sm text-fg-secondary">{fallback}</pre>
        )}
        <p>
          {status.error ??
            (session
              ? 'Run this cell to create its widget.'
              : 'Live Jupyter widgets require a local or SSH host with protocol 25.4 or newer.')}
        </p>
      </div>
    );
  return (
    <WidgetFrame
      key={`${live ? status.generation : 'saved'}:${modelId}:${extensions}`}
      modelId={modelId}
      snapshot={snapshot}
      session={live ? session! : null}
      generation={live ? status.generation : null}
      extensions={live || extensions}
      onLoadExtension={() => setExtensions(true)}
    />
  );
}

function themeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    '--jp-layout-color0': read('--bg-base'),
    '--jp-layout-color1': read('--bg-surface'),
    '--jp-layout-color2': read('--bg-elevated'),
    '--jp-layout-color3': read('--bg-elevated'),
    '--jp-ui-font-color0': read('--text-primary'),
    '--jp-ui-font-color1': read('--text-primary'),
    '--jp-ui-font-color2': read('--text-secondary'),
    '--jp-ui-font-color3': read('--text-muted'),
    '--jp-content-font-color1': read('--text-primary'),
    '--jp-border-color1': read('--border'),
    '--jp-content-font-color0': read('--text-primary'),
    '--jp-content-font-color2': read('--text-secondary'),
    '--jp-content-font-color3': read('--text-muted'),
    '--jp-content-font-family': read('--font-sans'),
    '--jp-error-color1': read('--danger'),
    '--jp-warn-color1': read('--warning'),
    '--jp-success-color1': read('--success'),
    '--jp-info-color1': read('--accent'),
    '--jp-brand-color1': read('--accent'),
    '--jp-ui-font-family': read('--font-sans'),
    '--jp-code-font-family': read('--font-mono'),
    '--danger': read('--danger'),
  };
}

function WidgetFrame({
  modelId,
  snapshot,
  session,
  generation,
  extensions,
  onLoadExtension,
}: {
  modelId: string;
  snapshot: NotebookWidgetState;
  session: WidgetSession | null;
  generation: string | null;
  extensions: boolean;
  onLoadExtension: () => void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const channel = useRef<MessagePort | null>(null);
  const initial = useRef(snapshot);
  initial.current = snapshot;
  const [doc, setDoc] = useState<string>();
  const [frameEpoch, setFrameEpoch] = useState(0);
  const [height, setHeight] = useState(48);
  const [error, setError] = useState<string>();
  const [extension, setExtension] = useState<string>();
  const theme = useSyncExternalStore(onThemeChange, currentTheme, currentTheme);
  useEffect(() => {
    channel.current?.postMessage({ type: 'theme', theme: themeVariables() });
  }, [theme]);
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const ready = (event: MessageEvent) => {
      if (
        event.source !== iframe.current?.contentWindow ||
        event.data?.type !== 'puddle-widget-ready' ||
        channel.current
      )
        return;
      const pair = new MessageChannel();
      channel.current = pair.port1;
      pair.port1.onmessage = (message) => {
        if (cancelled || !message.data || typeof message.data !== 'object') return;
        const data = message.data;
        if (data.type === 'height' && Number.isFinite(data.height))
          setHeight(Math.max(24, Math.min(2000, data.height)));
        if (data.type === 'error') setError(String(data.error).slice(0, 1024));
        if (data.type === 'extension') setExtension(String(data.name).slice(0, 256));
        if (data.type !== 'comm' || !session || !generation) return;
        const request = notebookWidgetCommSchema.safeParse({
          source: session.source,
          generation,
          message: data.message,
        });
        if (!request.success || JSON.stringify(request.data).length > 2 * 1024 * 1024) {
          setError('Widget action exceeds the supported message limits');
          return;
        }
        void session.send(generation, request.data.message).catch((error: unknown) => {
          if (!cancelled)
            pair.port1.postMessage({
              type: 'error',
              msg_id: request.data.message.msg_id,
              error: error instanceof Error ? error.message : 'Widget action failed',
            });
        });
      };
      pair.port1.start();
      iframe.current!.contentWindow!.postMessage({ type: 'puddle-widget-connect' }, '*', [
        pair.port2,
      ]);
      pair.port1.postMessage({
        type: 'init',
        snapshot: structuredClone(session?.state ?? initial.current),
        modelId,
        live: !!generation,
        extensions,
        theme: themeVariables(),
      });
      unsubscribe = session?.subscribe((update) => {
        if (update.generation !== generation || update.error) {
          pair.port1.postMessage({
            type: 'error',
            error: update.error ?? 'The kernel changed. Run the cell again.',
          });
        } else if (update.snapshot) {
          // A gap in the bounded event history requires a fresh model graph.
          channel.current?.close();
          channel.current = null;
          unsubscribe?.();
          setFrameEpoch((epoch) => epoch + 1);
        } else pair.port1.postMessage({ type: 'events', events: update.events });
      });
    };
    const load = async () => {
      const { default: script } = await import('virtual:notebook-widget-runtime');
      if (cancelled) return;
      const csp =
        "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src https:; worker-src blob:; form-action 'none'; base-uri 'none'";
      setDoc(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
html,body{margin:0;background:var(--jp-layout-color0)!important;color:var(--jp-ui-font-color1)!important;font-family:var(--jp-ui-font-family)!important}
.jupyter-widgets input,.jupyter-widgets select,.jupyter-widgets textarea,.jupyter-widgets button{border:0!important;color:var(--jp-ui-font-color1);background:var(--jp-layout-color1)}
.jupyter-widgets button,.jupyter-widgets select,.jupyter-widgets input[type=range]{cursor:pointer}
.jupyter-widgets button:hover{opacity:.8}.widget-label{color:var(--jp-ui-font-color2)}
.math-display{display:block}
</style></head><body><script>${script.replace(/<\/script/gi, '<\\/script')}</script></body></html>`);
    };
    window.addEventListener('message', ready);
    void load().catch((error: unknown) => setError(String(error)));
    return () => {
      cancelled = true;
      unsubscribe?.();
      window.removeEventListener('message', ready);
      channel.current?.close();
      channel.current = null;
    };
  }, [session, generation, modelId, extensions]);
  return (
    <div>
      {doc && (
        <iframe
          key={frameEpoch}
          ref={iframe}
          title="Jupyter widget"
          loading="lazy"
          sandbox="allow-scripts allow-downloads"
          referrerPolicy="no-referrer"
          srcDoc={doc}
          className="block w-full border-0"
          style={{ height }}
        />
      )}
      {!generation && (
        <p className="text-xs text-fg-muted">Saved widget · run the cell to reconnect</p>
      )}
      {extension && !extensions ? (
        <button
          type="button"
          onClick={onLoadExtension}
          className="cursor-pointer text-xs text-accent hover:opacity-80"
        >
          Load {extension} widget extension
        </button>
      ) : (
        error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )
      )}
    </div>
  );
}
