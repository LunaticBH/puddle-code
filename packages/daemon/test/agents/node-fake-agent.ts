import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../../src/agents/adapter.js';
import { fakeAdapter } from '../helpers/daemon-fixtures.js';

/**
 * The fixture's fake agent with its bash scripts replaced by one Node script,
 * so agent tests run wherever Node does, Windows included, with no shell. It
 * prints the same LAUNCH/RESUME/PROMPT/READY lines. Input is read raw: Ctrl-D
 * ends the agent (a Windows console has no EOF key of that kind), and in
 * `share` mode every complete input line is appended to the conversation's
 * JSONL, reopened per line as the bash version's `>>` did.
 */
const SOURCE = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [mode, ...args] = process.argv.slice(2);
const say = (line) => process.stdout.write(line + '\\r\\n');
let transcript = null;
if (mode === 'login') {
  say('LOGIN-OK');
  process.exit(0);
} else if (mode === 'launch') {
  say('LAUNCH skip=' + args[0]);
  say('PROMPT<<' + (args[1] ?? '') + '>>');
} else if (mode === 'resume') {
  say('RESUME ref=' + args[0] + ' skip=' + args[1]);
  say('PROMPT<<' + (args[2] ?? '') + '>>');
  say('ENVPROBE<<' + (process.env.CAPTURED_PROBE ?? '') + '>>');
  say('CFG<<' + (process.env.FAKE_CONFIG_DIR ?? '') + '>>');
} else if (mode === 'share-launch' || mode === 'share-resume') {
  const launch = mode === 'share-launch';
  const [skip, key, ref] = launch ? args : [args[1], args[2], args[0]];
  const dir = join(process.env.FAKE_CONFIG_DIR, 'projects', key);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(process.env.FAKE_CONFIG_DIR, 'todos'), { recursive: true });
  transcript = join(dir, ref + '.jsonl');
  if (launch) {
    writeFileSync(transcript, JSON.stringify({ cwd: process.cwd() }) + '\\n');
    writeFileSync(join(process.env.FAKE_CONFIG_DIR, 'todos', ref + '.json'), '[]');
    say('LAUNCH skip=' + skip);
  } else say('RESUME ref=' + ref + ' skip=' + skip);
}
say('READY');
process.stdin.setRawMode?.(true);
let pending = '';
process.stdin.on('data', (data) => {
  const text = data.toString('utf8');
  const end = text.indexOf('\\x04');
  const typed = end === -1 ? text : text.slice(0, end);
  process.stdout.write(typed);
  if (transcript !== null) {
    pending += typed;
    const lines = pending.split(/\\r\\n|\\r|\\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) appendFileSync(transcript, line + '\\n');
  }
  if (end !== -1) process.exit(0);
});
`;

let script: string | null = null;

function agentScript(): string {
  if (script === null) {
    script = join(mkdtempSync(join(tmpdir(), 'puddle-fake-agent-')), 'agent.mjs');
    writeFileSync(script, SOURCE);
  }
  return script;
}

/** Mirrors the fixture's store-key hash, so a worktree maps to one stable key. */
function storeKey(worktreePath: string): string {
  let h = 5381;
  for (let i = 0; i < worktreePath.length; i++) h = ((h << 5) + h + worktreePath.charCodeAt(i)) | 0;
  return `fake-${(h >>> 0).toString(16)}`;
}

export function nodeFakeAdapter(opts: Parameters<typeof fakeAdapter>[0] = {}): AgentAdapter {
  const base = fakeAdapter(opts);
  const file = agentScript();
  return {
    ...base,
    binary: opts.binary ?? process.execPath,
    loginArgs: () => [file, 'login'],
    launchArgs: (o) =>
      opts.share
        ? [
            file,
            'share-launch',
            String(o.skipPermissions),
            storeKey(o.worktreePath),
            `fake-ref-${o.sessionId}`,
          ]
        : [file, 'launch', String(o.skipPermissions), o.prompt ?? ''],
    resumeArgs: (ref, o) =>
      opts.share
        ? [file, 'share-resume', ref, String(o.skipPermissions), storeKey(o.worktreePath)]
        : [file, 'resume', ref, String(o.skipPermissions), o.prompt ?? ''],
  };
}
