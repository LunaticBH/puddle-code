/** What stops a running connector manager: `process`, or a stand-in in tests. */
export interface ConnectorProcess {
  readonly platform: NodeJS.Platform;
  /** The IPC channel a Windows supervisor gave this process, while it is open. */
  readonly channel?: unknown;
  /** `false` once that channel has closed; `undefined` for a process that never had one. */
  readonly connected?: boolean;
  on(event: 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGBREAK' | 'disconnect', stop: () => void): unknown;
  exit(code: number): void;
}

export interface Closable {
  close(): Promise<void>;
}

/**
 * Run the connector manager `start` gives until a signal stops it, then
 * close it and exit 0. POSIX keeps its order exactly: the signal handlers
 * follow the start. On Windows the supervisor stops its connector by
 * closing the IPC channel it gave it, which it may do while the manager is
 * still starting; Node announces that once and then drops the channel, so
 * the handlers come first there, and a channel already closed before they
 * did (`connected === false`) stops the manager as soon as it is up.
 */
export async function runConnectorManager(
  start: () => Promise<Closable>,
  proc: ConnectorProcess = process,
): Promise<void> {
  let manager: Closable | undefined;
  let stopping = false;
  const close = (running: Closable) => void running.close().then(() => proc.exit(0));
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (manager) close(manager);
  };
  if (proc.platform !== 'win32') {
    manager = await start();
    proc.on('SIGINT', stop);
    proc.on('SIGTERM', stop);
    return;
  }
  proc.on('SIGINT', stop);
  proc.on('SIGTERM', stop);
  // Closing a console sends SIGHUP and Ctrl-Break SIGBREAK.
  proc.on('SIGHUP', stop);
  proc.on('SIGBREAK', stop);
  if (proc.channel) proc.on('disconnect', stop);
  const running = await start();
  manager = running;
  if (stopping || proc.connected === false) {
    stopping = true;
    close(running);
  }
}
