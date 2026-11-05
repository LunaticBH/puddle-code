import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { resolveSpawn, setEnv, type Environment } from '@puddle/shared/node/platform';
import { conptyHelperLaunch } from '../../pty/conpty-jobs.js';
import type { AgentControl, LifecycleLaunchResource } from '../adapter.js';
import { record, type HeadlessContext, type HeadlessDriver, type JsonRecord } from './codec.js';
import { HEADLESS_TERMINAL_SOURCE } from './terminal-source.js';

const LIMIT = 256 * 1024;
const plain = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''); // eslint-disable-line no-control-regex -- Transcript output cannot carry terminal commands.

/** One outstanding native command; completion requires both a result and exit 0. */
export class HeadlessControl implements AgentControl {
  private socket: Socket | null = null;
  private ref: string | undefined;
  private closed = false;
  private connected = false;
  private initialPrompt: string | undefined;
  private pending: {
    id: string;
    observe(event: JsonRecord): void;
    finish(error?: Error): void;
    fail(error: Error): void;
  } | null = null;

  constructor(
    private readonly context: HeadlessContext,
    private readonly driver: HeadlessDriver,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {
    this.ref = context.resumeRef;
    this.initialPrompt = context.opts.prompt;
  }

  get ready(): boolean {
    return this.connected && !this.pending && !this.closed;
  }

  /** `received` is text an admission check already read from the socket. */
  connect(socket: Socket, received = ''): void {
    if (this.socket || this.closed) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    const onData = (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (Buffer.byteLength(line) > 2 * LIMIT) {
          this.dispose();
          return;
        }
        try {
          const event = record(JSON.parse(line));
          if (event['type'] === 'ready' && !this.connected) {
            // Windows: how the driver starts the ConPTY helper that ends what
            // is attached to its CLI's console (terminal-source.ts), before any run.
            if (this.platform === 'win32') this.send({ type: 'helper', ...conptyHelperLaunch() });
            this.connected = true;
            this.context.reportStatus?.('waiting_input');
          } else if (event['type'] === 'interrupt')
            this.cancel('Turn interrupted from the terminal');
          else if (event['id'] === this.pending?.id) this.pending?.observe(event);
        } catch {
          this.cancel('Invalid structured agent output');
        }
      }
      if (Buffer.byteLength(buffer) > 2 * LIMIT) this.dispose();
    };
    socket.on('data', onData);
    socket.once('close', () => this.dispose());
    socket.on('error', () => this.dispose());
    if (received) onData(received);
  }

