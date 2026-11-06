#!/usr/bin/env node
/**
 * A stand-in for the system ssh binary so the full `puddle launch user@host` flow runs
 * with zero real SSH. Interprets the argv shapes SshTransport and the tunnel
 * produce:
 *
 *   ssh <ctl…> host true                → master open: exit 0
 *   ssh <ctl…> -O check host            → master alive: exit 0
 *   ssh <ctl…> -O cancel -L … host      → drop a mux forward: exit 0 (no-op;
 *                                         the fake forwarder owns its own port)
 *   ssh <ctl…> host -- sh -c '<cmd>'    → run <cmd> locally against the fake
 *                                         host home (env FAKE_SSH_HOME)
 *   ssh <ctl…> -N -L lp:127.0.0.1:rp h  → a real TCP forwarder lp → rp,
 *                                         alive until killed (or until the
 *                                         file $FAKE_SSH_KILL appears); lp = rp
 *                                         drops every connection, as nothing
 *                                         listens there on the host
 *
 * FAKE_SSH_HOME becomes both HOME and PUDDLE_HOME for executed commands, so
 * $HOME/.puddle paths in remote commands land in the test's temp dir. A
 * forwarder appends its local port to the file FAKE_SSH_LISTENING once it
 * listens, and to FAKE_SSH_ACCEPTED for every connection it accepts.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { connect, createServer } from 'node:net';

const args = process.argv.slice(2);
const positionals = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '-o') i += 1;
  else if (arg === '-O') {
    positionals.push('-O:' + args[i + 1]);
    i += 1;
  } else if (arg === '-L') {
    positionals.push('-L:' + args[i + 1]);
    i += 1;
  } else positionals.push(arg);
}

// Any control command (-O check | cancel | forward | exit) is a no-op here:
// the fake `-N -L` forwarder owns its own listener, so there is nothing on a
// master to check or cancel.
if (positionals.some((p) => p.startsWith('-O:'))) process.exit(0);

const forward = positionals.find((p) => p.startsWith('-L:'));
if (positionals.includes('-N') && forward !== undefined) {
  const [lp, , rp] = forward.slice(3).split(':');
  const server = createServer((client) => {
    if (process.env.FAKE_SSH_ACCEPTED) appendFileSync(process.env.FAKE_SSH_ACCEPTED, `${lp}\n`);
    // A port forwarded to itself would reach this listener again: the host
    // has no listener there, so the channel fails.
    if (lp === rp) {
      client.destroy();
      return;
    }
    const upstream = connect({ host: '127.0.0.1', port: Number(rp) });
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.listen(Number(lp), '127.0.0.1', () => {
    if (process.env.FAKE_SSH_LISTENING) appendFileSync(process.env.FAKE_SSH_LISTENING, `${lp}\n`);
  });
  const killFile = process.env.FAKE_SSH_KILL;
  if (killFile) {
    setInterval(() => {
      if (existsSync(killFile)) process.exit(1);
    }, 100).unref?.();
    setInterval(() => {}, 1000); // keep alive
  } else {
    setInterval(() => {}, 1000);
  }
} else {
  // Exec form: [host, '--', 'sh -c <quoted>'] — or the master's [host, 'true'].
  const last = positionals[positionals.length - 1];
  if (last === 'true') process.exit(0);
  const home = process.env.FAKE_SSH_HOME ?? process.env.HOME;
  const child = spawn('sh', ['-c', last], {
    stdio: ['inherit', 'inherit', 'inherit'],
    cwd: home, // ssh exec starts in the remote home dir
    env: { ...process.env, HOME: home, PUDDLE_HOME: `${home}/.puddle` },
  });
  child.on('close', (code) => process.exit(code ?? 1));
}
