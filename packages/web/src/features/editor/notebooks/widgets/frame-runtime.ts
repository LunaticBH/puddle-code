import { HTMLManager } from '@jupyter-widgets/html-manager/lib/htmlmanager';
import * as base from '@jupyter-widgets/base';
import * as controls from '@jupyter-widgets/controls';
import * as output from '@jupyter-widgets/html-manager/lib/output';
import '@jupyter-widgets/controls/css/labvariables.css';
import 'katex/dist/katex.min.css';
import { renderMathInElement } from '../../previews/markdown/math-dom';
import { markdownToHtml } from '../../previews/markdown/markdown';
import type { IClassicComm, ICallbacks } from '@jupyter-widgets/base/lib/services-shim';
import type { NotebookWidgetMessage, NotebookWidgetState } from '@puddle/shared';

// This bundle runs only in a sandboxed, opaque-origin document. The parent
// exposes widget comms over one MessagePort, never browser credentials or APIs.
type Module = Record<string, unknown>;
declare const define: (name: string, dependencies: string[], factory: () => Module) => void;
declare const requirejs: {
  (modules: string[], success: (module: Module) => void, failure: (error: Error) => void): void;
  config(config: { paths: Record<string, string>; waitSeconds: number }): void;
};
define('@jupyter-widgets/base', [], () => base);
define('@jupyter-widgets/controls', [], () => controls);
define('@jupyter-widgets/output', [], () => output);

let port: MessagePort | undefined;
let manager: LiveManager;
let live = false;
let extensions = false;
let modelId = '';
let displayed = false;
const comms = new Map<string, Comm>();
const callbacks = new Map<string, ICallbacks>();
const root = document.createElement('div');
document.body.append(root);
const post = (message: unknown) => port?.postMessage(message);
const fail = (error: unknown) => post({ type: 'error', error: String(error).slice(0, 1024) });

function kernelMessage(message: NotebookWidgetMessage) {
  return {
    header: {
      msg_id: message.msg_id,
      msg_type: message.msg_type,
      session: '',
      username: '',
      version: '5.3',
      date: new Date().toISOString(),
    },
    parent_header: { msg_id: message.parent_id },
    metadata: message.metadata,
    content: message.content,
    channel: 'iopub',
    buffers: message.buffers.map(
      (buffer) => new DataView(Uint8Array.from(atob(buffer), (char) => char.charCodeAt(0)).buffer),
    ),
    // The shared schema preserves Jupyter's extensible JSON payloads; the
    // official manager uses narrower JSONValue types for the same wire data.
  } as unknown as Parameters<HTMLManager['handle_comm_open']>[1] & { channel: 'iopub' };
}

class Comm implements IClassicComm {
  target_name = 'jupyter.widget';
  message?: Parameters<IClassicComm['on_msg']>[0];
  closed?: Parameters<IClassicComm['on_close']>[0];
  constructor(readonly comm_id: string) {
    comms.set(comm_id, this);
  }
  on_msg(handler: Parameters<IClassicComm['on_msg']>[0]) {
    this.message = handler;
  }
  on_close(handler: Parameters<IClassicComm['on_close']>[0]) {
    this.closed = handler;
  }
  open(...args: Parameters<IClassicComm['open']>) {
    return this.dispatch('comm_open', ...args);
  }
  send(...args: Parameters<IClassicComm['send']>) {
    return this.dispatch('comm_msg', ...args);
  }
  close(...args: Parameters<IClassicComm['close']>) {
    return this.dispatch('comm_close', ...args);
  }
  private dispatch(
    kind: 'comm_open' | 'comm_msg' | 'comm_close',
    data: Parameters<IClassicComm['send']>[0] = {},
    handlers?: ICallbacks,
    metadata: Record<string, unknown> = {},
    buffers: ArrayBuffer[] | ArrayBufferView[] = [],
  ): string {
    const id = crypto.randomUUID();
    if (!live) return id;
    if (callbacks.size >= 256) {
      fail('Too many pending widget actions');
      return id;
    }
    if (handlers) callbacks.set(id, handlers);
    post({
      type: 'comm',
      message: {
        msg_id: id,
        parent_id: '',
        msg_type: kind,
        metadata,
        content: {
          comm_id: this.comm_id,
          ...(kind === 'comm_open' ? { target_name: this.target_name } : {}),
          data,
        },
        buffers: buffers.map((buffer) => {
          const bytes =
            buffer instanceof ArrayBuffer
              ? new Uint8Array(buffer)
              : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          let text = '';
          for (let at = 0; at < bytes.length; at += 8192)
            text += String.fromCharCode(...bytes.subarray(at, at + 8192));
          return btoa(text);
        }),
      },
    });
    return id;
  }
}

