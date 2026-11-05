import { afterEach, describe, expect, it } from 'vitest';
import { listWindowsProcesses, type WindowsProcess } from '@puddle/shared/node/platform';
import { fakeAdapter, fixture, waitFor } from '../helpers/daemon-fixtures.js';
import {
  marked,
  stopMarked,
  survivors,
  TREE_SIZE,
  waitUntil,
  writeTreeAgent,
  type TreeAgent,
} from '../helpers/process-trees.js';

/**
 * Session teardown on Windows (docs/windows.md, decision 8): by the time a
 * kill or an archive answers, nothing the session's agent or shell started
 * is still running, as a hang-up guarantees on POSIX.
 */
describe.skipIf(process.platform !== 'win32')('Windows session teardown', () => {
  const trees: TreeAgent[] = [];
  afterEach(async () => {
    for (const tree of trees.splice(0)) await stopMarked(tree.marker);
  });

  /** A fixture whose agent is the tree agent (test/helpers/process-trees.ts). */
  function treeFixture() {
    const tree = writeTreeAgent();
    trees.push(tree);
    const f = fixture({
      adapter: {
        ...fakeAdapter(),
        binary: process.execPath,
        launchArgs: () => [tree.script, tree.marker],
        resumeArgs: () => [tree.script, tree.marker],
      },
    });
    return { f, tree };
  }

  async function runningTree(tree: TreeAgent): Promise<WindowsProcess[]> {
    let members: WindowsProcess[] = [];
    await waitUntil(
      async () => (members = await marked(tree.marker)).length === TREE_SIZE,
      30_000,
      'the agent’s tree',
    );
    return members;
  }

  for (const how of ['kill', 'archive'] as const) {
    it(`${how} answers only once the agent’s whole tree is stopped`, async () => {
      const { f, tree } = treeFixture();
      const session = await f.service.create({
        project_id: f.ids.project,
        account_id: f.ids.account,
      });
      await waitFor(() => f.service.get(session.id).status === 'waiting_input', 30_000);
      const members = await runningTree(tree);
      await (how === 'kill' ? f.service.kill(session.id) : f.service.archive(session.id));
      expect(await survivors(members)).toEqual([]);
      expect(f.service.get(session.id).status).toBe(how === 'kill' ? 'exited' : 'archived');
    });
  }

  it('a terminal session’s kill stops what runs in its PowerShell', async () => {
    const f = fixture();
    const session = await f.service.create({ project_id: f.ids.project, kind: 'terminal' });
    await waitFor(() => f.service.get(session.id).status === 'running', 30_000);
    const shell = f.ptys.pidFor(session.id, 'agent')!;
    // Ready once the hook has run (it reports the directory); then ping in the foreground.
    await new Promise((resolve) => setTimeout(resolve, 1500));
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
});
