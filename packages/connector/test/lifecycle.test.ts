import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { runConnectorManager, type ConnectorProcess } from '../src/lifecycle.js';

/**
 * How the connector's process stops its manager, with a stand-in process:
 * no signal is sent and no process starts, so this runs on any OS.
 */
class FakeProcess extends EventEmitter implements ConnectorProcess {
  channel: unknown;
  connected: boolean | undefined;
  readonly exit = vi.fn<(code: number) => void>();
  constructor(
    readonly platform: NodeJS.Platform,
    ipc: boolean,
  ) {
    super();
    this.channel = ipc ? {} : undefined;
    this.connected = ipc ? true : undefined;
  }
  /** Node's behaviour when the parent closes the IPC channel: one event, then no channel. */
  disconnect(): void {
    this.connected = false;
    this.channel = null;
    this.emit('disconnect');
  }
}

/** A manager whose start resolves when the test says so. */
function manager() {
  let resolve!: () => void;
  const started = new Promise<void>((done) => (resolve = done));
  const close = vi.fn(async () => {});
  return { start: () => started.then(() => ({ close })), finishStart: resolve, close };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('the connector process on Windows', () => {
  it('stops for a supervisor that closed its channel while the manager was starting', async () => {
    const proc = new FakeProcess('win32', true);
    const { start, finishStart, close } = manager();
    const running = runConnectorManager(start, proc);
    await settle();
    // The supervisor stops a connector it has just spawned (restart_connector).
    proc.disconnect();
    expect(close).not.toHaveBeenCalled();
    finishStart();
    await running;
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('stops for a channel that closed before its handlers were registered', async () => {
    const proc = new FakeProcess('win32', true);
    // Node announced the disconnect before the entry point ran, and dropped the channel.
    proc.connected = false;
    proc.channel = null;
    const { start, finishStart, close } = manager();
    const running = runConnectorManager(start, proc);
    finishStart();
    await running;
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('keeps running without a channel, and stops on a console close once', async () => {
    const proc = new FakeProcess('win32', false);
    const { start, finishStart, close } = manager();
    const running = runConnectorManager(start, proc);
    finishStart();
    await running;
    await settle();
    expect(close).not.toHaveBeenCalled();
    proc.emit('SIGHUP');
    proc.emit('SIGBREAK');
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(proc.exit).toHaveBeenCalledOnce();
  });
});

describe('the connector process on POSIX', () => {
  it('listens for SIGINT and SIGTERM only once the manager runs, as it always has', async () => {
    const proc = new FakeProcess('linux', false);
    const { start, finishStart, close } = manager();
    const running = runConnectorManager(start, proc);
    await settle();
    expect(proc.eventNames()).toEqual([]);
    finishStart();
    await running;
    expect(proc.eventNames()).toEqual(['SIGINT', 'SIGTERM']);
    proc.emit('SIGTERM');
    await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(proc.exit).toHaveBeenCalledWith(0);
  });
});
