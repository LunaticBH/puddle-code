import { fileURLToPath } from 'node:url';
import {
  ConptyHelper,
  type ConptyConsole,
  type ConptyJobs,
  type ConsoleScan,
} from '../../src/pty/conpty-jobs.js';

/**
 * ConPTY helpers (src/pty/conpty-jobs.ts) that answer late or never, for
 * the Windows teardown tests' bounds: a PTY's exit must be reported within
 * SessionService.kill's limits whatever the helper does.
 */

/** The real helper, each answer about a PTY `ms` late, as on a loaded host. */
export function slowHelper(ms: number): ConptyJobs {
  const inner = new ConptyHelper();
  const late = <T>(work: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => setTimeout(() => work().then(resolve, reject), ms));
  return {
    ready: () => inner.ready(),
    track: async (pid, window) => {
      const held = await inner.track(pid, window);
      if (!held) return null;
      const slow: ConptyConsole = {
        rootCreatedAtMs: held.rootCreatedAtMs,
        host: held.host,
        alive: () => late(() => held.alive()),
        scan: (options) => late(() => held.scan(options)),
        terminate: (keys) => late(() => held.terminate(keys)),
        release: () => held.release(),
      };
      return slow;
    },
  };
}

/** A scan PtyManager asked for: when, how, and what the helper answered. */
export interface AskedScan {
  atMs: number;
  attach: boolean;
  attachByMs: number | undefined;
  scan: ConsoleScan | null;
}

/**
 * The real helper, each scan that reads the console's own list taken up
 * `ms` late, as by a helper short of CPU; every scan is noted in `asked`.
 */
export function lateListingHelper(ms: number, asked: AskedScan[]): ConptyJobs {
  const inner = new ConptyHelper();
  return {
    ready: () => inner.ready(),
    track: async (pid, window) => {
      const held = await inner.track(pid, window);
      if (!held) return null;
      const late: ConptyConsole = {
        rootCreatedAtMs: held.rootCreatedAtMs,
        host: held.host,
        alive: () => held.alive(),
        scan: async (options) => {
          const atMs = Date.now();
          if (options.attach) await new Promise((resolve) => setTimeout(resolve, ms));
          const scan = await held.scan(options);
          asked.push({ atMs, attach: options.attach, attachByMs: options.attachByMs, scan });
          return scan;
        },
        terminate: (keys) => held.terminate(keys),
        release: () => held.release(),
      };
      return late;
    },
  };
}

const fake = fileURLToPath(new URL('./fake-conpty-helper.mjs', import.meta.url));

/** A helper Constrained Language Mode stops: PowerShell refuses its Add-Type. */
export function refusedHelper(): ConptyJobs {
  return new ConptyHelper({ worker: { file: process.execPath, args: [fake, 'fail'] } });
}

/** A helper that starts and never answers about a PTY. */
export function silentHelper(): ConptyJobs {
  return { ready: async () => true, track: () => new Promise(() => {}) };
}
