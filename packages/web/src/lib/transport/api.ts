import { errorResponseSchema } from '@puddle/shared';
import { clearToken, tokenStore } from './auth';
import { browserTransport } from './browser-transport';

/** Typed view of the daemon's uniform error envelope. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Authenticated JSON request through the cockpit. Only browser rejection
 * clears login; upstream recovery has an independent lifetime.
 */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = tokenStore.get();
  const remote = browserTransport();
  const res = remote
    ? await remote.request(method, path, body)
    : await fetch(path, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(await res.json().catch(() => null));
    if (parsed.success) {
      if (parsed.data.error.code === 'browser_rejected') clearToken();
      throw new ApiError(
        res.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details,
      );
    }
    throw new ApiError(res.status, 'unknown', `${method} ${path} failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The bearer header for a request against the daemon, or `{}` when signed out. */
export function authHeaders(): Record<string, string> {
  const token = tokenStore.get();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * Authenticated request returning the raw `Response`, for callers that need
 * a blob/stream rather than a parsed JSON body (worktree upload/download —
 * `worktree-queries.ts`). Mirrors `api()`'s 401 and error-envelope handling
 * but never reads the body on success, so the caller can stream or blob it.
 */
export async function apiFetchRaw(
  method: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (browserTransport())
    throw new ApiError(403, 'remote_unavailable', 'Raw file transfers are unavailable remotely');
  const res = await fetch(path, {
    ...init,
    method,
    headers: { ...authHeaders(), ...init?.headers },
  });
  if (!res.ok) {
    const parsed = errorResponseSchema.safeParse(await res.json().catch(() => null));
    if (parsed.success) {
      if (parsed.data.error.code === 'browser_rejected') clearToken();
      throw new ApiError(
        res.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details,
      );
    }
    throw new ApiError(res.status, 'unknown', `${method} ${path} failed with ${res.status}`);
  }
  return res;
}
