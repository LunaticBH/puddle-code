/**
 * The PTY owns each CLI process tree. The private socket carries commands and
 * structured stdout; only deliberately rendered text reaches the terminal.
 * Kept inline so bundled releases need no extra executable or module lookup.
 * The source holds no double quotes, which node-pty's Windows command-line
 * quoting would have to escape.
 *
 * Windows has no process groups or SIGTERM. The CLI runs hidden in a console
 * of its own, never the PTY's (libuv starts a child with `windowsHide` and no
 * inherited stdio with CREATE_NO_WINDOW), so that, like a POSIX CLI in a
 * session of its own, it never reads or writes the terminal; that console
 * stands for its process group (docs/windows.md, decision 8). Ending a turn,
 * or the driver, ends the CLI and what is attached to its console, through a
 * ConPTY helper the driver starts with its first turn (`own`,
 * pty/conpty-jobs.ts; the daemon sends how, as `helper`), which holds each
 * process open from when it names it, so that no pid it ends is ever another
 * process's: never a GUI programme nor what one started, nor what left the
 * console (a detached process, one in a console of its own), as the PTY's
 * teardown spares them. The next turn is admitted only once that is done.
 * A helper that exits (an agent's `Stop-Process -Name powershell`, say) is
 * replaced, and the running turn's CLI held again a second on, even when it
 * exits before it has started (such a Stop-Process may catch it compiling);
 * after a second in a row that could not start (Constrained Language Mode,
 * or too slow), one is tried again five minutes on, as the daemon retries
 * its own. Until a helper holds the CLI, only the CLI is ended, through its
 * own handle; nothing is logged. A
 * driver ended before it could do this (a SIGKILL, or the supervisor's reap
 * after a daemon crash once the driver has outlasted Windows' 5 s for a
 * console's close) takes the CLI and its helper with it (libuv holds the
 * children it starts in a kill-on-close job), but nothing else attached to
 * the CLI's console.
 */
