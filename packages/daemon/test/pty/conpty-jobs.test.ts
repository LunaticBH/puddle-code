import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { listWindowsProcesses, type WindowsProcess } from '@puddle/shared/node/platform';
import { isConptyJobHost, JOB_HOST_ARGS, JobHost } from '../../src/pty/conpty-jobs.js';
import { onTeardown } from '../helpers/process-guard.js';
import { marked, stopMarked, survivors, waitUntil } from '../helpers/process-trees.js';

/**
 * The ConPTY job host (docs/windows.md, decision 8): its protocol against a
 * stand-in host on any OS, then the real one on Windows, which ends what a
 * PTY's tree started whichever of its parents have exited, and ends all of
 * it when the host itself goes.
 */

const fake = fileURLToPath(new URL('../helpers/fake-job-host.mjs', import.meta.url));
const hosts: JobHost[] = [];
function fakeHost(mode: string, options: { startMs?: number; answerMs?: number } = {}) {
  const lost: string[] = [];
  const host = new JobHost({
    worker: { file: process.execPath, args: [fake, mode] },
    onLost: (reason) => lost.push(reason),
    ...options,
  });
  hosts.push(host);
  return { host, lost };
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    const pid = host.pid;
    if (pid !== undefined) {
      try {
        process.kill(pid);
      } catch {
        // Gone already.
      }
    }
  }
});

const window = { fromMs: 1_000_000, toMs: 1_000_500 };

describe('JobHost', () => {
  it('assigns a process to a job and ends it once', async () => {
    const { host } = fakeHost('serve');
    expect(await host.ready()).toBe(true);
    const job = await host.assign(5, window);
    expect(job).not.toBeNull();
    const ended = job!.end();
    expect(job!.end()).toBe(ended);
    expect(await ended).toBe(2);
  });

  it('assigns nothing that another process took, that has gone, or that is no pid', async () => {
    const { host } = fakeHost('serve');
    expect(await host.assign(1500, window)).toBeNull();
    expect(await host.assign(2500, window)).toBeNull();
    expect(await host.assign(0, window)).toBeNull();
    expect(await host.assign(-3, window)).toBeNull();
  });

  it('assigns nothing when the host cannot start', async () => {
    const { host } = fakeHost('fail');
    expect(await host.ready()).toBe(false);
    expect(await host.assign(5, window)).toBeNull();
    // Not tried again at once.
    expect(await host.ready()).toBe(false);
  });

  it('stops a host that never becomes ready, which holds no job', async () => {
    const { host } = fakeHost('mute', { startMs: 300 });
    const started = Date.now();
    expect(await host.ready()).toBe(false);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(host.pid).toBeUndefined();
  });

  it('says so when a host holding jobs exits, and starts another for the next PTY', async () => {
    const { host, lost } = fakeHost('quit-after-assign');
    const job = await host.assign(5, window);
    expect(job).not.toBeNull();
    await waitUntil(() => lost.length === 1, 10_000, 'the host’s exit');
    expect(lost[0]).toMatch(/exit code 0/);
    // Its processes went with it.
    expect(await job!.end()).toBe(0);
    expect(await host.assign(6, window)).not.toBeNull();
  });

  it('fails a request answered too late without stopping the host and its jobs', async () => {
    const { host, lost } = fakeHost('slow-end', { answerMs: 200 });
    const job = await host.assign(5, window);
    const pid = host.pid;
    expect(await job!.end()).toBe(0);
    expect(host.pid).toBe(pid);
    expect(await host.assign(6, window)).not.toBeNull();
    expect(lost).toEqual([]);
  });

  it('is told apart from every other PowerShell by its command line', () => {
    expect(isConptyJobHost(`powershell.exe ${JOB_HOST_ARGS.join(' ')}`)).toBe(true);
    expect(
      isConptyJobHost(
        'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -',
      ),
    ).toBe(false);
  });
});

/**
 * `node -e SUBJECT <marker>` waits for a line on stdin, then starts three
 * processes through intermediates that exit at once (a detaching node,
 * `cmd /c start /b`, PowerShell's Start-Process), prints STARTED and waits.
 */