class LiveManager extends HTMLManager {
  // Core controls look for JupyterLab's registry name when typesetting labels.
  readonly _rendermime: HTMLManager['renderMime'];
  constructor() {
    super({
      loader: (name, version) => {
        if (!/^(?:@[a-z0-9_-]+\/)?[a-z0-9_.-]+$/i.test(name) || !/^[\w.^~<>=| *+-]+$/.test(version))
          return Promise.reject(new Error('Invalid widget extension name or version'));
        if (!extensions) {
          post({ type: 'extension', name });
          return Promise.reject(
            new Error(`Load the ${name} widget extension to display this saved widget`),
          );
        }
        requirejs.config({
          paths: {
            [name]: `https://cdn.jsdelivr.net/npm/${name}@${encodeURIComponent(version)}/dist/index`,
          },
          waitSeconds: 20,
        });
        return new Promise<Module>((resolve, reject) => requirejs([name], resolve, reject));
      },
    });
    this.renderMime = this.renderMime.clone({
      markdownParser: { render: async (source) => markdownToHtml(source) },
      latexTypesetter: {
        typeset(element) {
          renderMathInElement(element);
        },
      },
    });
    this._rendermime = this.renderMime;
  }
  new_model(
    options: Parameters<HTMLManager['new_model']>[0],
    state: Parameters<HTMLManager['new_model']>[1] = {},
  ) {
    if (live && !options.comm && options.model_id)
      options = { ...options, comm: new Comm(options.model_id) };
    return super.new_model(options, state);
  }
  _create_comm(
    target: string,
    id: string,
    data?: Parameters<IClassicComm['open']>[0],
    metadata?: Parameters<IClassicComm['open']>[2],
    buffers?: Parameters<IClassicComm['open']>[3],
  ) {
    if (target !== 'jupyter.widget')
      return Promise.reject(new Error('Unsupported widget comm target'));
    const comm = new Comm(id);
    if (data !== undefined) comm.open(data, undefined, metadata, buffers);
    return Promise.resolve(comm);
  }
}

async function display(): Promise<void> {
  if (displayed || !manager.has_model(modelId)) return;
  displayed = true;
  const model = await manager.get_model(modelId);
  const view = await manager.create_view(model);
  await manager.display_view(view, root);
  post({ type: 'displayed' });
}

async function receive(data: {
  type: string;
  snapshot?: NotebookWidgetState;
  events?: NotebookWidgetMessage[];
  live?: boolean;
  extensions?: boolean;
  modelId?: string;
  theme?: Record<string, string>;
  error?: string;
  msg_id?: string;
}) {
  if (data.theme)
    for (const [key, value] of Object.entries(data.theme))
      document.documentElement.style.setProperty(key, value);
  if (data.type === 'init') {
    live = !!data.live;
    extensions = !!data.extensions;
    modelId = data.modelId!;
    manager = new LiveManager();
    await manager.set_state(data.snapshot! as unknown as Parameters<HTMLManager['set_state']>[0]);
    await display();
  } else if (data.type === 'events') {
    const opens = (data.events ?? []).filter((event) => event.msg_type === 'comm_open');
    await Promise.all(
      opens.map((event) =>
        manager.has_model(String(event.content.comm_id))
          ? Promise.resolve()
          : manager.handle_comm_open(new Comm(String(event.content.comm_id)), kernelMessage(event)),
      ),
    );
    for (const event of data.events ?? []) {
      const comm = comms.get(String(event.content.comm_id));
      if (event.msg_type === 'comm_msg') await comm?.message?.(kernelMessage(event));
      if (event.msg_type === 'comm_close') {
        comm?.closed?.(kernelMessage(event));
        comms.delete(String(event.content.comm_id));
      }
      if (event.msg_type === 'status') {
        const handler = callbacks.get(event.parent_id)?.iopub?.status;
        handler?.(kernelMessage(event));
        if (event.content.execution_state === 'idle') callbacks.delete(event.parent_id);
      }
    }
    await display();
  } else if (data.type === 'error') {
    if (data.msg_id) callbacks.delete(data.msg_id);
    live = false;
    manager.disconnect();
    fail(data.error);
  }
}

window.addEventListener('message', (event) => {
  if (
    event.source !== parent ||
    event.data?.type !== 'puddle-widget-connect' ||
    port ||
    !event.ports[0]
  )
    return;
  port = event.ports[0];
  let sequence = Promise.resolve();
  port.onmessage = (message) => {
    sequence = sequence.then(() => receive(message.data)).catch(fail);
  };
  port.start();
});
new ResizeObserver(() =>
  post({ type: 'height', height: Math.ceil(root.getBoundingClientRect().height) }),
).observe(root);
parent.postMessage({ type: 'puddle-widget-ready' }, '*');