export const HEADLESS_TERMINAL_SOURCE = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
const socket = net.connect(process.argv[1]);
const token = process.argv[2];
const windows = process.platform === 'win32';
let child = null, current = null, buffer = '', stopping = false, killTimer = null, release = null;
let launch = null, helper = null, asked = 0, holds = 0, unready = 0;
const send = (message) => {
  if (!socket.destroyed) return socket.write(JSON.stringify(message) + '\n');
  return false;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Windows: this driver's ConPTY helper, ending with this process. One that
// exits is replaced at once (the running turn's CLI held again a second on)
// if it had started, or if it is the first in a row to exit before it had:
// an agent's Stop-Process may have caught it compiling. A second such exit
// in a row is one that cannot start, tried again five minutes on.
const startHelper = () => {
  if (!launch) return null;
  if (helper && (!helper.dead || Date.now() < helper.retry)) return helper;
  let proc;
  try {
    proc = spawn(launch.file, launch.args, {
      env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
  } catch {
    return (helper = { dead: true, retry: Date.now() + 300000, up: Promise.resolve(false) });
  }
  const self = helper = { proc, dead: false, retry: 0, up: null, answers: new Map() };
  let text = '', ready = false;
  self.up = new Promise((resolve) => {
    const timer = setTimeout(() => { gone(); proc.kill(); }, 15000);
    const gone = () => {
      clearTimeout(timer);
      resolve(false);
      if (self.dead) return;
      self.dead = true;
      unready = ready ? 0 : unready + 1;
      const again = ready || unready < 2;
      self.retry = again ? 0 : Date.now() + 300000;
      for (const answer of [...self.answers.values()]) answer(null);
      // What it held is let go: the running turn's CLI is held through the next one.
      const cli = child;
      if (!again || !cli || stopping) return;
      setTimeout(() => {
        if (child === cli && !stopping && !killTimer && cli.helper === self) cli.held = hold(cli);
      }, 1000);
    };
    proc.on('error', gone);
    proc.on('exit', gone);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (data) => {
      text += data;
      for (;;) {
        const end = text.indexOf('\n');
        if (end < 0) break;
        const line = text.slice(0, end).trim(); text = text.slice(end + 1);
        const space = line.indexOf(' ');
        if (line === 'ready') { ready = true; unready = 0; clearTimeout(timer); resolve(true); }
        else if (space > 0) self.answers.get(line.slice(0, space))?.(line.slice(space + 1));
      }
    });
  });
  proc.stdin.on('error', () => {});
  proc.stdout.on('error', () => {});
  return self;
};
// One request to a helper, the current one unless named; null when it is not
// available or does not answer within ms.
const ask = (line, ms, active = startHelper()) => {
  if (!active) return Promise.resolve(null);
  return active.up.then((up) => !up || active.dead ? null : new Promise((resolve) => {
    const seq = String(++asked);
    const done = (answer) => {
      clearTimeout(timer);
      active.answers.delete(seq);
      resolve(answer === null || answer.startsWith('error') ? null : answer);
    };
    const timer = setTimeout(() => done(null), ms);
    active.answers.set(seq, done);
    active.proc.stdin.write(seq + ' ' + line + '\n');
  }));
};
// A helper's hold on a CLI this driver spawned (between proc.from and
// proc.to), and on the console host of its own console; null without one.
const hold = (proc) => {
  const active = startHelper();
  if (!active || !proc.pid) return Promise.resolve(null);
  proc.helper = active;
  const id = 'cli' + (++holds);
  const request = ['own', id, proc.pid, proc.from - 100, proc.to + 100, process.pid].join(' ');
  return ask(request, 20000, active).then((answer) => {
    const [state, , host, hostCreated] = String(answer).split(' ');
    if (state === 'ok') {
      return { id, helper: active, host: Number(host), hostCreated: Number(hostCreated) };
    }
    if (answer !== null) ask('release ' + id, 1000, active);
    return null;
  });
};
// What a promise settles to by until; undefined while it has not.
const settled = async (promise, until) => {
  let value;
  promise.then((result) => (value = result));
  while (value === undefined && Date.now() < until) await pause(25);
  return value;
};
// Ends the CLI and what is attached to its console, held by the helper:
// created after its host and naming it, or listed by the console itself;
// never a GUI programme nor what one started, nor the host (it goes once
// nothing is attached). Then the CLI by its handle, should the helper not have.
const endCli = async (active) => {
  // A helper still starting is waited for, less long once the driver is stopping.
  const until = Date.now() + (stopping ? 1500 : 5000);
  let held = await settled(active.held, until);
  // The helper that held it, or tried to, has exited: held through the next
  // one, if one may start.
  if (held !== undefined && active.helper?.dead && startHelper() !== active.helper) {
    held = await settled((active.held = hold(active)), until);
  }
  for (let round = 0; held && round < 3; round++) {
    // The console's own list the first time, attaching to it no later than
    // 500 ms before this stops waiting (pty/conpty-jobs.ts, ATTACH_MARGIN_MS).
    const list = round === 0 ? '1 ' + (Date.now() + 1000) : '0 0';
    const scan = await ask('scan ' + held.id + ' ' + list, 1500, held.helper);
    const fields = (scan || '').split(' ');
    if (fields[0] !== 'ok') break;
    const targets = fields[1] === '1' ? ['root'] : [];
    for (const item of fields.slice(3)) {
      const [pid, created, subsystem, host, listed, guiStarted] = item.split(':').map(Number);
      const attached = held.host > 0 && created >= held.hostCreated &&
        (listed === 1 || host === held.host);
      if (attached && subsystem !== 2 && guiStarted !== 1) targets.push(pid + '@' + created);
    }
    if (targets.length === 0) break;
    await ask('terminate ' + held.id + ' ' + targets.join(' '), 1500, held.helper);
  }
  if (active.exitCode === null && active.signalCode === null) {
    try { active.kill(); } catch {}
  }
};
const kill = () => {
  const active = child;
  if (!active?.pid || killTimer) return;
  const pid = active.pid;
  if (windows) {
    const killer = killTimer = endCli(active).catch(() => {}).then(() => {
      if (killTimer !== killer) return;
      killTimer = null;
      release?.();
      if (stopping) process.exit(0);
    });
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
  // Windows: on once the CLI's console is ended, within the PTY's close grace.
  if (windows && killTimer) return void setTimeout(() => process.exit(0), 2500);
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
    } else if (windows && message.type === 'helper' && launch === null && helper === null) {
      launch = { file: String(message.file), args: message.args, env: message.env };
    } else if (message.type === 'cancel') {
      // Completion may already be in flight when cancellation arrives.
      if (message.id === current) kill();
    } else if (message.type === 'run' && child === null && !stopping) {
      const id = current = message.id;
      const env = { ...process.env, ...message.env };
      // Structured execution reports through its owner, not inherited hooks.
      delete env.PUDDLE_AGENT_SIGNAL_URL;
      delete env.PUDDLE_AGENT_SIGNAL_NONCE;
      const from = Date.now();
      const proc = child = spawn(message.binary, message.args, {
        env, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'],
        ...(windows ? { windowsHide: true, windowsVerbatimArguments: message.verbatim === true } : {}),
      });
      if (windows) {
        proc.from = from; proc.to = Date.now();
        proc.held = hold(proc);
      }
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
          // Windows: the turn's processes are ended, or exited: the helper lets them go.
          if (windows) proc.held.then((held) => held && ask('release ' + held.id, 1000, held.helper));
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
