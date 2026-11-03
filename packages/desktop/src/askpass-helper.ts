import { request } from 'node:http';
import { askpassKind, askpassPrompt } from './askpass-prompt.js';

const endpoint = process.env.PUDDLE_DESKTOP_ASKPASS_URL;
const token = process.env.PUDDLE_DESKTOP_ASKPASS_TOKEN;
const target = process.env.PUDDLE_DESKTOP_SSH_TARGET;
const raw = process.argv[2] ?? 'SSH authentication';
const kind = askpassKind(raw, process.env);
const prompt = askpassPrompt(raw);

if (endpoint === undefined || token === undefined || target === undefined) process.exit(1);

const body = JSON.stringify({ prompt, kind, target });
const call = request(
  endpoint,
  {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    },
  },
  (response) => {
    let result = '';
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => (result += chunk));
    response.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(result);
        if (
          response.statusCode === 200 &&
          typeof parsed === 'object' &&
          parsed !== null &&
          'answer' in parsed &&
          typeof parsed.answer === 'string'
        ) {
          process.stdout.write(`${parsed.answer}\n`);
          return;
        }
      } catch {
        // A broken bridge is indistinguishable from cancellation to ssh.
      }
      process.exitCode = 1;
    });
  },
);
call.on('error', () => {
  process.exitCode = 1;
});
// OpenSSH can exit while its askpass child is still waiting for an answer.
// Drop the HTTP request so the desktop also discards its orphaned dialogue.
// On Windows the parent is ssh-askpass.exe, which watches ssh itself, and a
// process's recorded parent id never changes there.
const sshPid = process.ppid;
const parentCheck = setInterval(() => {
  try {
    if (sshPid <= 1 || (process.platform !== 'win32' && process.ppid !== sshPid)) {
      throw new Error('SSH parent exited');
    }
    process.kill(sshPid, 0);
  } catch {
    call.destroy();
    process.exitCode = 1;
  }
}, 1000);
parentCheck.unref();
call.once('close', () => clearInterval(parentCheck));
call.end(body);
