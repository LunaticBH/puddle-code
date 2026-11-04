#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { puddlangStartSchema, PUDDLANG_MAX_SOURCE } from '@puddle/shared';
import { disableCurrentDirectorySearch } from '@puddle/shared/node/platform';
import { connectPuddlang } from './puddlang/client.js';
import { serveMcp } from './puddlang/mcp.js';

// Windows: ssh never resolves in the directory pudl was started from, which
// may be a repository. A no-op on POSIX.
disableCurrentDirectorySearch();

const help = `pudl — Puddle's Ultimate Domain Language (puddlang)

  pudl run script.ts [--input JSON] [--detach]
  pudl context
  pudl status <run-id>
  pudl logs <run-id> [--after sequence]
  pudl cancel <run-id>
  pudl mcp

Connection: --host user@host --profile name-or-id
Run options: --id UUID --account agent=label-or-id (repeatable)
             --max-turns 50 --max-agents 8 --timeout-ms 3600000

Requires a running daemon (protocol 24.0+) and a supported agent on that host.
Claude Code, Codex, OpenCode and Gemini CLI support interactive and headless modes.
Profiles/accounts/projects are selected on the execution host. Programs are
trusted host code. Closing the CLI detaches; use cancel to stop a run.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      host: { type: 'string' },
      profile: { type: 'string' },
      input: { type: 'string' },
      detach: { type: 'boolean' },
      id: { type: 'string' },
      account: { type: 'string', multiple: true },
      after: { type: 'string' },
      'max-turns': { type: 'string' },
      'max-agents': { type: 'string' },
      'timeout-ms': { type: 'string' },
    },
  });
  if (values.help || !positionals.length) {
    process.stdout.write(help);
    return;
  }
  const [command, argument] = positionals;
  if (!['run', 'context', 'status', 'logs', 'cancel', 'mcp'].includes(command!))
    throw new Error(help);
  const needsArgument = ['run', 'status', 'logs', 'cancel'].includes(command!);
  if (positionals.length !== (needsArgument ? 2 : 1)) throw new Error(help);
  let submission;
  if (command === 'run') {
    if ((await stat(argument!)).size > PUDDLANG_MAX_SOURCE)
      throw new Error('Program exceeds 256 KiB');
    const accounts: Record<string, string | number> = {};
    for (const entry of values.account ?? []) {
      const match = /^([^=]+)=(.+)$/.exec(entry);
      if (!match) throw new Error('--account requires agent=label-or-id');
      accounts[match[1]!] = /^\d+$/.test(match[2]!) ? Number(match[2]) : match[2]!;
    }
    submission = puddlangStartSchema.parse({
      id: values.id ?? randomUUID(),
      source: await readFile(argument!, 'utf8'),
      input: values.input === undefined ? undefined : JSON.parse(values.input),
      accounts,
      max_turns: values['max-turns'] === undefined ? undefined : Number(values['max-turns']),
      max_agents: values['max-agents'] === undefined ? undefined : Number(values['max-agents']),
      timeout_ms: values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']),
    });
  }
  const connection = await connectPuddlang(
    values.host,
    values.profile ?? (values.host ? undefined : process.env['PUDDLE_PROFILE_ID']),
  );
  const { client } = connection;
  const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  const interrupt = () => {
    void connection.close().finally(() => process.exit(130));
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    if (command === 'mcp') {
      await serveMcp(client, process.stdin, process.stdout);
      return;
    }
    if (command === 'context') {
      print(await client.context());
      return;
    }
    if (command === 'status') {
      print(await client.status(argument!));
      return;
    }
    if (command === 'cancel') {
      print(await client.cancel(argument!));
      return;
    }
    if (command === 'logs') {
      let after = Number(values.after ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new Error('--after must be a non-negative integer');
      for (;;) {
        const { events } = await client.events(argument!, after);
        for (const event of events) process.stdout.write(JSON.stringify(event) + '\n');
        if (!events.length) break;
        after = events.at(-1)!.sequence;
      }
      return;
    }
    if (!submission) return;
    // Print before POST: even an uncertain response can be looked up by id.
    process.stderr.write(`Run ${submission.id} (profile ${client.profile})\n`);
    let run = await client.start(submission);
    if (values.detach) {
      print(run);
      return;
    }
    while (run.status === 'running') {
      await delay(500);
      run = await client.status(run.id);
    }
    print(run);
    if (run.status !== 'completed') process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await connection.close();
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(`pudl: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
