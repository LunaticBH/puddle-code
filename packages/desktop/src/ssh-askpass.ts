import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { initialisePrivateHome } from '@puddle/shared/node';
import { renameWithRetrySync } from '@puddle/shared/node/platform';

export interface SshAskpassRequest {
  /** Original SSH destination, including aliases and user, never inferred from prompt text. */
  target: string;
  prompt: string;
  kind: 'secret' | 'confirm';
}

export interface RunningSshAskpass {
  /** Executable passed to OpenSSH as SSH_ASKPASS. */
  program: string;
  close(): Promise<void>;
}

/**
 * Bridge OpenSSH's standard askpass subprocess to the desktop's small auth
 * window. The answer exists only in renderer/main/helper memory on its way
 * back to the local ssh process; it is never logged or written to disk.
 */
export async function startSshAskpass(opts: {
  home: string;
  electronPath: string;
  helperPath: string;
  /** Windows: the compiled ssh-askpass.exe (see ssh-askpass-shim.cs). */
  windowsShimPath?: string;
  platform?: NodeJS.Platform;
  prompt(request: SshAskpassRequest, signal: AbortSignal): Promise<string | null>;
}): Promise<RunningSshAskpass> {
  const platform = opts.platform ?? process.platform;
  // The descriptor below holds the bridge's token: never in a home others can open.
  if (platform === 'win32') initialisePrivateHome(opts.home);
  const token = randomBytes(32).toString('hex');
  const lifetime = new AbortController();
  const server = createServer((request, response) => {
    void handleRequest(request, response, token, opts.prompt, lifetime.signal);
  });

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('could not bind the SSH authentication bridge');
  }

  mkdirSync(opts.home, { recursive: true });
  const endpoint = `http://127.0.0.1:${address.port}/askpass`;
  if (platform === 'win32') {
    return startWindowsAskpass(opts.home, endpoint, token, opts, server, lifetime);
  }
  const program = join(opts.home, `ssh-askpass-${process.pid}`);
  const launcher = `#!/bin/sh
exec env ELECTRON_RUN_AS_NODE=1 \\
  PUDDLE_DESKTOP_ASKPASS_URL=${shellQuote(endpoint)} \\
  PUDDLE_DESKTOP_ASKPASS_TOKEN=${shellQuote(token)} \\
  ${shellQuote(opts.electronPath)} ${shellQuote(opts.helperPath)} "$@"
`;
  try {
    writeFileSync(program, launcher, { encoding: 'utf8', mode: 0o700 });
    chmodSync(program, 0o700);
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  let closed = false;
  return {
    program,
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      lifetime.abort();
      server.closeAllConnections();
      try {
        rmSync(program, { force: true });
      } catch {
        // The dead endpoint/token are harmless; server shutdown matters more.
      }
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Windows: OpenSSH runs the compiled shim, which reads this bridge descriptor
 * from the private home (as the POSIX launcher carries the same values) and
 * starts Electron in Node mode on the helper. The desktop is single-instance
 * per user, so one descriptor per home suffices; close() removes it only
 * while it still holds this bridge's token.
 */
function startWindowsAskpass(
  home: string,
  endpoint: string,
  token: string,
  opts: { electronPath: string; helperPath: string; windowsShimPath?: string },
  server: Server,
  lifetime: AbortController,
): RunningSshAskpass | Promise<RunningSshAskpass> {
  const descriptor = join(home, 'ssh-askpass.txt');
  const contents = `${opts.electronPath}\n${opts.helperPath}\n${endpoint}\n${token}\n`;
  try {
    if (opts.windowsShimPath === undefined)
      throw new Error('the Windows askpass program is missing');
    const temporary = `${descriptor}.${process.pid}.tmp`;
    writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    renameWithRetrySync(temporary, descriptor);
  } catch (error) {
    return new Promise<RunningSshAskpass>((_resolve, reject) =>
      server.close(() => reject(error instanceof Error ? error : new Error(String(error)))),
    );
  }
  const program = opts.windowsShimPath;
  let closed = false;
  return {
    program,
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      lifetime.abort();
      server.closeAllConnections();
      try {
        if (readFileSync(descriptor, 'utf8') === contents) rmSync(descriptor, { force: true });
      } catch {
        // A newer bridge owns the descriptor, or it is already gone.
      }
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const MAX_REQUEST_BYTES = 64 * 1024;

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
  prompt: (request: SshAskpassRequest, signal: AbortSignal) => Promise<string | null>,
  lifetime: AbortSignal,
): Promise<void> {
  if (request.method !== 'POST' || request.url !== '/askpass') {
    sendJson(response, 404, { error: 'not found' });
    return;
  }
  if (!sameSecret(request.headers.authorization, `Bearer ${token}`)) {
    sendJson(response, 401, { error: 'unauthorised' });
    return;
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once('close', abort);
  lifetime.addEventListener('abort', abort, { once: true });
  try {
    if (lifetime.aborted || response.destroyed) controller.abort();
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        sendJson(response, 413, { error: 'request too large' });
        request.destroy();
        return;
      }
    }
    const value: unknown = JSON.parse(body);
    if (!isAskpassRequest(value)) {
      sendJson(response, 400, { error: 'invalid request' });
      return;
    }
    if (controller.signal.aborted) return;
    const answer = await prompt(value, controller.signal);
    sendJson(response, 200, answer === null ? { cancelled: true } : { answer });
  } catch {
    // A malformed helper request or a window disappearing both fail closed:
    // ssh sees a cancelled askpass invocation and aborts authentication.
    sendJson(response, 400, { error: 'authentication cancelled' });
  } finally {
    response.off('close', abort);
    lifetime.removeEventListener('abort', abort);
  }
}

function isAskpassRequest(value: unknown): value is SshAskpassRequest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { prompt?: unknown; kind?: unknown; target?: unknown };
  return (
    typeof candidate.target === 'string' &&
    candidate.target.length > 0 &&
    candidate.target.length <= MAX_REQUEST_BYTES &&
    typeof candidate.prompt === 'string' &&
    candidate.prompt.length <= MAX_REQUEST_BYTES &&
    (candidate.kind === 'secret' || candidate.kind === 'confirm')
  );
}

function sameSecret(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
