import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listWindowsProcesses, type WindowsProcess } from '@puddle/shared/node/platform';
import { conptyTeardownDeps } from '../../src/pty/conpty-teardown.js';
import { fakeAdapter, fixture, waitFor } from '../helpers/daemon-fixtures.js';
import {
  marked,
  orphanServerCommands,
  orphanServers,
  orphansOf,
  stopMarked,
  survivors,
  waitUntil,
  writeTreeAgent,
  type TreeAgent,
} from '../helpers/process-trees.js';

/**
 * Session teardown on Windows (docs/windows.md, decision 8): by the time a
 * kill or an archive answers, nothing the session's agent or shell started
 * is still running, whichever of its parents have exited, as a hang-up
 * guarantees on POSIX; and it answers within its bound however slow the
 * process table is.
 */
describe.skipIf(process.platform !== 'win32')('Windows session teardown', () => {
  const markers: string[] = [];
  afterEach(async () => {
    for (const marker of markers.splice(0)) await stopMarked(marker);
  });

  /** A fixture whose agent is the tree agent with its orphans (test/helpers/process-trees.ts). */
  async function treeFixture() {
    const tree = writeTreeAgent({ orphans: true });
    markers.push(tree.marker);
    const f = fixture({
      adapter: {
        ...fakeAdapter(),
        binary: process.execPath,
        launchArgs: () => tree.args,
        resumeArgs: () => tree.args,
      },
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
    it(`${how} answers only once the agent’s whole tree is stopped, orphans included`, async () => {
      const { f, tree } = await treeFixture();
      const session = await f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
      });
      await waitFor(() => f.service.get(session.id).status === 'waiting_input', 30_000);
      const members = await runningTree(tree);
      expect(await orphansOf(members)).toHaveLength(2);
      await (how === 'kill' ? f.service.kill(session.id) : f.service.archive(session.id));
      expect(await survivors(members)).toEqual([]);
      expect(f.service.get(session.id).status).toBe(how === 'kill' ? 'exited' : 'archived');
    });
  }

  /** A terminal session whose PowerShell is ready (its hook has run). */
  async function terminal() {
    const f = fixture();
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
    it(`a terminal session’s ${how} stops the servers it started through intermediates that exited`, async () => {
      const { f, session } = await terminal();
      const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
      markers.push(dir);
      for (const line of orphanServerCommands(dir)) f.ptys.write(session.id, 'agent', line);
      const servers = await orphanServers(dir);
      await (how === 'kill' ? f.service.kill(session.id) : f.service.archive(session.id));
      expect(await survivors(servers)).toEqual([]);
    });
  }

  it('a kill still answers, and leaves nothing, when every process-table query takes 2.5 s', async () => {
    const { f, session } = await terminal();
    const dir = mkdtempSync(join(tmpdir(), 'puddle-tree-'));
    markers.push(dir);
    for (const line of orphanServerCommands(dir)) f.ptys.write(session.id, 'agent', line);
    const servers = await orphanServers(dir);
    const table = conptyTeardownDeps.processes;
    conptyTeardownDeps.processes = async (options) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return table(options);
    };
    try {
      const started = Date.now();
      // It escalates at 4 s and fails with kill_failed at 6 s.
      await f.service.kill(session.id);
      expect(Date.now() - started).toBeLessThan(6000);
      expect(await survivors(servers)).toEqual([]);
      await f.ptys.settled(30_000);
    } finally {
      conptyTeardownDeps.processes = table;
    }
  });
});
