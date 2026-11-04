#!/usr/bin/env node
import { disableCurrentDirectorySearch } from '@puddle/shared/node/platform';
import { parseArgs } from './cli/args.js';
import { run } from './cli/run.js';
import { CliError } from './lib/types.js';

// Windows: a bare program name (ssh, npm, git) never resolves in the directory
// the command was started from, which may be a repository. A no-op on POSIX.
disableCurrentDirectorySearch();

/**
 * Leave with `code`. On Windows an immediate process.exit can abort Node
 * itself ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" in
 * libuv's async.c, verified with Node 24.19) while V8 still compiles fetch's
 * WebAssembly HTTP parser in the background, as after `puddle status`'s
 * parallel requests. Exiting once the event loop drains lets Node finish that
 * work first; anything still holding the loop open is cut off after a second.
 */
function exit(code: number): void {
  if (process.platform !== 'win32') process.exit(code);
  process.exitCode = code;
  setTimeout(() => process.exit(code), 1000).unref();
}

try {
  const command = parseArgs(process.argv.slice(2));
  exit(await run(command));
} catch (err) {
  if (err instanceof CliError) {
    process.stderr.write(`Puddle: ${err.message}\n`);
    if (err.hint !== undefined) process.stderr.write(`  hint: ${err.hint}\n`);
    exit(1);
  } else throw err;
}
