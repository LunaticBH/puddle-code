import { createRequire } from 'node:module';
import { afterAll, expect, vi } from 'vitest';
import {
  describeProcess,
  report,
  runTeardowns,
  stopStrays,
  teardownsRegistered,
} from './process-guard.js';

/**
 * Vitest setup file (see process-guard.ts): after each test file, run the
 * teardowns its helpers registered, then, on Windows, stop and name whatever
 * the file still left running below this worker. A file that registered no
 * teardown and never loaded node-pty is not looked at: reading the process
 * table starts a PowerShell worker.
 */
const fileStartedAt = Date.now();
const file = expect.getState().testPath ?? 'a test file';

const ptyLoaded = () =>
  Object.keys(createRequire(import.meta.url).cache).some((path) => /[\\/]node-pty[\\/]/.test(path));

afterAll(async () => {
  // Teardowns wait on real time, whatever a test left installed.
  vi.useRealTimers();
  const registered = teardownsRegistered();
  await runTeardowns();
  if (process.platform !== 'win32' || (!registered && !ptyLoaded())) return;
  try {
    const strays = await stopStrays(fileStartedAt);
    if (strays.length > 0) {
      report(
        `stopped ${strays.length} process(es) ${file} left running:\n` +
          strays.map((entry) => `  ${describeProcess(entry)}`).join('\n'),
      );
    }
  } catch (err) {
    report(`could not look for processes ${file} left: ${(err as Error).message}`);
  }
}, 60_000);
