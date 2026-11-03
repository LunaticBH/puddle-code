import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentTurnSignal } from '@puddle/shared';
import type { AgentControl, LifecycleLaunchContext, LifecycleLaunchResource } from '../adapter.js';
import { schemaPrompt } from '../headless/codec.js';

/** Match a submitted prompt to native hooks, never terminal activity/quietness. */
export class InteractiveControl implements AgentControl {
  private ref: string | null = null;
  private active: string | null = null;
  private busy = true;
  private dirty = false;
  private disposed = false;
  private pending: {
    id: string;
    hash: string;
    accepted: boolean;
    finish(error?: Error, reply?: string): void;
  } | null = null;

  constructor(
    private readonly write: (data: string) => void,
    private readonly interrupt: string,
    private awaitingInitialTurn = false,
  ) {}
  get ready(): boolean {
    return !!this.ref && !this.busy && !this.dirty && !this.pending && !this.disposed;
  }

  lifecycle(ref: string | undefined, ended: boolean): void {
    if (ended || ref !== this.ref) {
      this.pending?.finish(new Error('Agent changed its native conversation'));
      this.active = null;
      this.busy = ended || this.awaitingInitialTurn;
      this.dirty = false;
      this.ref = ended ? null : (ref ?? null);
    }
  }
  input(): void {
    this.dirty = true;
    this.pending?.finish(new Error('Human input interrupted the automated turn'));
  }
  signal(event: AgentTurnSignal): 'working' | 'waiting_input' | undefined {
    if (event.agent_session_ref !== this.ref || this.disposed) return;
    if (event.event === 'turn_start') {
      this.awaitingInitialTurn = false;
      this.busy = true;
      this.dirty = false;
      this.active = event.turn_id;
      if (this.pending) {
        if (event.turn_id !== this.pending.id || event.prompt_hash !== this.pending.hash)
          this.pending.finish(new Error('Another prompt replaced the automated turn'));
        else this.pending.accepted = true;
      }
      return 'working';
    }
    if (event.turn_id !== this.active) return;
    this.busy = false;
    this.active = null;
    if (this.pending?.id !== event.turn_id || !this.pending.accepted) return 'waiting_input';
    if (event.event === 'turn_failed')
      this.pending.finish(new Error(event.error ?? 'Agent turn failed'));
    else if (event.reply === undefined)
      this.pending.finish(new Error('Native completion did not include a reply'));
    else this.pending.finish(undefined, event.reply);
    return 'waiting_input';
  }
  ask(prompt: string, signal: AbortSignal, schema?: Record<string, unknown>): Promise<string> {
    if (!this.ready)
      return Promise.reject(new Error('Agent is busy, has a draft, or is not ready'));
    signal.throwIfAborted();
    // Bracketed paste must not carry an escape that could close the frame or
    // execute a command in the native composer.
    // eslint-disable-next-line no-control-regex -- Reject terminal control bytes.
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(prompt))
      return Promise.reject(
        new Error('Interactive prompts cannot contain terminal control characters'),
      );
    const id = randomUUID();
    const text = `${schemaPrompt(prompt, schema)}\n\n[puddle-turn:${id}]`;
    const hash = createHash('sha256').update(text).digest('hex');
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, reply?: string) => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        clearTimeout(submit);
        clearTimeout(admission);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(reply ?? '');
      };
      const abort = () => {
        this.busy = true;
        this.write(this.interrupt);
        finish(new Error('Automated turn cancelled'));
      };
      const submit = setTimeout(() => {
        if (this.pending?.id === id) this.write('\r');
      }, 50);
      const admission = setTimeout(() => {
        if (this.pending?.id === id && !this.pending.accepted) {
          this.busy = true;
          finish(new Error('Native agent did not acknowledge the prompt; inspect its terminal'));
        }
      }, 15_000);
      this.pending = { id, hash, accepted: false, finish };
      this.busy = true;
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.write(`\x1b[200~${text}\x1b[201~`);
      } catch (error) {
        finish(new Error(String(error)));
      }
    });
  }
  dispose(): void {
    this.disposed = true;
    this.pending?.finish(new Error('Agent terminal closed'));
  }
}

export function interactiveResource(
  context: LifecycleLaunchContext,
  configDir: string,
  interrupt: string,
  platform: NodeJS.Platform = process.platform,
): LifecycleLaunchResource {
  if (!context.writeInput) throw new Error('Interactive control needs its owning terminal');
  const control = new InteractiveControl(context.writeInput, interrupt, !!context.opts.prompt);
  return {
    args: context.args,
    control,
    dispose: async () => {
      control.dispose();
      const hash = createHash('sha256').update(context.signalNonce).digest('hex');
      const removal = rm(join(configDir, `.puddle-turn-${hash}.json`), { force: true });
      if (platform !== 'win32') return removal;
      // A hook process still reading the file holds it open on Windows; the
      // stale turn record is harmless, since its nonce never recurs.
      await removal.catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EBUSY' && error.code !== 'EPERM') throw error;
      });
    },
  };
}
