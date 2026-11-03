import { previewAssetResponseSchema } from '@puddle/shared';
import { api, apiFetchRaw } from '../../../lib/transport/api';
import { browserTransport, type BrowserTransport } from '../../../lib/transport/browser-transport';
import { rootParam } from '../../../lib/queries/worktree-queries';

/** Asset bytes never enter an element URL with credentials attached. */
export async function fetchPreviewAsset(
  session: string,
  path: string,
  root?: string,
): Promise<Blob> {
  const query = `path=${encodeURIComponent(path)}${rootParam(root)}`;
  const transport = browserTransport();
  if (!transport) {
    return (await apiFetchRaw('GET', `/api/worktrees/${session}/media?${query}`)).blob();
  }
  return queuedAsset(transport, async () => {
    // Queued work must never follow the singleton transport onto another host.
    if (browserTransport() !== transport) throw new Error('Preview host changed');
    const asset = previewAssetResponseSchema.parse(
      await api('GET', `/api/worktrees/${session}/preview-asset?${query}`),
    );
    return new Blob([Uint8Array.from(atob(asset.data), (char) => char.charCodeAt(0))], {
      type: asset.mime,
    });
  });
}

const queues = new WeakMap<BrowserTransport, { active: number; waiting: Array<() => void> }>();

/** Leave room for tree, status and terminal requests even on image-heavy pages. */
async function queuedAsset(transport: BrowserTransport, read: () => Promise<Blob>): Promise<Blob> {
  let queue = queues.get(transport);
  if (!queue) {
    queue = { active: 0, waiting: [] };
    queues.set(transport, queue);
  }
  if (queue.waiting.length >= 128) throw new Error('Too many preview assets');
  if (queue.active >= 2) await new Promise<void>((resolve) => queue.waiting.push(resolve));
  else queue.active += 1;
  try {
    return await read();
  } finally {
    const next = queue.waiting.shift();
    if (next) next();
    else queue.active -= 1;
  }
}