const SUBJECT = String.raw`
const { spawnSync } = require('node:child_process');
const marker = process.argv[1];
// No spaces: Windows PowerShell's -ArgumentList joins its arguments unquoted.
const keep = 'setInterval(()=>{},1e9)';
const hidden = { stdio: 'ignore', windowsHide: true };
process.stdin.once('data', () => {
  const detach = "require('child_process').spawn(process.execPath, ['-e', '" + keep + "', process.argv[1] + ':detached'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()";
  spawnSync(process.execPath, ['-e', detach, marker], hidden);
  spawnSync('cmd.exe', ['/d /c start "" /b "' + process.execPath + '" -e "' + keep + '" "' + marker + ':start"'], { ...hidden, windowsVerbatimArguments: true });
  const ps = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  spawnSync(ps, ['-NoLogo', '-NoProfile', '-Command', "Start-Process -WindowStyle Hidden '" + process.execPath + "' -ArgumentList '-e','" + keep + "','" + marker + ":start-process'"], hidden);
  process.stdout.write('STARTED\n');
});
setInterval(() => {}, 1e9);
`;

describe.skipIf(process.platform !== 'win32')('the ConPTY job host on Windows', () => {
  const markers: string[] = [];
  afterEach(async () => {
    for (const marker of markers.splice(0)) await stopMarked(marker);
  });

  /** The subject, assigned to a job of `host`, with its three orphans running. */
  async function subjectWithOrphans(host: JobHost) {
    const marker = mkdtempSync(join(tmpdir(), 'puddle-job-'));
    markers.push(marker);
    const fromMs = Date.now();
    const child = spawn(process.execPath, ['-e', SUBJECT, marker], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    onTeardown(() => {
      if (child.exitCode === null) child.kill();
    });
    const job = await host.assign(child.pid!, { fromMs: fromMs - 100, toMs: Date.now() + 100 });
    expect(job).not.toBeNull();
    let out = '';
    child.stdout!.on('data', (chunk) => (out += String(chunk)));
    child.stdin!.write('go\n');
    await waitUntil(() => out.includes('STARTED'), 30_000, 'the orphans');
    let orphans: WindowsProcess[] = [];
    await waitUntil(
      async () =>
        (orphans = (await marked(marker)).filter((p) => p.pid !== child.pid)).length === 3,
      30_000,
      'three orphans',
    );
    // Their parents have exited: nothing in the process table leads to them.
    const table = await listWindowsProcesses({ fresh: true });
    for (const orphan of orphans) {
      expect(table.some((p) => p.pid === orphan.pid && p.ppid === child.pid)).toBe(false);
    }
    return { child, job: job!, orphans };
  }

  it('ends every process started in the job, whichever parents have exited', async () => {
    const host = new JobHost();
    hosts.push(host);
    const { child, job, orphans } = await subjectWithOrphans(host);
    expect(await job.end()).toBeGreaterThanOrEqual(4);
    expect(await survivors([...orphans])).toEqual([]);
    await waitUntil(
      () => child.exitCode !== null || child.signalCode !== null,
      5000,
      'the subject',
    );
  });

  it('ends them all when the host itself is ended, as it is with its daemon', async () => {
    const host = new JobHost();
    hosts.push(host);
    const { orphans } = await subjectWithOrphans(host);
    process.kill(host.pid!); // TerminateProcess, as a crash
    expect(await survivors(orphans, 3000)).toEqual([]);
  });

  it('never assigns a process created outside the window it is given', async () => {
    const host = new JobHost();
    hosts.push(host);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    onTeardown(() => {
      if (child.exitCode === null) child.kill();
    });
    await new Promise((resolve) => child.once('spawn', resolve));
    const now = Date.now();
    expect(await host.assign(child.pid!, { fromMs: now + 60_000, toMs: now + 70_000 })).toBeNull();
    expect(await host.assign(2 ** 30, { fromMs: 0, toMs: now })).toBeNull();
    child.kill();
  });
});
