import type {
  NotebookWidgetMessage,
  NotebookWidgetState,
} from './api/notebooks/notebook-widgets.js';

/** Apply Jupyter trait patches without decoding binary buffers or executing model code. */
export function mergeWidgetMessage(
  previous: NotebookWidgetState['state'],
  message: NotebookWidgetMessage,
): NotebookWidgetState['state'] {
  const models = { ...previous };
  const id = message.content.comm_id;
  if (message.msg_type !== 'status' && typeof id !== 'string') return models;
  const data = message.content.data as Record<string, unknown> | undefined;
  if (message.msg_type === 'comm_close') delete models[id as string];
  if (
    (message.msg_type === 'comm_open' && message.content.target_name === 'jupyter.widget') ||
    (message.msg_type === 'comm_msg' && ['update', 'echo_update'].includes(String(data?.method)))
  ) {
    const state = data?.state;
    if (!state || typeof state !== 'object' || Array.isArray(state)) return models;
    const patch = state as Record<string, unknown>;
    const old = Object.hasOwn(models, id as string) ? models[id as string] : undefined;
    if (!old && message.msg_type !== 'comm_open') return models;
    const merged = { ...old?.state, ...patch };
    if (
      typeof merged._model_name !== 'string' ||
      typeof merged._model_module !== 'string' ||
      typeof merged._model_module_version !== 'string'
    )
      return models;
    const paths = data?.buffer_paths;
    const changed = new Set(Object.keys(patch));
    if (Array.isArray(paths))
      for (const path of paths) if (Array.isArray(path)) changed.add(String(path[0]));
    const buffers = (old?.buffers ?? []).filter((buffer) => !changed.has(String(buffer.path[0])));
    if (Array.isArray(paths))
      paths.forEach((path, index) => {
        if (
          Array.isArray(path) &&
          path.length <= 64 &&
          path.every((part) => typeof part === 'string' || (Number.isInteger(part) && part >= 0)) &&
          message.buffers[index] !== undefined
        ) {
          buffers.push({ encoding: 'base64', path, data: message.buffers[index]! });
        }
      });
    Object.defineProperty(models, id as string, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        model_name: merged._model_name,
        model_module: merged._model_module,
        model_module_version: merged._model_module_version,
        state: merged,
        ...(buffers.length ? { buffers } : {}),
      },
    });
  }

  return models;
}
