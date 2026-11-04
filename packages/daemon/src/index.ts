#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@puddle/shared';
import {
  DAEMON_ALREADY_ACTIVE_EXIT,
  disableCurrentDirectorySearch,
} from '@puddle/shared/node/platform';
import { startDaemon } from './daemon.js';

// Windows: a bare program name never resolves in a child's working directory
// (a repository or worktree). A no-op on POSIX.
disableCurrentDirectorySearch();

// Inlined by esbuild in release tarballs (scripts/build-tarball.mjs); dev tsc
// builds fall back to reading the adjacent package.json.
declare const __PUDDLED_VERSION__: string | undefined;

function appVersion(): string {
  if (typeof __PUDDLED_VERSION__ !== 'undefined') return __PUDDLED_VERSION__;
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
    version: string;
  };
  return pkg.version;
}

const version = appVersion();

// Must exit before any daemon setup: the CLI probes installs over SSH with
// `puddled --version`, and a probe must never start a daemon as a side effect.
if (process.argv.includes('--version')) {
  console.log(`puddled ${version} (protocol ${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor})`);
  process.exit(0);
}

// The port is transport plumbing: settable here (--port) or in config.json,
// never surfaced in the UI (design decision 2026-07-13).
const portFlag = process.argv.indexOf('--port');
const port = portFlag !== -1 ? Number(process.argv[portFlag + 1]) : undefined;
if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
  console.error('--port must be an integer between 1 and 65535');
  process.exit(1);
}

const daemon = await startDaemon({
  version,
  ...(port !== undefined ? { port } : {}),
  // The private control channel's `shutdown` request; the daemon stops itself first.
  onShutdown: () => {
    console.log('shutdown requested over host control — sessions become interrupted');
    process.exit(0);
  },
}).catch((err: unknown) => {
  // Windows: another daemon serves this home. The supervisor reads this
  // status as "never compete" rather than as a crash to restart.
  if (
    process.platform === 'win32' &&
    err instanceof Error &&
    err.message.includes('already active')
  ) {
    console.error(`${err.message}: another puddled serves this home`);
    process.exit(DAEMON_ALREADY_ACTIVE_EXIT);
  }
  throw err;
});
console.log(`puddled ${version} listening on http://127.0.0.1:${daemon.port}`);

// Windows delivers no SIGTERM from another process (that is TerminateProcess);
// closing a --foreground console sends SIGHUP and Ctrl-Break SIGBREAK, each
// with a few seconds' grace.
const signals: NodeJS.Signals[] =
  process.platform === 'win32'
    ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']
    : ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
  process.on(signal, () => {
    console.log(`${signal} received — shutting down (sessions become interrupted)`);
    void daemon.stop().then(() => process.exit(0));
  });
}
