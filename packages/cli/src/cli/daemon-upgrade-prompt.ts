import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { daemonUpgradeMessage, type ConfirmDaemonUpgrade } from '../lib/connection/handshake.js';
import { confirm } from './prompt.js';

const REQUEST = 'puddle:confirm-daemon-upgrade';
const RESPONSE = 'puddle:daemon-upgrade-answer';

async function askToUpgrade(message: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  return confirm(`${message}\n\nUpdate and connect?`);
}

/** Foreground prompts directly; a detached cockpit uses its launching terminal's IPC pipe. */
export const confirmDaemonUpgrade: ConfirmDaemonUpgrade = async (request) => {
  const message = daemonUpgradeMessage(request);
  if (!process.send || !process.connected) return askToUpgrade(message);
  return requestDaemonUpgradeApproval(message, process);
};

/** Kept separate so cancellation and reply correlation can be tested without a terminal. */
export function requestDaemonUpgradeApproval(
  message: string,
  channel: Pick<NodeJS.Process, 'send' | 'connected' | 'on' | 'off' | 'once'>,
): Promise<boolean> {
  if (!channel.send || !channel.connected) return Promise.resolve(false);
  const id = randomUUID();
  return new Promise<boolean>((resolve) => {
    const finish = (approved: boolean) => {
      channel.off('message', answered);
      channel.off('disconnect', disconnected);
      resolve(approved);
    };
    const answered = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const response = value as Record<string, unknown>;
      if (response.t === RESPONSE && response.id === id && typeof response.approved === 'boolean')
        finish(response.approved);
    };
    const disconnected = () => finish(false);
    channel.on('message', answered);
    channel.once('disconnect', disconnected);
    channel.send!({ t: REQUEST, id, message }, (err: Error | null) => {
      if (err) finish(false);
    });
  });
}

/** The pipe belongs to this exact child; approval is never written to disk or inherited. */
export function relayDaemonUpgradePrompt(
  child: ChildProcess,
  ask: (message: string) => Promise<boolean> = askToUpgrade,
): () => void {
  let active = true;
  let pending = false;
  const receive = (value: unknown) => {
    if (pending || !value || typeof value !== 'object') return;
    const request = value as Record<string, unknown>;
    if (
      request.t !== REQUEST ||
      typeof request.id !== 'string' ||
      typeof request.message !== 'string'
    )
      return;
    pending = true;
    void ask(request.message)
      .catch(() => false)
      .then((approved) => {
        pending = false;
        if (active && child.connected)
          child.send({ t: RESPONSE, id: request.id, approved }, () => {});
      });
  };
  child.on('message', receive);
  return () => {
    active = false;
    child.off('message', receive);
    if (child.connected) child.disconnect();
  };
}
