import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listWindowsProcesses, type WindowsProcess } from '@puddle/shared/node/platform';
import type { ConptyJobs } from '../../src/pty/conpty-jobs.js';
import { fakeAdapter, fixture, waitFor } from '../helpers/daemon-fixtures.js';
import {
  ATTACHED_SERVER,
  marked,
  orphanServerCommands,
  orphanServers,
  orphansOf,
  role,
  stillRunning,
  stopMarked,
  survivors,
  waitUntil,
  withRoles,
  writeTreeAgent,
  type TreeAgent,
} from '../helpers/process-trees.js';
import { refusedHelper, silentHelper, slowHelper } from '../helpers/slow-conpty-helper.js';

/**
 * Session teardown on Windows (docs/windows.md, decision 8): by the time a
 * kill or an archive answers, what the session's agent or shell left
 * attached to its console has ended, whichever of its parents have exited,
 * as a hang-up guarantees on POSIX; what left the console (a GUI programme,
 * a detached process, one in a console of its own) runs on. It answers
 * within its bounds however slow the ConPTY helper is, or without one.
 */
describe.skipIf(process.platform !== 'win32')('Windows session teardown', () => {
  const markers: string[] = [];
  afterEach(async () => {
    for (const marker of markers.splice(0)) await stopMarked(marker);
  });

  /** A fixture whose agent is the tree agent with its orphans (test/helpers/process-trees.ts). */
  async function treeFixture(conptyJobs?: ConptyJobs | null) {
    const tree = await writeTreeAgent({ orphans: true });
    markers.push(tree.marker);
    const f = fixture({
      adapter: {
        ...fakeAdapter(),
        binary: process.execPath,
        launchArgs: () => tree.args,
        resumeArgs: () => tree.args,
      },
      conptyJobs,
    });
    // As the daemon does before it serves.
    await f.ptys.prepare();
    return { f, tree };
  }

  async function runningTree(tree: TreeAgent): Promise<WindowsProcess[]> {
    let members: WindowsProcess[] = [];
    await waitUntil(
      async () => (members = await marked(tree.marker)).length === tree.size,
      30_000,
      'the agent’s tree',
    );
    return members;
  }

  for (const how of ['kill', 'archive'] as const) {
    it(`${how} answers once what is attached to the agent’s console has ended, and only that`, async () => {
      const { f, tree } = await treeFixture();
      const session = await f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
      });
      await waitFor(() => f.service.get(session.id).status === 'waiting_input', 30_000);
      const members = await runningTree(tree);
      expect(await orphansOf(withRoles(members, tree.attached))).toHaveLength(1);
      await (how === 'kill' ? f.service.kill(session.id) : f.service.archive(session.id));
      const outlived = await stillRunning(withRoles(members, tree.left));
      expect(await survivors(withRoles(members, tree.attached))).toEqual([]);
      expect(outlived.map(role).sort()).toEqual([...tree.left].sort());
      expect(f.service.get(session.id).status).toBe(how === 'kill' ? 'exited' : 'archived');
    });
  }

  /** A terminal session whose PowerShell is ready (its hook has run). */
  async function terminal(conptyJobs?: ConptyJobs | null) {
    const f = fixture({ conptyJobs });
    await f.ptys.prepare();
    const session = await f.service.create({ project_id: f.ids.project, kind: 'terminal' });
    await waitFor(() => f.service.get(session.id).status === 'running', 30_000);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return { f, session, shell: f.ptys.pidFor(session.id, 'agent')! };
  }

  it('a terminal session’s kill stops what runs in its PowerShell', async () => {
    const { f, session, shell } = await terminal();
    f.ptys.write(session.id, 'agent', 'ping -t 127.0.0.1\r');
    let ping: WindowsProcess[] = [];
    await waitUntil(
      async () =>
        (ping = (await listWindowsProcesses({ fresh: true })).filter(
          (entry) => entry.ppid === shell && entry.name.toLowerCase() === 'ping.exe',
        )).length === 1,
      30_000,
      'ping',
    );
    await f.service.kill(session.id);
    expect(await survivors(ping)).toEqual([]);
  });

  for (const how of ['kill', 'archive'] as const) {
    it(`a terminal session’s ${how} ends the server left on its console, not those that left it`, async () => {
      const { f, session } = await terminal();
      const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
      markers.push(dir);
      for (const line of orphanServerCommands(dir)) f.ptys.write(session.id, 'agent', line);
      const servers = await orphanServers(dir);
      await (how === 'kill' ? f.service.kill(session.id) : f.service.archive(session.id));
      const [attached, left] = [
        servers.filter((p) => role(p) === ATTACHED_SERVER),
        servers.filter((p) => role(p) !== ATTACHED_SERVER),
      ];
      expect(await survivors(attached)).toEqual([]);
      expect(await stillRunning(left)).toHaveLength(2);
    });
  }

  for (const [name, jobs] of [
    ['answers 2.5 s late', () => slowHelper(2500)],
    ['cannot start, as under Constrained Language Mode', refusedHelper],
    ['never answers', silentHelper],
  ] as const) {
    it(`a kill answers within its limits when the ConPTY helper ${name}`, async () => {
      const { f, session } = await terminal(jobs());
      const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
      markers.push(dir);
      for (const line of orphanServerCommands(dir)) f.ptys.write(session.id, 'agent', line);
      const servers = await orphanServers(dir);
      const started = Date.now();
      // It escalates at 4 s and fails with kill_failed at 6 s.
      await f.service.kill(session.id);
      expect(Date.now() - started).toBeLessThan(6000);
      await f.ptys.settled(30_000);
      // The console's close ended the server on it.
      expect(
        await survivors(
          servers.filter((p) => role(p) === ATTACHED_SERVER),
          6000,
        ),
      ).toEqual([]);
      expect(await stillRunning(servers.filter((p) => role(p) !== ATTACHED_SERVER))).toHaveLength(
        2,
      );
    });
  }
});
