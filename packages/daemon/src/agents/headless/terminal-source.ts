/**
 * The PTY owns each CLI process tree. The private socket carries commands and
 * structured stdout; only deliberately rendered text reaches the terminal.
 * Kept inline so bundled releases need no extra executable or module lookup.
 * The source holds no double quotes, which node-pty's Windows command-line
 * quoting would have to escape.
 *
 * Windows has no process groups or SIGTERM: the CLI stays attached to the
 * ConPTY console (so closing the terminal ends it) with its window hidden,
 * and `taskkill /T /F` stops its whole tree. The next turn is admitted only
 * after taskkill exits. A descendant whose parent already exited is no longer
 * reachable through the tree; only a job object could hold it.
 */
export const HEADLESS_TERMINAL_SOURCE = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
const socket = net.connect(process.argv[1]);
const token = process.argv[2];
const windows = process.platform === 'win32';
const taskkill = require('node:path').win32.join(
  process.env.SystemRoot || process.env.windir || 'C:/Windows', 'System32', 'taskkill.exe');
let child = null, current = null, buffer = '', stopping = false, killTimer = null, release = null;
const send = (message) => {
  if (!socket.destroyed) return socket.write(JSON.stringify(message) + '\n');
  return false;
};
const kill = () => {
  const active = child;
  if (!active?.pid || killTimer) return;
  const pid = active.pid;
  if (windows) {
    const killer = killTimer = spawn(taskkill, ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
    const done = () => {
      if (killTimer !== killer) return;
      killTimer = null;
      release?.();
    };
    killer.once('error', done);
    killer.once('exit', done);
    return;
  }
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  killTimer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch {}
    killTimer = null;
    release?.();
  }, 500);
};
const stop = () => {
  if (stopping) return;
  stopping = true;
  kill();
  setTimeout(() => process.exit(0), 550);
};
process.on('SIGHUP', stop);
process.on('SIGTERM', stop);
socket.on('close', stop);
socket.on('error', stop);
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on('data', (data) => {
  if (data.includes(3)) send({ type: 'interrupt' });
});
socket.on('connect', () => {
  process.stdout.write('Puddlang headless session. Ctrl+C interrupts the current turn.\r\n');
  send(token ? { type: 'ready', token } : { type: 'ready' });
});
socket.setEncoding('utf8');
socket.on('data', (data) => {
  buffer += data;
  if (buffer.length > 2 * 1024 * 1024) return stop();
  for (;;) {
    const end = buffer.indexOf('\n');
    if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    let message;
    try { message = JSON.parse(line); } catch { return stop(); }
    if (message.type === 'display') {
      process.stdout.write(String(message.text).replace(/\r?\n/g, '\r\n'));
    } else if (message.type === 'cancel') {
      // Completion may already be in flight when cancellation arrives.
      if (message.id === current) kill();
    } else if (message.type === 'run' && child === null && !stopping) {
      const id = current = message.id;
      const env = { ...process.env, ...message.env };
      // Structured execution reports through its owner, not inherited hooks.
      delete env.PUDDLE_AGENT_SIGNAL_URL;
      delete env.PUDDLE_AGENT_SIGNAL_NONCE;
      const proc = child = spawn(message.binary, message.args, {
        env, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'],
        ...(windows ? { windowsHide: true, windowsVerbatimArguments: message.verbatim === true } : {}),
      });
      for (const name of ['stdout', 'stderr']) proc[name].on('data', (bytes) => {
        if (!send({ type: name, id, data: bytes.toString('base64') })) proc[name].pause();
      });
      socket.on('drain', drain);
      function drain() { proc.stdout.resume(); proc.stderr.resume(); }
      proc.on('error', (error) => send({ type: 'error', id, error: error.message }));
      proc.stdin.on('error', () => {});
      proc.stdin.end(message.stdin);
      proc.on('close', (code, signal) => {
        socket.off('drain', drain);
        release = () => {
          child = null; current = null; release = null;
          send({ type: 'exit', id, code, signal });
        };
        if (killTimer && !windows) {
          try { process.kill(-proc.pid, 0); }
          catch { clearTimeout(killTimer); killTimer = null; }
        }
        // Do not admit the next turn while cancelled descendants still live.
        if (!killTimer) release();
      });
    } else return stop();
  }
});
`;
