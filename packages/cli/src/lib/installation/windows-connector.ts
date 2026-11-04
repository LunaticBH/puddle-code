import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { daemonEnvironment, setEnv } from '@puddle/shared/node/platform';

/**
 * The remote-access connector on this Windows machine (docs/windows.md):
 * `puddle remote` and the cockpit run the installed `connector.mjs` with the
 * installed node.exe directly, as POSIX hosts run it through the transport's
 * fixed commands; nothing goes through a shell, and values travel on stdin.
 * Enabling it under supervision is the connector's own `--configure`, which
 * asks the home's supervisor to run it.
 */

export interface WindowsConnectorPaths {
  node: string;
  script: string;
}

/** Through the `current` junction, as the supervisor runs it. */
export function windowsConnectorPaths(home: string): WindowsConnectorPaths {
  const current = join(home, 'bin', 'current');
  return {
    node: join(current, 'bin', 'node.exe'),
    script: join(current, 'daemon', 'connector.mjs'),
  };
}

export interface ConnectorRun {
  code: number;
  stdout: string;
  stderr: string;
}

export type WindowsConnectorRunner = (
  home: string,
  args: readonly string[],
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<ConnectorRun>;

/** Output beyond this is not an answer any connector mode gives. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * The connector's environment: the home always named (as the POSIX units
 * name it), without agent-orchestration variables. PUDDLE_HOME outside the
 * profile is passed absolute.
 */
export function connectorEnvironment(
  home: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = daemonEnvironment(source, home);
  setEnv(env, 'PUDDLE_HOME', resolvePath(home), 'win32');
  return env;
}

/**
 * One run of the installed connector with `args`. It resolves on exit: a
 * supervisor that `--configure` may start as its detached child keeps no
 * handle on these pipes, but a late close must not hold the answer back.
 */
export const runWindowsConnector: WindowsConnectorRunner = (home, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const { node, script } = windowsConnectorPaths(home);
    const child = spawn(node, [script, ...args], {
      cwd: homedir(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: connectorEnvironment(home),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(124);
    }, opts.timeoutMs ?? 30_000);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) child.kill();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      if (stderr.length > MAX_OUTPUT_BYTES) child.kill();
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => finish(code ?? 1));
    child.once('exit', (code) => {
      // Give the pipes a moment to drain after the process is gone.
      setTimeout(() => finish(code ?? 1), 1000).unref();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
  });

/** Whether the installed release ships the connector. */
export function windowsConnectorInstalled(home: string): boolean {
  return existsSync(windowsConnectorPaths(home).script);
}
