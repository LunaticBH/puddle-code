import {
  cockpitRefreshResponseSchema,
  cockpitStatusSchema,
  type CockpitRefreshResponse,
} from '@puddle/shared';
import { tokenStore } from './auth';

export type RefreshPhase = 'idle' | 'requesting' | 'waiting' | 'complete' | 'failed';

/** Both UI triggers share one controller; no old process or unauthenticated response is ready. */
export class RefreshController {
  phase: RefreshPhase = 'idle';
  private pending: Promise<boolean> | null = null;
  constructor(
    private readonly transport: typeof fetch = fetch,
    private readonly reload = () => window.location.reload(),
    private readonly pause = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}
  refresh(timeoutMs = 120_000): Promise<boolean> {
    if (this.pending) return this.pending;
    this.pending = this.run(timeoutMs).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  private async run(timeoutMs: number): Promise<boolean> {
    this.phase = 'requesting';
    const headers = {
      authorization: `Bearer ${tokenStore.get() ?? ''}`,
      'content-type': 'application/json',
    };
    try {
      const response = await this.transport('/cockpit/refresh', {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ refreshId: crypto.randomUUID() }),
      });
      if (response.status !== 202) throw new Error('refresh rejected');
      const accepted: CockpitRefreshResponse = cockpitRefreshResponseSchema.parse(
        await response.json(),
      );
      this.phase = 'waiting';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await this.pause(1000);
        try {
          const result = await this.transport('/cockpit/status', {
            headers,
            cache: 'no-store',
            signal: AbortSignal.timeout(3000),
          });
          if (!result.ok) continue;
          const status = cockpitStatusSchema.parse(await result.json());
          if (
            status.instance === accepted.instance ||
            status.refreshId !== accepted.refreshId ||
            status.upstream !== 'ready'
          )
            continue;
          this.phase = 'complete';
          this.reload();
          return true;
        } catch {
          /* Replacement or its daemon handshake is still starting. */
        }
      }
    } catch {
      /* Local controls can fail independently of the browser's login. */
    }
    this.phase = 'failed';
    return false;
  }
}
export const refreshController = new RefreshController();
let trigger: (() => void) | null = null;
export function registerRefreshTrigger(fn: () => void): () => void {
  trigger = fn;
  return () => {
    if (trigger === fn) trigger = null;
  };
}
export function triggerConnectionRefresh(): void {
  trigger?.();
}
