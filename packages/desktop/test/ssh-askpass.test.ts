import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- untyped build helper, also used by scripts/build.mjs
import { compileAskpassShim } from '../scripts/askpass-shim.mjs';
import { askpassKind, askpassPrompt } from '../src/askpass-prompt.js';
import {
  startSshAskpass,
  type RunningSshAskpass,
  type SshAskpassRequest,
} from '../src/ssh-askpass.js';

let home: string;
let bridge: RunningSshAskpass;
// Windows OpenSSH runs the compiled shim, which starts the helper (here under node).
let shimDir: string | undefined;
const windowsShimPath = () =>
  shimDir === undefined ? undefined : join(shimDir, 'ssh-askpass.exe');
beforeAll(() => {
  if (process.platform !== 'win32') return;
  shimDir = mkdtempSync(join(tmpdir(), 'puddle-askpass-shim-'));
  (compileAskpassShim as (out: string) => void)(windowsShimPath()!);
});
afterAll(() => {
  if (shimDir !== undefined) rmSync(shimDir, { recursive: true, force: true });
});
const children: ChildProcess[] = [];
const signals: AbortSignal[] = [];
const prompt = vi.fn((_request: SshAskpassRequest, signal: AbortSignal): Promise<string | null> => {
  signals.push(signal);
  return new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)));
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'puddle-askpass-test-'));
  signals.length = 0;
  prompt.mockClear();
  const helperPath = join(home, 'helper.cjs');
  buildSync({
    entryPoints: [fileURLToPath(new URL('../src/askpass-helper.ts', import.meta.url))],
    outfile: helperPath,
    // As scripts/build.mjs does: the helper imports its prompt rules.
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  bridge = await startSshAskpass({
    home,
    electronPath: process.execPath,
    helperPath,
    windowsShimPath: windowsShimPath(),
    prompt,
  });
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await bridge?.close();
  rmSync(home, { recursive: true, force: true });
});

// The Windows shim finds the bridge descriptor through PUDDLE_HOME.
const env = () => ({ ...process.env, PUDDLE_HOME: home, PUDDLE_DESKTOP_SSH_TARGET: 'user@host' });
const startHelper = () => {
  const child = spawn(bridge.program, ['Password:'], { env: env(), stdio: 'pipe' });
  children.push(child);
  return child;
};

describe('SSH askpass bridge and helper', () => {
  it('relays the target and cancels the prompt when the helper disconnects', async () => {
    const child = startHelper();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt.mock.calls[0][0]).toEqual({
      target: 'user@host',
      prompt: 'Password:',
      kind: 'secret',
    });
    expect(signals[0].aborted).toBe(false);
    child.kill();
    await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
  });

  it('closes an orphaned helper request when its SSH parent exits', async () => {
    // This fake SSH process owns the real helper, then dies without killing it.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `
      const { spawn } = require('node:child_process');
      const helper = spawn(process.argv[1], ['Password:'], { stdio: 'ignore' });
      process.send(helper.pid);
      setInterval(() => {}, 1000);
    `,
        bridge.program,
      ],
      { env: env(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    children.push(parent);
    const [helperPid] = await once(parent, 'message');
    try {
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      parent.kill();
      await vi.waitFor(() => expect(signals[0].aborted).toBe(true), { timeout: 4000 });
    } finally {
      try {
        process.kill(helperPid as number, 'SIGTERM');
      } catch {
        /* Already exited. */
      }
    }
  });

  it('cancels pending authentication on bridge shutdown and lets the helper exit', async () => {
    const child = startHelper();
    const exited = once(child, 'exit');
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    await bridge.close();
    expect(signals[0].aborted).toBe(true);
    expect((await exited)[0]).toBe(1);
  });

  it('passes a live response only to its helper', async () => {
    prompt.mockImplementationOnce(async () => 'test answer');
    const child = startHelper();
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    expect((await once(child, 'exit'))[0]).toBe(0);
    expect(output).toBe('test answer\n');
  });

  it('returns cancellation to SSH without writing a password', async () => {
    prompt.mockResolvedValueOnce(null);
    const child = startHelper();
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    expect((await once(child, 'exit'))[0]).toBe(1);
    expect(output).toBe('');
  });
});

describe('Windows askpass bridge descriptor', () => {
  it('points OpenSSH at the shim and hands it the bridge through the private home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-askpass-win-'));
    try {
      const windows = await startSshAskpass({
        home: dir,
        electronPath: 'C:\\Program Files\\Puddle\\Puddle.exe',
        helperPath: 'C:\\Program Files\\Puddle\\resources\\askpass-helper.cjs',
        windowsShimPath: 'C:\\Program Files\\Puddle\\resources\\ssh-askpass.exe',
        platform: 'win32',
        prompt,
      });
      expect(windows.program).toBe('C:\\Program Files\\Puddle\\resources\\ssh-askpass.exe');
      const [electron, helper, endpoint, token, rest] = readFileSync(
        join(dir, 'ssh-askpass.txt'),
        'utf8',
      ).split('\n');
      expect([electron, helper, rest]).toEqual([
        'C:\\Program Files\\Puddle\\Puddle.exe',
        'C:\\Program Files\\Puddle\\resources\\askpass-helper.cjs',
        '',
      ]);
      expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/askpass$/);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      await windows.close();
      expect(existsSync(join(dir, 'ssh-askpass.txt'))).toBe(false);
      await expect(
        startSshAskpass({
          home: dir,
          electronPath: 'e',
          helperPath: 'h',
          platform: 'win32',
          prompt,
        }),
      ).rejects.toThrow(/askpass program is missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('askpass prompt classification', () => {
  const hostKey =
    'The authenticity of host ... SHA256:ab/cd+ef/gh=.\r\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ';
  // Windows OpenSSH rewrites every / in the askpass argument to \.
  const windowsHostKey = hostKey.replaceAll('/', '\\');

  it('recognises host-key confirmations on both platforms', () => {
    expect(askpassKind(hostKey, {}, 'linux')).toBe('confirm');
    expect(askpassKind(windowsHostKey, {}, 'linux')).toBe('secret');
    expect(askpassKind(windowsHostKey, {}, 'win32')).toBe('confirm');
    expect(askpassKind('Password:', { SSH_ASKPASS_PROMPT: 'confirm' }, 'linux')).toBe('confirm');
    expect(askpassKind('Password:', {}, 'win32')).toBe('secret');
  });

  it('restores fingerprints and choices but leaves Windows paths alone', () => {
    expect(askpassPrompt(windowsHostKey, 'win32')).toBe(hostKey);
    expect(askpassPrompt(windowsHostKey, 'linux')).toBe(windowsHostKey);
    const passphrase = "Enter passphrase for key 'C:\\Users\\a\\.ssh\\id_ed25519': ";
    expect(askpassPrompt(passphrase, 'win32')).toBe(passphrase);
  });
});