  async ask(prompt: string, signal: AbortSignal, schema?: JsonRecord): Promise<string> {
    if (!this.ready) throw new Error('Agent is busy or not ready');
    signal.throwIfAborted();
    const id = randomUUID();
    const initial = this.initialPrompt;
    const command = this.driver.command(
      this.ref,
      initial ? `${initial}\n\n${prompt}` : prompt,
      schema,
    );
    const run = this.runMessage(command);
    const decode = this.driver.decoder();
    const utf8 = new StringDecoder('utf8');
    let lines = '',
      reply = '',
      complete = false,
      seenRef = false,
      failure: Error | undefined;
    let binding = Promise.resolve();
    let stderr = '';
    return new Promise<string>((resolve, reject) => {
      const abort = () => this.cancel('Headless turn cancelled');
      const finish = (error?: Error) => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        signal.removeEventListener('abort', abort);
        this.context.reportStatus?.('waiting_input');
        if (error) {
          this.display(`\nError: ${error.message}\n`);
          reject(error);
        } else resolve(reply);
      };
      const line = (raw: string) => {
        if (!raw.trim()) return;
        const value = decode(record(JSON.parse(raw)));
        if (value.error) throw new Error(value.error);
        if (value.ref) {
          seenRef = true;
          if (this.ref && this.ref !== value.ref)
            throw new Error('Agent changed its native conversation unexpectedly');
          if (!this.ref) {
            this.ref = value.ref;
            binding = this.context.bindConversation?.(value.ref) ?? Promise.resolve();
            void binding.catch((error: unknown) => {
              failure = new Error(String(error));
              this.cancel(failure.message);
            });
          }
        }
        if (value.reply !== undefined) reply = value.reply;
        if (Buffer.byteLength(reply) > LIMIT) throw new Error('Agent reply exceeds 256 KiB');
        if (value.text) this.display(value.text);
        if (value.complete !== undefined) complete = value.complete;
      };
      this.pending = {
        id,
        finish,
        fail: (error) => {
          failure ??= error;
          this.send({ type: 'cancel', id });
        },
        observe: (event) => {
          try {
            if (event['type'] === 'stdout' && typeof event['data'] === 'string') {
              lines += utf8.write(Buffer.from(event['data'], 'base64'));
              if (Buffer.byteLength(lines) > 4 * LIMIT)
                throw new Error('Agent event exceeds 1 MiB');
              for (;;) {
                const end = lines.indexOf('\n');
                if (end < 0) break;
                const raw = lines.slice(0, end);
                lines = lines.slice(end + 1);
                line(raw);
              }
            } else if (event['type'] === 'stderr' && typeof event['data'] === 'string') {
              stderr = (stderr + Buffer.from(event['data'], 'base64').toString('utf8')).slice(
                -4096,
              );
            } else if (event['type'] === 'error') throw new Error(String(event['error']));
            else if (event['type'] === 'exit') {
              lines += utf8.end();
              if (!failure && lines.trim()) line(lines);
              if (!failure && (event['code'] !== 0 || !complete || !seenRef))
                failure = new Error(
                  `Agent exited without a successful result${stderr ? `: ${plain(stderr)}` : ''}`,
                );
              void binding.then(
                () => finish(failure),
                (error: unknown) => finish(new Error(String(error))),
              );
            }
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
            if (event['type'] === 'exit') finish(failure);
            else this.send({ type: 'cancel', id });
          }
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      this.initialPrompt = undefined;
      this.context.reportStatus?.('working');
      this.display(`\n> ${prompt}\n\n`);
      this.send({ type: 'run', id, ...run });
    });
  }

  /**
   * The `run` request for one native command. The terminal driver has no
   * executable resolver, so on Windows the daemon resolves the CLI on PATH
   * (never the driver's cwd, the worktree, where a repository could plant
   * `claude.exe`) and unwraps npm shims, as for every other agent child.
   */
  private runMessage(command: ReturnType<HeadlessDriver['command']>): JsonRecord {
    const env = { ...this.driver.env, ...command.env };
    if (this.platform !== 'win32') return { binary: this.driver.binary, ...command, env };
    const lookup: Environment = { ...process.env, ...this.context.env, ...env };
    const resolved = resolveSpawn(this.driver.binary, command.args, {
      platform: this.platform,
      env: lookup,
    });
    if (!win32.isAbsolute(resolved.file))
      throw new Error(`'${this.driver.binary}' was not found on the daemon's PATH`);
    const childEnv: Environment = { ...env };
    for (const [key, value] of Object.entries(resolved.env ?? {}))
      setEnv(childEnv, key, value, this.platform);
    return {
      ...command,
      binary: resolved.file,
      args: resolved.args,
      env: childEnv,
      ...(resolved.windowsVerbatimArguments ? { verbatim: true } : {}),
    };
  }

  private cancel(message: string): void {
    // Admission stays closed until the native child exits. An attached runtime
    // survives cancellation; a subsequent ask is always a new explicit turn.
    this.pending?.fail(new Error(message));
  }

  dispose(): void {
    this.closed = true;
    this.pending?.finish(new Error('Agent terminal closed'));
    this.socket?.destroy();
    this.socket = null;
  }
  private display(text: string): void {
    this.send({ type: 'display', text: plain(text) });
  }
  private send(message: JsonRecord): void {
    this.socket?.write(`${JSON.stringify(message)}\n`);
  }
}

export async function prepareHeadless(
  context: HeadlessContext,
  driver: HeadlessDriver,
  platform: NodeJS.Platform = process.platform,
): Promise<LifecycleLaunchResource> {
  if (platform === 'win32') return prepareWindowsHeadless(context, driver);
  const directory = await mkdtemp(join(tmpdir(), 'pudl-'));
  const path = join(directory, 's');
  const control = new HeadlessControl(context, driver);
  const server = createServer((socket) => control.connect(socket));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    binary: process.execPath,
    args: ['-e', HEADLESS_TERMINAL_SOURCE, path],
    control,
    dispose: async () => {
      control.dispose();
      server.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Windows: a named pipe in place of the socket in a private directory
 * (docs/windows.md, decision 3). Under a pipe's default DACL any local user
 * may open it for reading, so a connection is attached only once its first
 * line, the driver's `ready`, carries the per-launch token from the driver's
 * argv; until then the daemon writes nothing to it.
 */
async function prepareWindowsHeadless(
  context: HeadlessContext,
  driver: HeadlessDriver,
): Promise<LifecycleLaunchResource> {
  const path = `\\\\.\\pipe\\pudl-headless-${randomUUID()}`;
  const token = randomBytes(32).toString('hex');
  const control = new HeadlessControl(context, driver, 'win32');
  const server = createServer((socket) =>
    admitWithToken(socket, token, (received) => control.connect(socket, received)),
  );
  await listen(server, path);
  return {
    binary: process.execPath,
    args: ['-e', HEADLESS_TERMINAL_SOURCE, path, token],
    control,
    dispose: () => {
      control.dispose();
      server.close();
    },
  };
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
}

/** Hands `socket` to `admit` once its first line is a `ready` holding `token`. */
export function admitWithToken(
  socket: Socket,
  token: string,
  admit: (received: string) => void,
): void {
  let received = '';
  const refuse = () => socket.destroy();
  const timer = setTimeout(refuse, 10_000);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  socket.on('error', refuse);
  socket.setEncoding('utf8');
  const onData = (chunk: string) => {
    received += chunk;
    const end = received.indexOf('\n');
    if (end < 0) {
      if (received.length > 4096) refuse();
      return;
    }
    clearTimeout(timer);
    socket.off('data', onData);
    socket.off('error', refuse);
    let first: JsonRecord = {};
    try {
      first = record(JSON.parse(received.slice(0, end)));
    } catch {
      // Not JSON: refused below.
    }
    const offered = typeof first['token'] === 'string' ? Buffer.from(first['token']) : null;
    const expected = Buffer.from(token);
    if (
      first['type'] !== 'ready' ||
      offered === null ||
      offered.length !== expected.length ||
      !timingSafeEqual(offered, expected)
    ) {
      refuse();
      return;
    }
    admit(received);
  };
  socket.on('data', onData);
}
