// A stand-in for the ConPTY helper (src/pty/conpty-jobs.ts), speaking its
// protocol, for conpty-helper.test.ts on any OS:
//
//   node fake-conpty-helper.mjs <mode>
//
// Modes: `serve` answers every request; `fail` exits before it is ready, as
// PowerShell does when Constrained Language Mode refuses Add-Type; `mute`
// never becomes ready; `quit-after-track` exits once it has answered its
// first track; `slow-scan` never answers a scan.
//
// A track answers by pid: below 1000 `ok` (created at the window's start,
// its host pid 7000), from 1000 `other`, from 2000 `gone`. A scan names the
// root (pid 10), a console child (11), a GUI programme (12) and another
// console's process (13). A classify answers pids below 1000 as console
// programmes on console 7000, from 1000 as GUI programmes, from 2000 as
// detached, and leaves out those from 3000 (no longer running).
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
      const [id, pid, from] = args.map((arg, index) => (index === 0 ? arg : Number(arg)));
      held.set(id, { root: true, host: true });
      if (pid >= 2000) reply('gone 0 0 0');
      else if (pid >= 1000) reply(`other ${from - 60_000} 0 0`);
      else reply(`ok ${from} 7000 ${from - 5}`);
      if (mode === 'quit-after-track') process.exit(0);
    } else if (verb === 'alive') {
      const state = held.get(args[0]);
      reply(`ok ${state?.root ? 1 : 0} ${state?.host ? 1 : 0}`);
    } else if (verb === 'scan') {
      if (mode === 'slow-scan') return;
      const listed = args[1] === '1' ? 1 : 0;
      reply(
        `ok 1 1 10:100:3:7000:${listed} 11:200:3:7000:${listed} 12:300:2:7000:0 13:400:3:8000:0`,
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
      const [id, pid, created] = args;
      held.set(id, { root: false, host: true });
      reply(pid === '7000' ? `ok ${created}` : 'gone');
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
