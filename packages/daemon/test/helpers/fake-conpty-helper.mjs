// A stand-in for the ConPTY helper (src/pty/conpty-jobs.ts), speaking its
// protocol, for conpty-helper.test.ts on any OS:
//
//   node fake-conpty-helper.mjs <mode>
//
// Modes: `serve` answers every request; `fail` exits before it is ready, as
// PowerShell does when Constrained Language Mode refuses Add-Type; `mute`
// never becomes ready; `quit-after-track` exits once it has answered its
// first claim; `slow-scan` never answers a scan.
//
// A track answers by pid: below 1000 `ok` (created at the window's end,
// running in the console host 7000, created at the window's start), from
// 1000 `other`, from 2000 `gone`; it names as candidates the host 7000 and
// one created 40 ms later (7001, another spawn's). From 3000 it names only
// that other spawn's host. A claim holds the host it is given, if it is one
// of those. A scan names the root (pid 10), a console child (11), a GUI
// programme (12), what it started (14) and another console's process (13);
// the console's own list names the first two, unless its attach-by has passed.
// An adopt holds the host 7000 only, and with it a root below 1000.
// A classify answers pids below 1000 as console programmes on console 7000,
// from 1000 as GUI programmes, from 2000 as detached, and leaves out those
// from 3000 (no longer running).
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'serve';
if (mode === 'fail') {
  process.stderr.write(
    'Add-Type : Cannot add type. Definition of new types is not supported in this language mode.\n',
  );
  process.exit(1);
}
if (mode === 'mute') {
  setInterval(() => {}, 1e9);
} else {
  process.stdout.write('ready\n');
  const held = new Map();
  createInterface({ input: process.stdin }).on('line', (line) => {
    const [seq, verb, ...args] = line.split(' ');
    const reply = (text) => process.stdout.write(`${seq} ${text}\n`);
    if (verb === 'track') {
      const [id, pid, from, to] = args.map((arg, index) => (index === 0 ? arg : Number(arg)));
      const candidates = { 7000: from, 7001: from + 40 };
      held.set(id, { root: pid < 1000, host: false, candidates });
      const named = `7000@${from} 7001@${from + 40}`;
      if (pid >= 3000) reply(`gone 0 0 7001@${from + 40}`);
      else if (pid >= 2000) reply(`gone 0 0 ${named}`);
      else if (pid >= 1000) reply(`other 0 0 ${named}`);
      else reply(`ok ${to} 7000 ${named}`);
    } else if (verb === 'claim') {
      const [id, rootOk, host, created] = args;
      const state = held.get(id);
      if (!state) return reply('none');
      if (rootOk !== '1') state.root = false;
      if (state.candidates[host] === Number(created)) {
        state.host = true;
        reply(`ok ${host} ${created}`);
      } else reply('ok 0 0');
      if (mode === 'quit-after-track') process.exit(0);
    } else if (verb === 'alive') {
      const state = held.get(args[0]);
      reply(`ok ${state?.root ? 1 : 0} ${state?.host ? 1 : 0}`);
    } else if (verb === 'scan') {
      if (mode === 'slow-scan') return;
      // `scan <id> <attach> <attach-by, Unix ms>`, as the helper takes it.
      if (args.length !== 3 || !/^-?\d+$/.test(args[2])) return reply('error usage');
      const listed = args[1] === '1' && Number(args[2]) >= Date.now() ? 1 : 0;
      reply(
        `ok 1 1 10:100:3:7000:${listed}:0 11:200:3:7000:${listed}:0 12:300:2:7000:0:0 ` +
          `14:350:3:7000:0:1 13:400:3:8000:0:0`,
      );
    } else if (verb === 'terminate') {
      const state = held.get(args[0]);
      if (state && args.includes('root')) state.root = false;
      if (state && args.includes('host')) state.host = false;
      reply(`ok ${args.length - 1}`);
    } else if (verb === 'release') {
      held.delete(args[0]);
      reply('ok');
    } else if (verb === 'adopt') {
      const [id, pid, created, , root, rootCreated] = args;
      // A root below 1000 is still the one recorded.
      const rootHeld = root !== '0' && Number(root) < 1000;
      held.set(id, { root: rootHeld, host: true });
      reply(pid === '7000' ? `ok ${created} ${rootHeld ? rootCreated : 0}` : 'gone');
    } else if (verb === 'classify') {
      const items = args.slice(1).flatMap((key) => {
        const [pid, created] = key.split('@').map(Number);
        if (pid >= 3000) return [];
        const subsystem = pid >= 1000 && pid < 2000 ? 2 : 3;
        const host = pid >= 2000 ? 0 : 7000;
        return [`${pid}:${created}:${subsystem}:${host}`];
      });
      reply(['ok', ...items].join(' '));
    } else {
      reply('error usage');
    }
  });
}
