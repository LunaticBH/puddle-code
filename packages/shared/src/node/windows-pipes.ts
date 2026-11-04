import { connect } from 'node:net';
import {
  connectorProvenSchema,
  controlResponseSchema,
  supervisorResponseSchema,
  type SupervisorRequest,
  type SupervisorResponse,
} from '../index.js';
import { checkIpcEndpoint, checkIpcProof, ipcChallenge, ipcPath, jsonLines } from './security.js';

/**
 * Probes of the private pipes Windows supervision relies on (docs/windows.md,
 * decision 3): the daemon's control pipe, the supervisor's and the
 * connector's. Each sends a fresh challenge and believes only an answer
 * that proves its server can read the home; nothing here starts anything.
 */

/**
 * What holds the home's daemon control pipe. `daemon`: a server that proves
 * it can read the home (one still starting answers `unavailable`, with its
 * proof). `foreign`: one that answers without that proof, so it is not this
 * home's daemon, whatever it says: another account's process squatting a
 * name that an earlier run used. `unknown`: no answer, or no access to the
 * pipe (an elevated daemon as well as another account's); it is waited
 * for, never replaced.
 */
export type ControlPipeState = 'absent' | 'daemon' | 'foreign' | 'unknown';

/** Probe with a challenged `open`; a lease the daemon grants ends with the probe's connection. */
export function controlPipeState(home: string, timeoutMs = 3000): Promise<ControlPipeState> {
  const challenge = ipcChallenge();
  return new Promise((resolve) => {
    const socket = connect(ipcPath(home, 'host'));
    let settled = false;
    const settle = (state: ControlPipeState) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs, () => settle('unknown'));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      settle(err.code === 'ENOENT' ? 'absent' : 'unknown'),
    );
    socket.once('close', () => settle('unknown'));
    jsonLines(
      socket,
      (value) => {
        const reply = controlResponseSchema.safeParse(value);
        const proof = reply.success && 'proof' in reply.data ? reply.data.proof : undefined;
        settle(checkIpcProof(home, 'host', challenge, proof) ? 'daemon' : 'foreign');
      },
      () => settle('foreign'),
    );
    socket.once('connect', () => socket.write(JSON.stringify({ t: 'open', challenge }) + '\n'));
  });
}

/**
 * `unsupported`: a pre-25.7 daemon (`invalid_control`). `unavailable`: one
 * still starting (`unavailable`), or one that does not answer. `foreign`: a
 * server without this home's proof (see ControlPipeState), never a daemon.
 */
export type ShutdownOutcome = 'stopping' | 'unsupported' | 'unavailable' | 'absent' | 'foreign';

/** Ask the home's daemon to stop over its private control pipe. */
export function requestDaemonShutdown(home: string, timeoutMs = 5000): Promise<ShutdownOutcome> {
  const challenge = ipcChallenge();
  return new Promise((resolve) => {
    const socket = connect(ipcPath(home, 'host'));
    let settled = false;
    const settle = (outcome: ShutdownOutcome) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(timeoutMs, () => settle('unavailable'));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      settle(err.code === 'ENOENT' ? 'absent' : 'unavailable'),
    );
    socket.once('close', () => settle('unavailable'));
    jsonLines(
      socket,
      (value) => {
        const message = controlResponseSchema.safeParse(value);
        if (!message.success) return settle('foreign');
        const reply = message.data;
        const proof = 'proof' in reply ? reply.proof : undefined;
        if (!checkIpcProof(home, 'host', challenge, proof)) return settle('foreign');
        if (reply.t === 'shutting_down') return settle('stopping');
        settle(
          reply.t === 'error' && reply.code === 'invalid_control' ? 'unsupported' : 'unavailable',
        );
      },
      () => settle('foreign'),
    );
    socket.once('connect', () => socket.write(JSON.stringify({ t: 'shutdown', challenge }) + '\n'));
  });
}

/**
 * The supervisor's answer, or why there is none: `absent` (no pipe),
 * `foreign` (a server without this home's proof), `unavailable` (no answer).
 */
export type SupervisorAnswer =
  { kind: 'answered'; state: SupervisorResponse } | { kind: 'absent' | 'foreign' | 'unavailable' };

/** One request over the supervisor's control pipe, believed only with its proof. */
export function supervisorRequest(
  home: string,
  t: SupervisorRequest['t'],
  timeoutMs = 5000,
): Promise<SupervisorAnswer> {
  const challenge = ipcChallenge();
  return new Promise((resolve) => {
    const path = ipcPath(home, 'supervisor');
    try {
      checkIpcEndpoint(path);
    } catch (err) {
      resolve({
        kind: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unavailable',
      });
      return;
    }
    const socket = connect(path);
    let settled = false;
    const settle = (answer: SupervisorAnswer) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => settle({ kind: 'unavailable' }));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      settle({ kind: err.code === 'ENOENT' ? 'absent' : 'unavailable' }),
    );
    socket.once('close', () => settle({ kind: 'unavailable' }));
    jsonLines(
      socket,
      (value) => {
        const reply = supervisorResponseSchema.safeParse(value);
        if (!reply.success || !checkIpcProof(home, 'supervisor', challenge, reply.data.proof)) {
          return settle({ kind: 'foreign' });
        }
        settle({ kind: 'answered', state: reply.data });
      },
      () => settle({ kind: 'foreign' }),
    );
    socket.once('connect', () => socket.write(JSON.stringify({ t, challenge }) + '\n'));
  });
}

/**
 * Who serves a connector pipe (`remote` or `remote-<profile>`), by its
 * challenge (protocol 25.7, Windows only): `proven` is this home's
 * connector, `foreign` a server that cannot prove it reads the home.
 */
export function connectorPipeState(
  home: string,
  scope: string,
  timeoutMs = 3000,
): Promise<'absent' | 'proven' | 'foreign' | 'unknown'> {
  const challenge = ipcChallenge();
  return new Promise((resolve) => {
    const path = ipcPath(home, scope);
    try {
      checkIpcEndpoint(path);
    } catch (err) {
      resolve((err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown');
      return;
    }
    const socket = connect(path);
    let settled = false;
    const settle = (state: 'absent' | 'proven' | 'foreign' | 'unknown') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs, () => settle('unknown'));
    socket.once('error', (err: NodeJS.ErrnoException) =>
      settle(err.code === 'ENOENT' ? 'absent' : 'unknown'),
    );
    socket.once('close', () => settle('unknown'));
    jsonLines(
      socket,
      (value) => {
        const reply = connectorProvenSchema.safeParse(value);
        settle(
          reply.success && checkIpcProof(home, scope, challenge, reply.data.proof)
            ? 'proven'
            : 'foreign',
        );
      },
      () => settle('foreign'),
    );
    socket.once('connect', () =>
      socket.write(JSON.stringify({ t: 'challenge', challenge }) + '\n'),
    );
  });
}
