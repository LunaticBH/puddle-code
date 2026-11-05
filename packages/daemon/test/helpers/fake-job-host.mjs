// A stand-in for the ConPTY job host (src/pty/conpty-jobs.ts), speaking its
// protocol, for conpty-jobs.test.ts on any OS:
//
//   node fake-job-host.mjs <mode>
//
// Modes: `serve` answers every request; `fail` exits before it is ready;
// `mute` never becomes ready; `quit-after-assign` exits once it has
// answered its first assignment; `slow-end` never answers an `end`.
// Assignments answer by pid: below 1000 `ok` (created at the window's
// start), from 1000 `other`, from 2000 `gone`. Each job counts two
// processes when ended.
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'serve';
if (mode === 'fail') {
  process.stderr.write('Add-Type : compilation refused\n');
  process.exit(1);
}
if (mode === 'mute') {
  setInterval(() => {}, 1e9);
} else {
  process.stdout.write('ready\n');
  const jobs = new Set();
  createInterface({ input: process.stdin }).on('line', (line) => {
    const [id, verb, ...args] = line.split(' ');
    if (verb === 'assign') {
      const [pid, from] = args.map(Number);
      if (pid >= 2000) process.stdout.write(`${id} gone 87\n`);
      else if (pid >= 1000) process.stdout.write(`${id} other ${from - 60_000}\n`);
      else {
        jobs.add(id);
        process.stdout.write(`${id} ok ${from}\n`);
        if (mode === 'quit-after-assign') process.exit(0);
      }
    } else if (verb === 'end') {
      if (mode === 'slow-end') return;
      const known = jobs.delete(args[0]);
      process.stdout.write(`${id} ok ${known ? 2 : 0}\n`);
    } else {
      process.stdout.write(`${id} error usage\n`);
    }
  });
}
